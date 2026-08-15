import Foundation

/// 首启一次性迁移：把旧 `~/.harness-shell/config.json` 迁移到新数据根
/// `~/Library/Application Support/WhalePod/`。
///
/// 语义（docs/m2-data-placement-plan.md）：
/// - `WhalePod/config.json` 已存在 → 新路径优先，直接用，不迁移不动旧文件。
/// - 新根无、旧 `~/.harness-shell/config.json` 存在 → 拷贝到新根 + 写 migration.log + 落 migration-marker。
/// - 新旧都无 → 按新根初始化空配置（不迁移）。
/// - `migration-marker` 存在 → 已迁移过，跳过（幂等，防多实例并发迁移）。
/// - 迁移失败不硬崩：写失败日志，回退由 ServiceConfig 的旧路径 fallback 兜底，下次启动重试。
enum Migration {

    /// 应用启动早期调用一次（拿到单例锁之后、读取配置之前）。
    static func runFirstLaunchMigrationIfNeeded() {
        ensureBaseDirectory()
        // 已在目标位 → 无需迁移
        if FileManager.default.fileExists(atPath: DataRoot.configURL.path) {
            return
        }
        // 已迁移过（marker 存在）→ 幂等跳过
        if FileManager.default.fileExists(atPath: DataRoot.migrationMarkerURL.path) {
            return
        }
        // 旧路径无配置 → 无迁移需求
        guard FileManager.default.fileExists(atPath: DataRoot.legacyConfigURL.path) else {
            return
        }
        migrateLegacyConfig()
    }

    // MARK: - 迁移

    private static func migrateLegacyConfig() {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: DataRoot.baseURL, withIntermediateDirectories: true)
            // 拷贝旧配置到新根（保留原内容，语义不变）
            try fm.copyItem(at: DataRoot.legacyConfigURL, to: DataRoot.configURL)
            try writeLog("migrated config.json from \(DataRoot.legacyConfigURL.path) -> \(DataRoot.configURL.path)")
            try "migrated \(Date().timeIntervalSince1970)".write(to: DataRoot.migrationMarkerURL, atomically: true, encoding: .utf8)
            // 不删除旧文件：保留旧路径作为兜底，避免破坏用户原有环境
        } catch {
            // 写入失败日志后回退（ServiceConfig 会走旧路径 fallback），下次启动重试
            try? writeLog("MIGRATION FAILED: \(error.localizedDescription)")
        }
    }

    // MARK: - 日志

    private static func writeLog(_ line: String) throws {
        try fm().createDirectory(at: DataRoot.baseURL, withIntermediateDirectories: true)
        let entry = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: DataRoot.migrationLogURL) {
            defer { try? handle.close() }
            handle.seekToEndOfFile()
            try? handle.write(contentsOf: Data(entry.utf8))
        } else {
            try entry.write(to: DataRoot.migrationLogURL, atomically: true, encoding: .utf8)
        }
    }

    // MARK: - 目录

    @discardableResult
    private static func ensureBaseDirectory() -> Bool {
        do {
            try fm().createDirectory(at: DataRoot.baseURL, withIntermediateDirectories: true)
            return true
        } catch {
            return false
        }
    }

    private static func fm() -> FileManager { .default }
}
