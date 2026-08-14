import Foundation
import Darwin

// 无头冒烟测试：验证 HarnessServiceManager 的核心逻辑
// 1) 配置加载（默认命令；端口 0 = 自动端口模式）
// 2) 独立进程组拉起 + killpg 整组停止
// 3) 崩溃自动重启退避（指数退避调度 + 用户主动停止不重启）
// 4) 深链解析（DeepLink）——见下方独立小用例

func expect(_ cond: Bool, _ name: String) {
    print((cond ? "✅ " : "❌ ") + name)
    if !cond { exit(1) }
}

let config = ServiceConfig.load()
expect(config.command.contains("dsh web"), "默认命令含 dsh web")
expect(config.port == 0 || config.port > 0, "端口有效（0=自动 / 正整数=固定）")
expect(config.isAutoPort == (config.port <= 0), "自动端口标识与 port 一致")

let manager = HarnessServiceManager(config: config)
// 自动端口模式不与固定端口探测绑定：只验证不崩溃、状态机可初始化即可
expect(manager.state == .stopped, "初始状态 stopped")

// 用 sleep 子进程测试进程组管理
let testConfig = ServiceConfig(
    command: "sleep 30",
    workingDirectory: nil,
    host: "127.0.0.1",
    port: 39999,
    environment: [:]
)
let mgr = HarnessServiceManager(config: testConfig)
mgr.start()
expect(mgr.isReachable() == false, "端口 39999 不可达")

// 等 1 秒让进程稳定
Thread.sleep(forTimeInterval: 1.0)

// 通过 state 检查进程是否在启动流程中（此时应 starting）
let pid = mgr.spawnedPidValue
expect(pid != nil, "已获得子进程 pid (\(pid ?? -1))")
if let pid {
    // 注意：spawn 的是 zsh 包装进程，它可能很快 fork 出 sleep 后自身退出/变僵尸，
    // 因此不能直接对 pid 调 getpgid/kill 断言（会因 ESRCH 误报）。正确不变量是：
    //   (a) 独立进程组生效：组内存在存活子进程，其 pgid == pid（= zsh 自身 pid，SETPGROUP 语义）
    //   (b) stop() 后整组（含 sleep 后代）被 killpg 清理，不留孤儿
    func groupMembers(_ pgid: pid_t) -> [(pid: pid_t, pgid: pid_t)] {
        // 列出该进程组内存活进程的 (pid, pgid)。注意：此 macOS 上 `-o pid= -g <pgid>` 解析异常返回空，
        // 需显式多列 `-o pid=,pgid= -g <pgid>`（实测有效，见诊断）。
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-o", "pid=,pgid=", "-g", String(pgid)]
        let pipeObj = Pipe()
        p.standardOutput = pipeObj
        try? p.run()
        let data = pipeObj.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)!
            .split(separator: "\n")
            .compactMap { line -> (pid: pid_t, pgid: pid_t)? in
                let cols = line.split(separator: " ", omittingEmptySubsequences: true)
                guard cols.count >= 2, let pd = pid_t(cols[0]), let gd = pid_t(cols[1]) else { return nil }
                return (pd, gd)
            }
    }

    // (a) 独立进程组生效：spawn 的 `zsh -lc 'sleep 30'` 对单命令会用 exec（不保留包装 zsh），
    // 因此 pid 自身就是存活进程且 pgid == pid；若个别实现保留 zsh 包装，组内也会有 sleep 后代。
    // 不变量：进程组 pgid 内存在存活进程，且这些进程的 pgid 全部 == pid（独立进程组语义）。
    var members = groupMembers(pid)
    var attempts = 0
    while members.isEmpty && attempts < 10 {
        Thread.sleep(forTimeInterval: 0.2)
        members = groupMembers(pid)
        attempts += 1
    }
    expect(!members.isEmpty, "进程组 \(pid) 内存在存活进程 [\(members.map { $0.pid })]")
    if let first = members.first {
        expect(first.pgid == pid, "存活进程 \(first.pid) 的 pgid(\(first.pgid)) == 组主 pid(\(pid))（独立进程组生效）")
    }

    // (b) stop() 后整组清理：killpg 应把组内所有进程一并终止，不留孤儿
    mgr.stop()
    var cleaned = true
    for _ in 0..<15 {
        Thread.sleep(forTimeInterval: 0.2)
        if groupMembers(pid).isEmpty { cleaned = true; break }
        cleaned = false
    }
    expect(cleaned, "stop() 后进程组 \(pid) 已整组清理（killpg SIGTERM 生效）")
}

// 崩溃自动重启退避：
// 用一个立即退出的子进程验证意外退出会进入 restarting 并自动拉起；
// 再验证用户主动 stop 不触发重启。
func observeStates(_ mgr: HarnessServiceManager, seconds: TimeInterval, _ start: () -> Void) -> [String] {
    var observed: [String] = []
    start()
    let timer = Timer(timeInterval: 0.05, repeats: true) { _ in
        let s = String(describing: mgr.state)
        if observed.last != s { observed.append(s) }
    }
    RunLoop.main.add(timer, forMode: .common)
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    timer.invalidate()
    return observed
}

// A) 意外退出 → 指数退避重启
// 注：poll 间隔约 2s，观察窗口需 >2s 才能捕捉到 restarting 状态
let crashConfig = ServiceConfig(
    command: "echo boom && exit 1",   // 立即崩溃
    workingDirectory: nil,
    host: "127.0.0.1",
    port: 39998,
    environment: [:]
)
let crashMgr = HarnessServiceManager(config: crashConfig)
let crashStates = observeStates(crashMgr, seconds: 5.0) {
    crashMgr.start()
}
expect(crashStates.contains { $0.hasPrefix("restarting(attempt: 1") },
       "意外退出后进入退避重启 restarting(attempt:1)")

// B) 用户主动停止 → 回到 stopped，绝不重启
let stayConfig = ServiceConfig(
    command: "sleep 60",
    workingDirectory: nil,
    host: "127.0.0.1",
    port: 39997,
    environment: [:]
)
let stayMgr = HarnessServiceManager(config: stayConfig)
let stayStates = observeStates(stayMgr, seconds: 5.0) {
    stayMgr.start()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { stayMgr.stop() }
}
expect(stayStates.contains("stopped"), "用户主动停止后回到 stopped")
expect(!stayStates.contains { $0.hasPrefix("restarting") },
       "用户主动停止未触发退避重启")

// 深链解析
func expectLink(_ raw: String, _ match: (DeepLink.Action) -> Bool, _ name: String) {
    guard let dl = DeepLink.parse(URL(string: raw)!) else {
        expect(false, "\(name): 解析返回 nil \(raw)")
        return
    }
    expect(match(dl.action), "\(name) \(raw)")
}
expectLink("dsh://open?port=3080", { if case .open(let p) = $0 { return p == 3080 }; return false }, "open?port 解析")
expectLink("dsh://session/abc-123", { if case .session(let id) = $0 { return id == "abc-123" }; return false }, "session 解析")
expect(DeepLink.parse(URL(string: "http://localhost:3080")!) == nil, "非 dsh:// 返回 nil")

print("🎉 冒烟测试全部通过")
