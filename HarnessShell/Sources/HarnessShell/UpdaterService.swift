import AppKit
import Foundation

/// 自动更新检查服务（M1：仅「检出 + 提示」，不做下载/替换/提权）。
///
/// 形态借鉴 refs/dsh-desktop 的 electron-updater update-manager / update-policy：
///   - 状态机 idle / checking / available / up-to-date / error（+ disabled）
///   - 启动延时 15s + jitter、周期 6h、电源恢复补查（距上次检查已超间隔才补）
///   - packaged-only：开发模式（swift run）直接禁用，不打扰
///
/// 协议 = Sparkle 兼容 appcast.xml：
///   - 用 sparkle:version（= CFBundleVersion 的 build 号，整数）做判定主键，
///     不碰 semver 字符串比较（避免「预发 vs 稳定」歧义，见 docs/auto-update-proposal.md §6）
///   - 检出 available 后仅回抛 UpdateInfo，由 UI 层提示并打开 release 下载页
///
/// M1 固定指向 GitHub Releases latest 的 appcast（Flash-1 的生成器落地后此地址即有效）；
/// 生成器落地前用 `WHALEPOD_APPCAST_URL` 环境变量覆盖到本地 fixture 通道联调。
final class UpdaterService {

    // MARK: - 公开类型

    enum State: Equatable {
        /// 尚未开始 / 尚未计划
        case idle
        /// 正在检查
        case checking
        /// 检出有新版
        case available(UpdateInfo)
        /// 已是最新
        case upToDate
        /// 检查失败（离线 / 解析失败）—— UI 层静默，不吓用户
        case error
        /// 已禁用（配置 autoUpdate=false，或开发模式）
        case disabled
    }

    struct UpdateInfo: Equatable {
        /// shortVersionString，展示用（如 0.1.0-alpha.5）
        let version: String
        /// sparkle:version = build 号，判定主键
        let build: Int
        /// enclosure url（下载地址，M2 用）
        let downloadURL: URL?
        /// M1 按钮跳转的 release 下载页
        let releaseURL: URL
    }

    // MARK: - 策略常量（照 update-policy）

    /// 启动后延时检查（秒）。
    private static let initialDelaySeconds: TimeInterval = 15
    /// jitter 上界（秒）。
    private static let jitterSeconds: TimeInterval = 15
    /// 周期检查间隔。
    private static let checkIntervalSeconds: TimeInterval = 6 * 60 * 60
    /// 电源恢复后，距上次检查超过该间隔才补查。
    private static let powerResumeWindowSeconds: TimeInterval = checkIntervalSeconds

    // MARK: - 通道

    /// 生产 appcast（M1 固定 latest/download；Flash-1 生成器落地后即有效）。
    static let defaultAppcastURL = URL(
        string: "https://github.com/whyihaveyou/whalepod/releases/latest/download/appcast.xml"
    )!

    /// release 下载页（M1 按钮跳这里）。
    static let releasePageURL = URL(string: "https://github.com/whyihaveyou/whalepod/releases")!

    // MARK: - 状态

    private(set) var state: State = .idle {
        didSet { if oldValue != state { onStateChange?(state); logState(state) } }
    }
    var onStateChange: ((State) -> Void)?

    // MARK: - 私有

    private let appcastURL: URL
    private let autoUpdateEnabled: Bool
    private var checkTimer: Timer?
    private var powerWakeObserver: NSObjectProtocol?
    private var lastCheckedAt: Date?

    // M1 环境覆盖钩子：`WHALEPOD_FORCE_UPDATE=1` 允许开发模式跑检查（fixture 三态演示用，生产无感）。
    private static var forceUpdateInDev: Bool {
        ProcessInfo.processInfo.environment["WHALEPOD_FORCE_UPDATE"] == "1"
    }

    /// - Parameters:
    ///   - appcastURL: appcast 通道地址（默认生产；联调用环境变量覆盖）。
    ///   - autoUpdateEnabled: config 的 autoUpdate 开关。
    init(appcastURL: URL = UpdaterService.defaultAppcastURL, autoUpdateEnabled: Bool = true) {
        // 允许 WHALEPOD_APPCAST_URL 覆盖通道（fixture 联调 / 测试）。
        if let override = ProcessInfo.processInfo.environment["WHALEPOD_APPCAST_URL"],
           let url = URL(string: override), !override.isEmpty {
            self.appcastURL = url
        } else {
            self.appcastURL = appcastURL
        }
        self.autoUpdateEnabled = autoUpdateEnabled
    }

    // MARK: - 生命周期

    /// 启动自动更新：延迟 + 抖动后首次检查，随后周期检查 + 电源恢复补查。
    func start() {
        // packaged-only：开发模式（swift run 无 bundle id）直接禁用
        let packaged = Bundle.main.bundleIdentifier != nil
        guard autoUpdateEnabled else {
            state = .disabled
            return
        }
        guard packaged || Self.forceUpdateInDev else {
            state = .disabled   // 开发模式：跳过，不打扰
            return
        }

        observeSystemPowerResume()

        // 初始延时：默认 15s + jitter；`WHALEPOD_UPDATE_DELAY_MS` 覆盖（fixture 三态演示提速用）。
        var delay = Self.initialDelaySeconds + Double.random(in: 0...Self.jitterSeconds)
        if let ms = ProcessInfo.processInfo.environment["WHALEPOD_UPDATE_DELAY_MS"].flatMap({ Double($0) }) {
            delay = ms / 1000.0
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            guard self.state != .disabled else { return }
            self.checkForUpdate()

            // 周期检查
            let timer = Timer(timeInterval: Self.checkIntervalSeconds, repeats: true) { [weak self] _ in
                self?.checkForUpdate()
            }
            RunLoop.main.add(timer, forMode: .common)
            self.checkTimer = timer
        }
    }

    /// 停止调度（应用退出 / 禁用时）。
    func stop() {
        checkTimer?.invalidate()
        checkTimer = nil
        if let powerWakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(powerWakeObserver)
        }
        powerWakeObserver = nil
    }

    /// 立即手动检查（返回后经 onStateChange 回抛结果）。
    func checkForUpdate() {
        guard state != .disabled else { return }
        state = .checking

        let currentBuild = currentBuildNumber()
        let appcastURL = self.appcastURL

        let task = URLSession.shared.dataTask(with: appcastURL) { [weak self] data, response, error in
            guard let self else { return }
            // 无论成败都刷新「上次检查时间」，供电源恢复判定
            let now = Date()
            DispatchQueue.main.async {
                self.lastCheckedAt = now
            }

            guard error == nil, let data, let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                self.setStateSafe(.error)      // 离线/拉取失败：静默，不吓用户
                return
            }
            guard let items = Self.parseAppcast(data), let latest = Self.latestItem(items) else {
                self.setStateSafe(.error)      // 解析失败
                return
            }
            if latest.build > currentBuild {
                self.setStateSafe(.available(latest.asUpdateInfo()))
            } else {
                self.setStateSafe(.upToDate)
            }
        }
        task.resume()
    }

    // MARK: - 电源恢复补查

    private func observeSystemPowerResume() {
        powerWakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, self.state != .disabled else { return }
            // 距上次检查已超间隔才补查（照 update-policy）
            if let last = self.lastCheckedAt,
               Date().timeIntervalSince(last) < Self.powerResumeWindowSeconds {
                return
            }
            self.checkForUpdate()
        }
    }

    // MARK: - 本地 build 号

    /// 当前 .app 的 CFBundleVersion（build 号）。解析失败回落到 1（版本灌入上线前本地恒 1，属预期）。
    private func currentBuildNumber() -> Int {
        let str = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return Int(str) ?? 1
    }

    // MARK: - 线程安全的状态回抛

    private func setStateSafe(_ newState: State) {
        DispatchQueue.main.async { [weak self] in
            self?.state = newState
        }
    }

    /// verbose 状态日志（`WHALEPOD_VERBOSE=1`；fixture 三态演示 / 联调排查用）。
    private func logState(_ s: State) {
        guard ProcessInfo.processInfo.environment["WHALEPOD_VERBOSE"] == "1" else { return }
        let desc: String
        switch s {
        case .idle: desc = "idle"
        case .checking: desc = "checking"
        case .available(let info): desc = "available(version=\(info.version), build=\(info.build))"
        case .upToDate: desc = "up-to-date"
        case .error: desc = "error"
        case .disabled: desc = "disabled"
        }
        FileHandle.standardError.write(Data("[whalepod-updater] state=\(desc)\n".utf8))
    }
}

// MARK: - appcast 解析（最小实现，够 M1 用）

extension UpdaterService {
    struct ParsedItem {
        let build: Int
        let shortVersion: String
        let enclosureURL: URL?

        func asUpdateInfo() -> UpdateInfo {
            UpdateInfo(
                version: shortVersion,
                build: build,
                downloadURL: enclosureURL,
                releaseURL: UpdaterService.releasePageURL
            )
        }
    }

    /// 解析 appcast.xml：抽所有 <item>，各取 sparkle:version / shortVersionString / enclosure url。
    /// 宽松容错：单条坏不影响整份；一条都没有 → nil。
    static func parseAppcast(_ xml: Data) -> [ParsedItem]? {
        guard let text = String(data: xml, encoding: .utf8) else { return nil }
        return parseAppcastString(text)
    }

    static func parseAppcastString(_ text: String) -> [ParsedItem]? {
        var items: [ParsedItem] = []

        let itemRegex = try? NSRegularExpression(pattern: "<item>([\\s\\S]*?)<\\/item>")
        let buildRegex = try? NSRegularExpression(pattern: "<sparkle:version>([0-9]+)<\\/sparkle:version>")
        let shortRegex = try? NSRegularExpression(
            pattern: "<sparkle:shortVersionString>([^<]+)<\\/sparkle:shortVersionString>"
        )
        let urlRegex = try? NSRegularExpression(pattern: "<enclosure[^>]*url=\"([^\"]+)\"")

        let matches = itemRegex?.matches(in: text, range: NSRange(text.startIndex..., in: text)) ?? []
        guard !matches.isEmpty else { return nil }

        for m in matches where m.numberOfRanges >= 2 {
            guard let bodyRange = Range(m.range(at: 1), in: text) else { continue }
            let body = String(text[bodyRange])

            guard let bStr = firstCapture(buildRegex, in: body).flatMap({ Int($0) }) else { continue }
            let short = firstCapture(shortRegex, in: body) ?? ""
            let enclosure = firstCapture(urlRegex, in: body).flatMap { URL(string: $0) }
            items.append(ParsedItem(build: bStr, shortVersion: short, enclosureURL: enclosure))
        }
        return items.isEmpty ? nil : items
    }

    /// 按 build 号（整数）取最大者；无 build 的都跳过（判定主键必须是 build）。
    static func latestItem(_ items: [ParsedItem]) -> ParsedItem? {
        items.max(by: { $0.build < $1.build })
    }

    private static func firstCapture(_ regex: NSRegularExpression?, in str: String) -> String? {
        guard let regex else { return nil }
        let range = NSRange(str.startIndex..., in: str)
        guard let m = regex.firstMatch(in: str, range: range), m.numberOfRanges >= 2,
              let r = Range(m.range(at: 1), in: str) else { return nil }
        return String(str[r])
    }
}
