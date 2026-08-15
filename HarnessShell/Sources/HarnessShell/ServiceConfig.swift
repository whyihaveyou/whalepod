import Foundation

/// 服务配置：决定要启动/停止哪个 harness 服务、监听哪个端口。
///
/// 配置来源（优先级从高到低）：
/// 1. `~/Library/Application Support/WhalePod/config.json`（推荐，字段全部可选，缺省回落到默认值；
///    旧路径 `~/.harness-shell/config.json` 仍兼容读取，迁移逻辑见 Migration.swift）
/// 2. 内置默认值
///
/// 配置文件示例（~/Library/Application Support/WhalePod/config.json）：
/// ```json
/// {
///   "command": "npm exec @deepseek-ai/dsh web",
///   "workingDirectory": "/Users/qzp/aion2dsh/deepseek-harness",
///   "host": "127.0.0.1",
///   "port": 0,
///   "environment": { "NODE_ENV": "production" }
/// }
/// ```
///
/// `port` 语义：
///   - `0`（默认，推荐）：自动端口。启动命令追加 `--port 0` 让 dsh 用随机回环端口，
///     壳从子进程 stdout 解析实际端口后再让 WKWebView 指向它——彻底避免端口冲突。
///   - 正整数：固定端口。壳追加 `--port <n>` 并探测该端口；若已被外部占用则直接复用。
struct ServiceConfig: Codable {
    /// 启动 harness 服务的 shell 命令（会通过 `zsh -lc` 执行，以加载 PATH 等环境）。
    /// 注意：命令中不要再写 `--port`，壳会自动追加。
    var command: String
    /// 启动命令的工作目录；为空则使用用户主目录。
    var workingDirectory: String?
    /// 服务监听 host。
    var host: String
    /// 端口：0 = 自动（默认）；正整数 = 指定。
    var port: Int
    /// 额外的环境变量。
    var environment: [String: String]

    /// 是否自动端口模式。
    var isAutoPort: Bool { port <= 0 }

    /// 生成服务地址。自动模式下需传入解析出的实际端口（未解析时传 nil → 返回 nil）。
    func url(port resolvedPort: Int?) -> URL? {
        guard let p = resolvedPort ?? (port > 0 ? port : nil) else { return nil }
        return URL(string: "http://\(host):\(p)")
    }

    /// 内置默认值：自动端口。
    static let `default` = ServiceConfig(
        command: "npm exec @deepseek-ai/dsh web",
        workingDirectory: nil,
        host: "127.0.0.1",
        port: 0,
        environment: [:]
    )

    /// 容错加载：配置文件缺失/损坏/字段缺失都回落到默认值。
    static func load() -> ServiceConfig {
        var config = ServiceConfig.default
        guard let url = configFileURL(),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(FileFormat.self, from: data) else {
            return config
        }
        if let v = file.command { config.command = v }
        if let v = file.workingDirectory { config.workingDirectory = v }
        if let v = file.host { config.host = v }
        if let v = file.port { config.port = v }
        if let v = file.environment { config.environment = v }
        return config
    }

    /// 配置文件路径：优先新根 `~/Library/Application Support/WhalePod/config.json`，
    /// 不存在时回落到旧路径 `~/.harness-shell/config.json`（兼容尚未迁移 / 迁移失败的场景）。
    /// 迁移逻辑见 Migration.swift。
    private static func configFileURL() -> URL? {
        let fm = FileManager.default
        if fm.fileExists(atPath: DataRoot.configURL.path) {
            return DataRoot.configURL
        }
        // 新根没有时才看旧路径（旧路径有则待迁移；没有则返回新根 URL 表示首启初始化）
        if fm.fileExists(atPath: DataRoot.legacyConfigURL.path) {
            return DataRoot.legacyConfigURL
        }
        return DataRoot.configURL
    }

    /// 配置文件格式：所有字段可选，便于部分覆盖默认值。
    private struct FileFormat: Codable {
        var command: String?
        var workingDirectory: String?
        var host: String?
        var port: Int?
        var environment: [String: String]?
    }
}
