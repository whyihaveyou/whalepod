import Foundation

/// 数据放置：把壳的用户数据从 `~/.harness-shell/` 迁移到 macOS 标准位置
/// `~/Library/Application Support/WhalePod/`（产品名「鲸群」WhalePod）。
///
/// 目录结构（见 docs/m2-data-placement-plan.md）：
/// ```
/// ~/Library/Application Support/WhalePod/
/// ├── config.json        # 迁移后的壳配置（port 0=自动 等语义不变）
/// ├── migration.log      # 旧路径迁移日志
/// ├── migration-marker   # 一次性迁移标记（存在即已迁移过）
/// ├── singleton.lock     # 单实例锁
/// └── harness/           # DSH_HOME：harness 侧数据根（对齐 M0 bundled runtime）
/// ```
enum DataRoot {
    /// 产品目录名（英文，避免中文路径在 node/壳层脚本兼容问题）。
    static let appSupportDirName = "WhalePod"

    /// 基础数据根：`~/Library/Application Support/WhalePod/`（不存在则创建）。
    static var baseURL: URL {
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let url = appSupport.appendingPathComponent(appSupportDirName, isDirectory: true)
        try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// 壳配置文件：`WhalePod/config.json`。
    static var configURL: URL {
        baseURL.appendingPathComponent("config.json")
    }

    /// 旧路径配置文件：`~/.harness-shell/config.json`。
    static var legacyConfigURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".harness-shell", isDirectory: true)
            .appendingPathComponent("config.json")
    }

    /// 旧路径根目录：`~/.harness-shell/`。
    static var legacyBaseURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".harness-shell", isDirectory: true)
    }

    /// 迁移日志：`WhalePod/migration.log`。
    static var migrationLogURL: URL {
        baseURL.appendingPathComponent("migration.log")
    }

    /// 一次性迁移标记：`WhalePod/migration-marker`。
    static var migrationMarkerURL: URL {
        baseURL.appendingPathComponent("migration-marker")
    }

    /// 单实例锁：`WhalePod/singleton.lock`（归位到此数据根）。
    static var lockURL: URL {
        baseURL.appendingPathComponent("singleton.lock")
    }

    /// DSH_HOME（harness 侧数据根）：`WhalePod/harness/`。
    static var harnessHomeURL: URL {
        baseURL.appendingPathComponent("harness", isDirectory: true)
    }

    /// 壳运行日志目录：`WhalePod/logs/`（shell.log 等，问题排查 / 「复制日志」按钮的数据源）。
    static var logsDirURL: URL {
        let url = baseURL.appendingPathComponent("logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// 壳运行日志：`WhalePod/logs/shell.log`（超过 1MB 轮转归档为 shell-prev.log，单份保留）。
    static var shellLogURL: URL {
        logsDirURL.appendingPathComponent("shell.log")
    }
}
