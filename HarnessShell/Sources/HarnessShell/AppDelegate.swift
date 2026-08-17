import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {

    private var windowController: MainWindowController?
    /// 自动更新检查服务（M1：仅检出+提示，不做替换）。
    private var updater: UpdaterService?

    /// 冷启动时暂存的深链（application:openURLs 可能先于 didFinishLaunching 到达）。
    private var pendingDeepLink: DeepLink?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 首启数据放置迁移（拿到单例锁之后、读配置之前）：旧 ~/.harness-shell/ → WhalePod
        Migration.runFirstLaunchMigrationIfNeeded()
        // 确保 DSH_HOME（harness 数据根）目录存在
        try? FileManager.default.createDirectory(at: DataRoot.harnessHomeURL,
                                                 withIntermediateDirectories: true)
        // OOB-7：盒内 dsh_home 种子 → 运行时 DSH_HOME（幂等；失败不硬崩，下次启动重试）。
        // 必须在 dsh 进程启动前完成——否则 honeycomb/面板 insert patch 与共享层链缺失
        // （OOB-F3 根因：开箱断言 c/d/e 全挂）。
        SeedPlanting.runFirstLaunchSeedIfNeeded()

        buildMainMenu()
        let controller = MainWindowController()
        windowController = controller
        controller.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)

        // 冷启动场景：先到达的深链在窗口就绪后路由
        if let link = pendingDeepLink {
            pendingDeepLink = nil
            controller.handle(deepLink: link)
        }

        startAutoUpdate(on: controller)
    }

    /// 启动自动更新（M1：检出有新版 → banner 提示 + 打开 release 页按钮；不做替换）。
    private func startAutoUpdate(on controller: MainWindowController) {
        let enabled = ServiceConfig.load().autoUpdate
        let service = UpdaterService(autoUpdateEnabled: enabled)
        service.onStateChange = { [weak controller] state in
            switch state {
            case .available(let info):
                guard let controller else { return }
                controller.showUpdateBanner(version: info.version, releaseURL: info.releaseURL)
            case .idle, .checking, .upToDate, .error, .disabled:
                controller?.hideUpdateBanner()
            }
        }
        updater = service
        service.start()
    }

    /// 深链入口：应用已在运行（或冷启动早于 didFinishLaunching 时）由系统回调。
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first, let link = DeepLink.parse(url) else {
            // 非 whale:// 或无法解析的 URL：忽略（不打断当前会话）
            return
        }
        if let controller = windowController {
            controller.handle(deepLink: link)
        } else {
            pendingDeepLink = link
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// 单击 Dock 图标时恢复窗口（单实例应用的标准行为）。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let controller = windowController, !flag {
            controller.showWindow(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        updater?.stop()
        windowController?.shutdown()
    }

    /// 最小主菜单：关于/退出 + 编辑菜单（保证 WKWebView 里复制粘贴可用）。
    private func buildMainMenu() {
        let mainMenu = NSMenu()
        let appName = ProcessInfo.processInfo.processName

        // 应用菜单
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 \(appName)",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 \(appName)",
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        // 编辑菜单
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }
}
