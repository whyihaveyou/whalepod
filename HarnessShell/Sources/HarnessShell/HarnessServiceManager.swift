import Foundation
import Darwin

/// harness 服务进程管理器：负责启动/停止本地服务，并持续探测端口以反映真实状态。
///
/// 关键设计：
/// - 用 `posix_spawn` + `POSIX_SPAWN_SETPGROUP` 把服务进程放进独立进程组，
///   停止时对整个进程组发信号，确保 `npm exec`/`pnpm` 派生的 node 子进程一并退出，
///   避免端口被孤儿进程占用。
/// - 周期性探测端口（TCP connect）：即使服务是外部手动启动的，也能识别为"运行中"，
///   避免重复拉起；WebView 在"运行中"状态下加载页面。
final class HarnessServiceManager {

    enum State: Equatable {
        case stopped          // 未运行
        case starting         // 已拉起进程，端口还没就绪
        case running          // 端口可达（无论本管理器启动还是外部启动）
        case restarting(attempt: Int, delay: TimeInterval)  // 意外退出后等待退避重启
        case failed(String)   // 进程退出或启动失败
    }

    private let config: ServiceConfig
    private var spawnedPid: pid_t?
    private var pollTimer: Timer?
    private var readSource: DispatchSourceRead?
    private var outputBuffer = ""

    // MARK: 端口解析（随机端口支持）
    /// 实际生效端口：自动端口模式 = 从子进程 stdout 解析；固定端口模式 = config.port。
    private(set) var resolvedPort: Int?

    // MARK: 崩溃重启退避策略
    private let restartBaseDelay: TimeInterval = 1.0   // 1s → 2s → 4s → 8s → 16s → 30s
    private let restartMaxDelay: TimeInterval = 30.0
    private let maxConsecutiveCrashes = 5              // 连续快速崩溃上限，超过则放弃

    private var restartAttempt = 0                     // 连续意外退出次数
    private var restartWorkItem: DispatchWorkItem?     // 待执行的退避重启
    private var userRequestedStop = false              // 用户主动停止时不触发重启

    private(set) var state: State = .stopped {
        didSet {
            guard oldValue != state else { return }
            let newState = state
            DispatchQueue.main.async { [weak self] in
                self?.onStateChange?(newState)
            }
        }
    }

    var onStateChange: ((State) -> Void)?
    var onOutput: ((String) -> Void)?

    /// 测试用：当前已拉起的子进程 pid。
    var spawnedPidValue: pid_t? { spawnedPid }

    init(config: ServiceConfig) {
        self.config = config
    }

    // MARK: - 对外接口

    /// 启动服务：若端口已可达（外部已启动）则直接标记运行中；否则拉起配置的命令。
    /// 用户主动启动会重置退避计数与"用户已停止"标记。
    func start() {
        userRequestedStop = false
        restartAttempt = 0
        cancelRestart()
        performStart()
    }

    private func performStart() {
        // 自动端口模式：端口未解析则先探测（外部已启动可直接发现）；固定端口同理。
        if config.isAutoPort {
            // 自动端口下不能靠固定端口探测判断"外部已运行"（端口未知），
            // 因此自动模式总是拉起自己的进程，再从 stdout 解析端口。
            startNewProcess()
        } else {
            guard !isReachable() else {
                resolvedPort = config.port
                state = .running
                return
            }
            startNewProcess()
        }
    }

    private func startNewProcess() {
        guard spawnedPid == nil else { return } // 已在启动流程中

        state = .starting

        // OOBE-M0：由 RuntimeBootstrap 解析启动方案——
        //   bundled / nodeProbe → 直接 exec node（[nodePath, bin.js, web, ...args]）
        //   custom / npxFallback → 走 zsh -lc shell（向后兼容现有命令路径）
        let portArg = config.isAutoPort ? "--port 0" : "--port \(config.port)"
        let plan = RuntimeBootstrap.resolve(config: config, portArg: portArg)
        switch plan {
        case .direct(let executable, let arguments):
            emitOutput("▶ 启动 node: \(executable) \(arguments.joined(separator: " "))")
        case .shell(let command):
            emitOutput("▶ 启动命令: \(command)")
        case .unavailable(let reason):
            emitOutput(reason)
            state = .failed(reason)
            return
        }
        if let cwd = config.workingDirectory, !cwd.isEmpty {
            emitOutput("  工作目录: \(cwd)")
        }

        // 每次(重新)启动都清掉旧端口解析与stdout缓冲，重新等待子进程上报。
        // 关键：outputBuffer 必须一并清空，否则新进程首条输出会与上一进程残留缓冲混合，
        // parsePort(from: outputBuffer) 会从残留缓冲误解析出旧端口（Bug#1，实测卡 starting）。
        resolvedPort = config.isAutoPort ? nil : config.port
        outputBuffer = ""

        do {
            let pid: pid_t
            switch plan {
            case .direct(let executable, let arguments):
                pid = try spawnInOwnGroup(
                    requestedExecutable: executable,
                    arguments: arguments,
                    workingDirectory: config.workingDirectory,
                    environment: mergedEnvironment()
                )
            case .shell(let command):
                // spawnInOwnGroup 会自动把 executablePath 补为 argv[0]，勿再自带程序名。
                pid = try spawnInOwnGroup(
                    arguments: ["-lc", command],
                    workingDirectory: config.workingDirectory,
                    environment: mergedEnvironment()
                )
            case .unavailable:
                return
            }
            spawnedPid = pid
            startPolling()
        } catch {
            state = .failed("启动失败: \(error.localizedDescription)")
        }
    }

    /// 停止服务：向进程组发 SIGTERM，宽限期后 SIGKILL；端口由外部占用时不处理（不归我们管）。
    /// 用户主动停止不会触发自动重启。
    func stop() {
        userRequestedStop = true
        cancelRestart()
        guard let pid = spawnedPid else {
            stopPolling()
            state = .stopped
            return
        }
        emitOutput("⏹ 停止服务 (pid \(pid))")
        killpg(pid, SIGTERM)
        // 宽限期后强制杀
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, let pid = self.spawnedPid else { return }
            killpg(pid, SIGKILL)
        }
    }

    /// 应用退出前调用。
    func shutdown() {
        userRequestedStop = true
        cancelRestart()
        stop()
    }

    // MARK: - 崩溃检测与退避重启

    /// 子进程意外退出时调用：按 1s→2s→4s…（封顶 30s）指数退避调度重启。
    private func scheduleRestart() {
        restartAttempt += 1
        if restartAttempt > maxConsecutiveCrashes {
            emitOutput("✖ 连续崩溃 \(restartAttempt) 次，放弃自动重启，请手动启动")
            state = .failed("服务连续崩溃 \(restartAttempt) 次，已放弃自动重启，请手动启动")
            return
        }
        let delay = min(restartBaseDelay * pow(2.0, Double(restartAttempt - 1)), restartMaxDelay)
        state = .restarting(attempt: restartAttempt, delay: delay)
        emitOutput("⚠ 服务意外退出，\(Int(delay)) 秒后自动重启（第 \(restartAttempt)/\(maxConsecutiveCrashes) 次）")

        cancelRestart()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, !self.userRequestedStop else { return }
            self.performStart()
        }
        restartWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    private func cancelRestart() {
        restartWorkItem?.cancel()
        restartWorkItem = nil
    }

    deinit {
        restartWorkItem?.cancel()
    }

    // MARK: - 端口探测

    /// 当前应当探测的端口：自动模式用已解析端口（未解析则返回 nil 表示无法探测）；固定模式用 config.port。
    private var effectivePort: Int? {
        config.isAutoPort ? resolvedPort : config.port
    }

    /// 探测当前生效端口是否可达。
    func isReachable() -> Bool {
        guard let port = effectivePort else { return false }
        return Self.isPortOpen(host: config.host, port: port)
    }

    /// 纯 socket 探测，不依赖 URLSession（避免 ATS 干扰）。
    static func isPortOpen(host: String, port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        let h = (host == "localhost") ? "127.0.0.1" : host
        let ip = inet_addr(h)
        addr.sin_addr.s_addr = (ip == UInt32.max) ? inet_addr("127.0.0.1") : ip

        let result = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    // MARK: - 轮询

    private func startPolling() {
        stopPolling()
        let timer = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.poll()
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
        poll()
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func poll() {
        if isReachable() {
            // 服务恢复：清零连续崩溃计数
            restartAttempt = 0
            state = .running
        } else if let pid = spawnedPid, isProcessAlive(pid) {
            state = .starting
        } else {
            // 我们拉起的子进程已退出
            if let pid = spawnedPid {
                reapIfExited(pid)
            }
            spawnedPid = nil
            stopPolling()
            if userRequestedStop {
                state = .stopped
            } else {
                // 意外退出 → 指数退避自动重启
                scheduleRestart()
            }
        }
    }

    // MARK: - posix_spawn（独立进程组 + 输出管道）

    /// 在独立进程组中启动命令，stdout/stderr 重定向到管道异步读取。
    /// - 注意：`arguments` 不含程序名——argv[0] 由本函数自动以 resolved executablePath 补齐。
    /// - `requestedExecutable`：可选，指定可执行文件路径（OOBE-M0 bundled/nodeProbe 直接 exec node，
    ///   不走 zsh 包裹）。默认 nil = 按名查找 zsh（向后兼容现有 shell 路径）。
    private func spawnInOwnGroup(requestedExecutable: String? = nil,
                                 arguments: [String],
                                 workingDirectory: String?,
                                 environment: [String: String]) throws -> pid_t {
        let executablePath: String
        if let req = requestedExecutable {
            if req.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: req) {
                executablePath = req
            } else if let found = findExecutable(req) {
                executablePath = found
            } else {
                executablePath = req   // 绝对路径兜底，交给 posix_spawn 直接尝试
            }
        } else {
            guard let zsh = findExecutable("zsh") else {
                throw NSError(domain: "HarnessService", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "找不到 zsh"])
            }
            executablePath = zsh
        }

        var fileActions: posix_spawn_file_actions_t?
        var attr: posix_spawnattr_t?
        let statusInitFA = posix_spawn_file_actions_init(&fileActions)
        let statusInitAttr = posix_spawnattr_init(&attr)
        guard statusInitFA == 0, statusInitAttr == 0 else {
            throw NSError(domain: "HarnessService", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "posix_spawn 初始化失败"])
        }
        defer {
            posix_spawn_file_actions_destroy(&fileActions)
            posix_spawnattr_destroy(&attr)
        }

        // 输出管道：子进程 stdout/stderr -> 管道写端；父进程读读端
        var fds: [Int32] = [0, 0]
        guard pipe(&fds) == 0 else {
            throw NSError(domain: "HarnessService", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "创建管道失败"])
        }
        let readFD = fds[0]
        let writeFD = fds[1]

        posix_spawn_file_actions_adddup2(&fileActions, writeFD, STDOUT_FILENO)
        posix_spawn_file_actions_adddup2(&fileActions, writeFD, STDERR_FILENO)
        posix_spawn_file_actions_addclose(&fileActions, readFD)
        posix_spawn_file_actions_addclose(&fileActions, writeFD)

        if let cwd = workingDirectory, !cwd.isEmpty {
            posix_spawn_file_actions_addchdir_np(&fileActions, cwd)
        }

        // 独立进程组：子进程 pid 即进程组 id，方便 killpg 整组清理
        var flags: Int16 = 0
        posix_spawnattr_getflags(&attr, &flags)
        flags |= Int16(POSIX_SPAWN_SETPGROUP)
        posix_spawnattr_setflags(&attr, flags)
        posix_spawnattr_setpgroup(&attr, 0)

        // argv / envp
        // argv[0] 必须是可执行文件本身（POSIX 惯例），否则 node 会把 arguments[0]
        // （bin.js）当作程序名跳过，把 "web" 误判为入口脚本 → MODULE_NOT_FOUND（Bug#3）。
        var argv: [UnsafeMutablePointer<CChar>?] = ([executablePath] + arguments).map { strdup($0) }
        argv.append(nil)
        defer { argv.forEach { free($0) } }

        let envStrings = environment.map { "\($0.key)=\($0.value)" }
        var envp: [UnsafeMutablePointer<CChar>?] = envStrings.map { strdup($0) }
        envp.append(nil)
        defer { envp.forEach { free($0) } }

        var pid: pid_t = 0
        let result = posix_spawn(&pid, executablePath, &fileActions, &attr, argv, envp)
        // 父进程关闭写端
        close(writeFD)

        guard result == 0 else {
            close(readFD)
            throw NSError(domain: "HarnessService", code: 4,
                          userInfo: [NSLocalizedDescriptionKey: "posix_spawn 失败 (\(String(cString: strerror(result))))"])
        }

        // 异步读取输出
        startReadingOutput(readFD: readFD, pid: pid)
        return pid
    }

    /// 用 DispatchSourceRead 异步读取管道输出。
    private func startReadingOutput(readFD: Int32, pid: pid_t) {
        let source = DispatchSource.makeReadSource(fileDescriptor: readFD, queue: .global(qos: .userInitiated))
        source.setEventHandler { [weak self] in
            var buffer = [UInt8](repeating: 0, count: 4096)
            let count = read(readFD, &buffer, buffer.count)
            if count > 0 {
                let data = Data(buffer[0..<count])
                if let text = String(data: data, encoding: .utf8) {
                    self?.handleOutput(text)
                }
            } else if count < 0 {
                source.cancel()
            } else {
                source.cancel()
            }
        }
        source.setCancelHandler {
            close(readFD)
        }
        source.resume()
        readSource = source
    }

    private func handleOutput(_ text: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.outputBuffer += text
            // 自动端口：从子进程 stdout 解析实际端口
            if self.config.isAutoPort, self.resolvedPort == nil {
                if let p = Self.parsePort(from: self.outputBuffer) {
                    self.resolvedPort = p
                    self.emitOutput("  已解析实际端口: \(p)")
                    if !self.isReachable() && self.state == .running {
                        // 万一端口稍后才就绪，poll 会再切 running
                    }
                }
            }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                self.onOutput?(trimmed)
            }
        }
    }

    /// 从 dsh 启动输出中解析监听的端口。
    /// 支持形如：
    ///   `dsh web: http://127.0.0.1:58671/`
    ///   `Listening on http://localhost:58671`
    ///   `Server running at http://[::1]:58671`
    static func parsePort(from text: String) -> Int? {
        let patterns = [
            #"http://[^:/]*(?::)?(\d+)"#,        // http://host:port 或 http://host/（无端口则跳过，下面兜底）
            #"port[^\d]{0,20}(\d{2,5})"#,         // "port 12345"
            #":(\d{2,5})"#,                       // 兜底：任何 :端口
        ]
        var candidates: [Int] = []
        // 第一优先：明确的 URL 端口
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern) {
                let ns = text as NSString
                let matches = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
                for m in matches {
                    if m.numberOfRanges >= 2 {
                        let r = m.range(at: 1)
                        if r.location != NSNotFound {
                            let sub = ns.substring(with: r)
                            if let v = Int(sub), v >= 1024, v <= 65535 {
                                candidates.append(v)
                            }
                        }
                    }
                }
            }
        }
        // 自动端口通常 > 1024；取第一个合理值
        return candidates.first
    }

    private func emitOutput(_ text: String) {
        DispatchQueue.main.async { [weak self] in
            self?.onOutput?(text)
        }
    }

    // MARK: - 工具

    /// 合并环境变量：继承当前进程环境 + 配置的环境变量 + 补齐 PATH。
    /// OOBE-M2：注入 DSH_HOME 指向 WhalePod/harness（harness 数据根），config.environment 可覆盖。
    ///
    /// Bug#2（用户真机反馈「服务意外终止/反复重试」根因）：GUI 启动的应用只继承 Finder/Dock
    /// 的极简 PATH，node/npm 常装在 ~/.local/opt/node/bin 等非标准位置（且写在 ~/.zshrc，
    /// 而这里用 `zsh -lc` 登录 shell 不读 zshrc），导致 `npm exec` command not found、
    /// 子进程秒退。必须运行时探测 node/npm 真实目录并置于 PATH 最前。
    private func mergedEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        for (k, v) in config.environment { env[k] = v }
        // DSH_HOME：默认注入新数据根；若用户在配置里显式指定则不覆盖
        if env["DSH_HOME"] == nil, !config.environment.keys.contains("DSH_HOME") {
            env["DSH_HOME"] = DataRoot.harnessHomeURL.path
        }
        // PATH：探测到的 node/npm 目录优先，再继承原 PATH，最后兜底系统目录
        var pathComponents = Self.discoveredNodeDirs()
        if let path = env["PATH"], !path.isEmpty {
            pathComponents.append(path)
        }
        pathComponents.append(contentsOf: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
        var seen = Set<String>()
        env["PATH"] = pathComponents.filter { seen.insert($0).inserted }.joined(separator: ":")
        return env
    }

    /// 探测本机 node/npm 的安装目录（按优先级），返回实际存在 node 或 npm 可执行文件的目录。
    static func discoveredNodeDirs() -> [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.local/opt/node/bin", // 本机实测：用户 node 在此（fnm/手动安装常见）
            "\(home)/.nvm/current/bin",
            "\(home)/.volta/bin",
            "\(home)/.fnm/aliases/default/bin",
            "/opt/homebrew/bin",           // Apple Silicon Homebrew
            "/usr/local/opt/node/bin",
            "/usr/local/bin",              // Intel Homebrew / 其他
        ]
        var found: [String] = []
        for dir in candidates {
            if FileManager.default.isExecutableFile(atPath: dir + "/npm") ||
               FileManager.default.isExecutableFile(atPath: dir + "/node") {
                found.append(dir)
            }
        }
        return found
    }

    private func findExecutable(_ name: String) -> String? {
        let candidates = [
            "/bin/\(name)",
            "/usr/bin/\(name)",
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
        ]
        if let hit = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return hit
        }
        // 从 PATH 中查找
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                let candidate = "\(dir)/\(name)"
                if FileManager.default.isExecutableFile(atPath: candidate) {
                    return candidate
                }
            }
        }
        return nil
    }

    /// 进程是否存活且非僵尸（僵尸需先 waitpid 收割，否则 kill(pid,0) 会误报存活）。
    private func isProcessAlive(_ pid: pid_t) -> Bool {
        if reapIfExited(pid) { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    /// 收割已退出的子进程，避免僵尸进程残留。返回 true 表示已成功收割（子进程已退出）。
    @discardableResult
    private func reapIfExited(_ pid: pid_t) -> Bool {
        var status: Int32 = 0
        let result = waitpid(pid, &status, WNOHANG)
        return result == pid
    }
}
