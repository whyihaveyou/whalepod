import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {

    private var windowController: MainWindowController?

    /// 冷启动时暂存的深链（application:openURLs 可能先于 didFinishLaunching 到达）。
    private var pendingDeepLink: DeepLink?

    func applicationDidFinishLaunching(_ notification: Notification) {
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
    }

    /// 深链入口：应用已在运行（或冷启动早于 didFinishLaunching 时）由系统回调。
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first, let link = DeepLink.parse(url) else {
            // 非 dsh:// 或无法解析的 URL：忽略（不打断当前会话）
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
