import AppKit

// 确定性自检通道：`WHALEPOD_SELFTEST=1` —— 跑 M1 断言后退出，不进 GUI。
// 放在 SingleInstance 检查之前，自检不受「已有实例锁」影响。
if ProcessInfo.processInfo.environment["WHALEPOD_SELFTEST"] == "1" {
    UpdaterSelfTest.run()
}
// 活 fixture 通道三态演示：`WHALEPOD_LIVE_PROBE=1`（见 UpdaterSelfTest.runLiveProbe）。
if ProcessInfo.processInfo.environment["WHALEPOD_LIVE_PROBE"] == "1" {
    UpdaterSelfTest.runLiveProbe()
}

// 单实例守护：CFMessagePort 命名锁（主）+ NSRunningApplication 聚焦（兜底）。
// 已有实例持锁时：激活旧实例窗口到前台并退出本次启动，而不是起第二个壳。
// （`swift run` 未打包时 Bundle.main.bundleIdentifier 为 nil，锁名回落固定 id，
//   仍与已安装的打包应用共用同一把锁，避免重复启动。）
if !SingleInstance.acquire() {
    // 已有实例在跑（已聚焦它），本实例直接退出
    exit(0)
}

// 程序入口：纯代码构建 NSApplication（无 storyboard/xib）。
let app = NSApplication.shared
let appDelegate = AppDelegate()
app.delegate = appDelegate
app.setActivationPolicy(.regular)
app.run()
