import Foundation

/// UpdaterService M1 确定性自检（可写成程序内轻量单测）。
///
/// 触发：`WHALEPOD_SELFTEST=1 swift run` —— 跑完断言直接退出，不进 GUI。
/// 覆盖：appcast 解析 / build 号取最新 / 「有新版 vs 已最新 vs 解析失败」三态判定。
/// 对齐 spikes/auto-update/appcast.xml 的 fixture。
enum UpdaterSelfTest {

    /// 双 enclosure fixture：每条 item 含 Full(.dmg) + Slim(.zip)，各带自定义 sha256 + length。
    /// 对齐 Flash-1 make-appcast.sh 真实格式（通用文件名，不假设品牌风格）。
    static let fixtureAppcast = """
    <?xml version="1.0" encoding="utf-8"?>
    <rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
      <channel>
        <title>WhalePod 更新通道</title>
        <item>
          <title>Version 0.1.0-alpha.5</title>
          <sparkle:shortVersionString>0.1.0-alpha.5</sparkle:shortVersionString>
          <sparkle:version>5</sparkle:version>
          <enclosure url="WhalePod-0.1.0-alpha.5-macos-arm64.dmg" sparkle:version="5" length="206000000" type="application/octet-stream" sha256="AAA5"/>
          <enclosure url="WhalePod-0.1.0-alpha.5-macos-arm64-slim.zip" sparkle:version="5" length="1100000" type="application/octet-stream" sha256="BBB5"/>
        </item>
        <item>
          <title>Version 0.1.0-alpha.4</title>
          <sparkle:shortVersionString>0.1.0-alpha.4</sparkle:shortVersionString>
          <sparkle:version>4</sparkle:version>
          <enclosure url="HarnessShell.dmg" sparkle:version="4" length="200000000" type="application/octet-stream" sha256="AAA4"/>
          <enclosure url="HarnessShell-slim.zip" sparkle:version="4" length="1000000" type="application/octet-stream" sha256="BBB4"/>
        </item>
      </channel>
    </rss>
    """

    /// 单 enclosure fixture（只有 Full .dmg）——验证「另一档缺失 → fallback 不崩」。
    static let singleEnclosureAppcast = """
    <?xml version="1.0" encoding="utf-8"?>
    <rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
      <channel>
        <item>
          <sparkle:shortVersionString>0.1.0-alpha.6</sparkle:shortVersionString>
          <sparkle:version>6</sparkle:version>
          <enclosure url="only-full.dmg" sparkle:version="6" length="1000" type="application/octet-stream" sha256="FFF6"/>
        </item>
      </channel>
    </rss>
    """

    /// 假想「Contents/Resources」目录：含/不含 `node` → Full/Slim 档位判定用。
    /// 返回的 URL 即充当 resourceURL（= real 的 Bundle.main.resourceURL），
    /// `Tier.resolve` 会查其下的 `node` 是否存在。
    private static func fakeResourceURL(withNode: Bool) -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("whalepod-selftest-\(withNode)-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true
        )
        if withNode {
            FileManager.default.createFile(atPath: dir.appendingPathComponent("node").path, contents: nil)
        }
        return dir
    }

    static func run() -> Never {
        var failures: [String] = []
        var count = 0

        func check(_ name: String, _ cond: Bool, _ detail: @autoclosure () -> String = "") {
            count += 1
            if cond {
                print("  ✓ \(name)")
            } else {
                failures.append(name)
                print("  ✗ \(name)  \(detail())")
            }
        }

        print("[selftest] UpdaterService M1 确定性断言")

        // 1) 双 enclosure 解析：两档全部解出，build 正确
        let parsed = UpdaterService.parseAppcastString(fixtureAppcast)
        check("解析出条目", parsed?.count == 2, "got \(parsed?.count ?? -1)")
        check("条目0 build=5", parsed?[0].build == 5)
        check("条目1 build=4", parsed?[1].build == 4)

        // 1a) 条目0 双 enclosure 齐全，sha256 + length 正确捕获
        let p0 = parsed?[0]
        check("条目0 full 命中 .dmg", p0?.full?.url == "WhalePod-0.1.0-alpha.5-macos-arm64.dmg")
        check("条目0 full sha256=AAA5", p0?.full?.sha256 == "AAA5")
        check("条目0 full length=206000000", p0?.full?.length == 206_000_000)
        check("条目0 slim 命中 .zip", p0?.slim?.url == "WhalePod-0.1.0-alpha.5-macos-arm64-slim.zip")
        check("条目0 slim sha256=BBB5", p0?.slim?.sha256 == "BBB5")
        check("条目0 slim length=1100000", p0?.slim?.length == 1_100_000)

        // 1b) 条目1（泛名 alpha.4）也按扩展名识别，不依赖文件名风格
        let p1 = parsed?[1]
        check("条目1 full 仍识别 .dmg", p1?.full?.url == "HarnessShell.dmg")
        check("条目1 slim 仍识别 .zip", p1?.slim?.url == "HarnessShell-slim.zip")

        // 2) 取最新：按 build 5（整数主键）
        let latest = parsed.flatMap { UpdaterService.latestItem($0) }
        check("最新 build=5", latest?.build == 5, "got \(latest?.build ?? -1)")
        check("最新 shortVersion=alpha.5", latest?.shortVersion == "0.1.0-alpha.5")

        // 2a) 档位判定：Contents/Resources 含 node = Full，否则 Slim
        check("Tier: 有 node → full", UpdaterService.Tier.resolve(resourceURL: fakeResourceURL(withNode: true)) == .full)
        check("Tier: 无 node → slim", UpdaterService.Tier.resolve(resourceURL: fakeResourceURL(withNode: false)) == .slim)
        check("Tier: nil resourceURL → slim", UpdaterService.Tier.resolve(resourceURL: nil) == .slim)

        // 2b) 档位命中：Full 装机 → 命中 .dmg 条；Slim 装机 → 命中 .zip 条
        if let latest {
            let fullInfo = latest.asUpdateInfo(for: .full)
            check("Full 档 tier=full", fullInfo.tier == .full)
            check("Full 档 sha256=AAA5", fullInfo.expectedSHA256 == "AAA5")
            check("Full 档 length=206000000", fullInfo.length == 206_000_000)
            check("Full 档 downloadURL 尾部命中 .dmg", fullInfo.downloadURL?.lastPathComponent == "WhalePod-0.1.0-alpha.5-macos-arm64.dmg")
            check("Full 档 downloadURL 带 latest/download 前缀",
                  fullInfo.downloadURL?.absoluteString == "https://github.com/whyihaveyou/whalepod/releases/latest/download/WhalePod-0.1.0-alpha.5-macos-arm64.dmg")
            check("Full 档 verifyScheme=sha256", fullInfo.verifyScheme == .sha256)

            let slimInfo = latest.asUpdateInfo(for: .slim)
            check("Slim 档 tier=slim", slimInfo.tier == .slim)
            check("Slim 档 sha256=BBB5", slimInfo.expectedSHA256 == "BBB5")
            check("Slim 档 length=1100000", slimInfo.length == 1_100_000)
            check("Slim 档 downloadURL 尾部命中 .zip", slimInfo.downloadURL?.lastPathComponent == "WhalePod-0.1.0-alpha.5-macos-arm64-slim.zip")
        }

        // 2c) 单 enclosure fallback：只有 .dmg，Slim 装机 → 另一档缺失，下载 URL 回落 nil 不崩
        let singleParsed = UpdaterService.parseAppcastString(singleEnclosureAppcast)
        let singleLatest = singleParsed.flatMap { UpdaterService.latestItem($0) }
        check("单 enclosure 解析出 1 条", singleParsed?.count == 1)
        check("单条 build=6", singleLatest?.build == 6, "got \(singleLatest?.build ?? -1)")
        check("单条 full 识别", singleLatest?.full?.url == "only-full.dmg")
        check("单条 slim 缺失→nil", singleLatest?.slim == nil)
        if let singleLatest {
            let slimInfo = singleLatest.asUpdateInfo(for: .slim)
            check("单条 slim 档 downloadURL=nil(回落)", slimInfo.downloadURL == nil)
            check("单条 slim 档 sha256=nil", slimInfo.expectedSHA256 == nil)
            // 仅 Full/另一条无 .zip 时，Full 档仍正常命中，不窜档
            let fullInfo = singleLatest.asUpdateInfo(for: .full)
            check("单条 full 档仍命中", fullInfo.downloadURL?.lastPathComponent == "only-full.dmg")
        }

        // 3) 判定三态（build 整数比较，不碰 semver 字符串）
        guard let latestBuild = latest?.build else {
            print("[selftest] 无法取得最新 build，失败")
            print(failures.isEmpty ? "[selftest] PASS (\(count) checks)" : "[selftest] FAIL: \(failures.joined(separator: ", "))")
            exit(failures.isEmpty ? 0 : 1)
        }
        check("有新版: latest(5) > local(1)", latestBuild > 1)
        check("已最新: latest(5) > local(5) 为假", !(latestBuild > 5))

        // 4) 解析失败（垃圾输入 → nil，对应 error 态）
        check("解析失败→nil", UpdaterService.parseAppcastString("not an appcast at all") == nil)

        print(failures.isEmpty
            ? "[selftest] PASS — \(count)/\(count) checks"
            : "[selftest] FAIL — \(failures.joined(separator: ", "))"
        )
        exit(failures.isEmpty ? 0 : 1)
    }

    /// 活的 fixture 通道三态演示（`WHALEPOD_LIVE_PROBE=1`）：
    /// 走**真实** UpdaterService.checkForUpdate()（URLSession 拉 appcast → 解析 → build 判定）。
    /// 期望状态由 `WHALEPOD_EXPECT` 指定：available / up-to-date / error。
    /// 用法示例：
    ///   (cd spikes/auto-update && python3 -m http.server 4833) &
    ///   WHALEPOD_LIVE_PROBE=1 WHALEPOD_APPCAST_URL=http://127.0.0.1:4833/appcast.xml \
    ///       WHALEPOD_EXPECT=available swift run
    static func runLiveProbe() -> Never {
        print("[live-probe] UpdaterService.checkForUpdate() 实拉实判（真实 URLSession）")
        print("[live-probe] appcast=\(environment("WHALEPOD_APPCAST_URL") ?? "<默认生产?>") expect=\(environment("WHALEPOD_EXPECT") ?? "?")")

        let svc = UpdaterService(autoUpdateEnabled: true)
        var finalState: UpdaterService.State?
        let deadline = Date().addingTimeInterval(10)

        svc.onStateChange = { state in
            if state != .checking {
                finalState = state
            }
        }
        svc.checkForUpdate()

        // 泵主 RunLoop，让 URLSession 完成回调 + setStateSafe(main.async) 落定
        while finalState == nil {
            if Date() > deadline {
                print("[live-probe] ✗ 超时未得到终态")
                exit(3)
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }

        let got = finalState!
        let expect = environment("WHALEPOD_EXPECT")
        let ok: Bool
        switch got {
        case .available(let info):
            print("[live-probe] → available(version=\(info.version), build=\(info.build))")
            ok = expect == "available"
        case .upToDate:
            print("[live-probe] → up-to-date")
            ok = expect == "up-to-date"
        case .error:
            print("[live-probe] → error（离线/拉取/解析失败，UI 静默）")
            ok = expect == "error"
        case .disabled:
            print("[live-probe] → disabled")
            ok = expect == "disabled"
        case .idle:
            ok = false
        case .checking:
            ok = false
        }
        print(ok ? "[live-probe] ✓ 与期望一致" : "[live-probe] ✗ 与期望(\(expect ?? "?"))不一致")
        exit(ok ? 0 : 1)
    }

    private static func environment(_ key: String) -> String? {
        ProcessInfo.processInfo.environment[key]
    }
}
