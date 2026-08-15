import Foundation

/// UpdaterService M1 确定性自检（可写成程序内轻量单测）。
///
/// 触发：`WHALEPOD_SELFTEST=1 swift run` —— 跑完断言直接退出，不进 GUI。
/// 覆盖：appcast 解析 / build 号取最新 / 「有新版 vs 已最新 vs 解析失败」三态判定。
/// 对齐 spikes/auto-update/appcast.xml 的 fixture。
enum UpdaterSelfTest {

    static let fixtureAppcast = """
    <?xml version="1.0" encoding="utf-8"?>
    <rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
      <channel>
        <title>WhalePod 更新通道</title>
        <item>
          <title>Version 0.1.0-alpha.5</title>
          <sparkle:shortVersionString>0.1.0-alpha.5</sparkle:shortVersionString>
          <sparkle:version>5</sparkle:version>
          <enclosure url="WhalePod-0.1.0-alpha.5-macos-arm64-full.dmg" sparkle:version="5" length="1" type="application/octet-stream"/>
        </item>
        <item>
          <title>Version 0.1.0-alpha.4</title>
          <sparkle:shortVersionString>0.1.0-alpha.4</sparkle:shortVersionString>
          <sparkle:version>4</sparkle:version>
          <enclosure url="WhalePod-0.1.0-alpha.4-macos-arm64-full.dmg" sparkle:version="4" length="1" type="application/octet-stream"/>
        </item>
      </channel>
    </rss>
    """

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

        // 1) 解析：两档全部解出，build 正确
        let parsed = UpdaterService.parseAppcastString(fixtureAppcast)
        check("解析出条目", parsed?.count == 2, "got \(parsed?.count ?? -1)")
        check("条目0 build=5", parsed?[0].build == 5)
        check("条目1 build=4", parsed?[1].build == 4)
        check("条目含 enclosure url", parsed?[1].enclosureURL != nil)

        // 2) 取最新：按 build 5（整数主键）
        let latest = parsed.flatMap { UpdaterService.latestItem($0) }
        check("最新 build=5", latest?.build == 5, "got \(latest?.build ?? -1)")
        check("最新 shortVersion=alpha.5", latest?.shortVersion == "0.1.0-alpha.5")

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
