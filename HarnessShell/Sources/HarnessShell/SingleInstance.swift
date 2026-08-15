import Foundation
import AppKit

/// 单实例守护：确保同一应用同一时刻只有一个实例在运行。
///
/// 采用**文件锁 flock（主）** + **NSRunningApplication 聚焦（兜底）** 两道防线：
///
/// 1. **flock 文件锁（主，可靠）**：对锁文件加 `LOCK_EX|LOCK_NB` 排他锁。
///    - flock 是内核级 advisory lock，**跨进程可靠互斥**（实测：A 持锁时 B 创建失败）。
///    - 关键优势：进程**正常退出或崩溃**时，内核自动关闭 fd 释放锁，不会留下永久死锁。
///    - 锁文件放在 `~/Library/Application Support/<bundle-id>/singleton.lock`，
///      不依赖 LaunchServices/Finder 对运行中应用的枚举，也不依赖 bundle id 唯一性。
///    - 弃用 CFMessagePort 命名锁：实测 `CFMessagePortCreateLocal` 的同名 local 端口
///      在两个 `.build` 应用进程间**不互斥**（同 session 不同进程同名 local port 会被
///      上下文隔离），而 flock 无此问题。
///
/// 2. **NSRunningApplication 聚焦（兜底）**：若持锁失败，说明已有实例在跑，
///    用 `runningApplications(withBundleIdentifier:)` 找到它并把其窗口激活到前台。
enum SingleInstance {

    private static var lockFD: Int32 = -1
    private static let lockURL = SingleInstance.lockFileURL()

    /// 持锁失败则聚焦旧实例并退出本实例；成功则继续启动。
    ///
    /// - Returns: `true` = 本实例应继续（成功持锁）；`false` = 已有实例（已聚焦它，应退出）。
    @discardableResult
    static func acquire() -> Bool {
        // 尝试持有 flock 文件锁
        guard let fd = tryAcquireFlock() else {
            fputs("[singleton] 文件锁被占用，检出已有实例，聚焦后退出\n", stderr)
            fflush(stderr)
            activateExistingInstance()
            return false
        }
        // 持锁成功 → 本实例是唯一实例。fd 保持打开，进程存活期间内核持有锁。
        lockFD = fd
        fputs("[singleton] 持锁成功(唯一实例)\n", stderr)
        fflush(stderr)
        return true
    }

    // MARK: - flock

    /// 打开锁文件并尝试加非阻塞排他锁。
    /// - Returns: 成功返回 fd（后续保持打开以持锁）；失败（已被占用）返回 nil。
    private static func tryAcquireFlock() -> Int32? {
        do {
            try FileManager.default.createDirectory(
                at: lockURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
        } catch {
            // 目录创建失败也尝试直接用文件（多数情况主目录可写）
        }
        let fd = open(lockURL.path, O_CREAT | O_RDWR, 0o644)
        guard fd >= 0 else { return nil }
        // 关键：设置 close-on-exec，避免 posix_spawn 拉起的 zsh→npm→node 子进程继承此 fd。
        // 否则主进程退出后子进程仍持有 fd → flock 锁不释放，产生"残留锁"误判。
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        // 非阻塞排他锁：返回 0 表示拿到；EACCES/EAGAIN 表示被占用
        if flock(fd, LOCK_EX | LOCK_NB) == 0 {
            return fd
        }
        close(fd)
        return nil
    }

    /// 锁文件路径：统一归位到数据根 `~/Library/Application Support/WhalePod/singleton.lock`
    /// （OOBE-M2：数据放置从 bundle-id 目录迁移到产品数据根 WhalePod）。
    /// `swift run` 未打包与打包应用共用同一把锁，保证只启一个实例。
    private static func lockFileURL() -> URL {
        DataRoot.lockURL
    }

    // MARK: - 聚焦

    /// 激活已存在的实例（聚焦所有窗口 / 激活应用）。
    private static func activateExistingInstance() {
        let bundleID = Bundle.main.bundleIdentifier ?? "com.aion2dsh.HarnessShell"
        let currentPID = ProcessInfo.processInfo.processIdentifier
        if let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first(where: { $0.processIdentifier != currentPID }) {
            existing.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        }
        // 若找不到（极少数场景），也静默退出，避免拉起第二个壳。
    }
}
