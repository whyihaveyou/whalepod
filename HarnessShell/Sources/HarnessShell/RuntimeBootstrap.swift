import Foundation

/// 运行时自举：决定用哪种方式启动 harness，并解析出可执行命令。
///
/// 方案依据：docs/m0-runtime-bootstrap-plan.md「八、落地拆分」。
/// 目标：让用户免装 Node 一键起（bundled 优先）→ 本机 node 探测 → npx 兜底，
///      同时完全兼容用户在 config.json 里手写的 command（custom 最高优先级）。
enum RuntimeBootstrap {

    /// 固定 dsh 版本（对齐 refs/dsh-desktop：@deepseek-ai/dsh@0.1.0-rc.6），防漂移。
    static let dshVersion = "0.1.0-rc.6"

    /// 解析结果：要么直接 exec 可执行文件数组，要么走 shell 命令。
    enum Plan: Equatable {
        /// 直接 exec：bundled / nodeProbe 用（node 可执行文件 + [bin.js, "web", ...args]）。
        case direct(executable: String, arguments: [String])
        /// 走 shell：custom / npxFallback 用（经 zsh -lc 执行）。
        case shell(command: String)
        /// 探测链全部失败（无 bundled、无系统 node、无法 npx）。
        case unavailable(reason: String)
    }

    // MARK: - 解析入口

    /// 由配置解析出启动方案：
    /// - custom 优先：用户手写一段 command（非空）→ 原样 shell 执行（向后兼容 config.json）。
    /// - 空/默认 command → 自动探测链：bundled → nodeProbe → npxFallback。
    /// - `portArg` 由调用方传入（"--port 0" 或 "--port <n>"），统一追加，端口注入逻辑不变。
    static func resolve(config: ServiceConfig, portArg: String) -> Plan {
        // ① custom：用户显式手写命令（最高优先级，向后兼容旧配置）
        let cmd = config.command.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cmd.isEmpty {
            return .shell(command: appendPort(cmd, portArg: portArg, forceSeparator: needsSeparator(cmd)))
        }

        // ② bundled：Resources/node + Resources/node_modules（离线、版本自管、最稳）
        if let node = bundledNodePath(), let bin = bundledDSHBinPath(),
           FileManager.default.isExecutableFile(atPath: node),
           FileManager.default.fileExists(atPath: bin) {
            return .direct(executable: node,
                           arguments: [bin, "web", "--port", portNumber(from: portArg) ?? "0"])
        }

        // ③ nodeProbe：本机 node + 内置 node_modules（省体积、跟随系统 node）
        if let node = probeSystemNode(), let bin = bundledDSHBinPath(),
           FileManager.default.fileExists(atPath: bin) {
            return .direct(executable: node,
                           arguments: [bin, "web", "--port", portNumber(from: portArg) ?? "0"])
        }

        // ④ npxFallback：都没有时用 npm/npx 自动拉取（需网络 + npm），并引导安装
        if probeSystemNode() != nil {
            return .shell(command: "npx --yes @deepseek-ai/dsh@\(dshVersion) web -- --port \(portNumber(from: portArg) ?? "0")")
        }
        return .unavailable(reason: "未找到可用的 Node 运行时（缺少 bundled node / 本机 node），且无 npm 可用。请安装 Node（https://nodejs.org）后重试，或配置 config.json 的 command 指定启动方式。")
    }

    // MARK: - 探测

    /// bundled node：`.app/Contents/Resources/node/bin/node`。
    static func bundledNodePath() -> String? {
        guard let res = Bundle.main.resourceURL else { return nil }
        return res.appendingPathComponent("node/bin/node", isDirectory: false).path
    }

    /// bundled dsh 入口：`Resources/node_modules/@deepseek-ai/dsh/lib/bin.js`。
    static func bundledDSHBinPath() -> String? {
        guard let res = Bundle.main.resourceURL else { return nil }
        return res.appendingPathComponent("node_modules/@deepseek-ai/dsh/lib/bin.js", isDirectory: false).path
    }

    /// 探测本机 node：先常见路径，再从 PATH 找。
    static func probeSystemNode() -> String? {
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/bin/node",
        ]
        if let hit = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return hit
        }
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                let candidate = "\(dir)/node"
                if FileManager.default.isExecutableFile(atPath: candidate) {
                    return candidate
                }
            }
        }
        return nil
    }

    // MARK: - 小工具

    /// 从 "--port 0" / "--port <n>" 抽出端口数字；抽不出返回 nil。
    private static func portNumber(from portArg: String) -> String? {
        let parts = portArg.split(separator: " ")
        return parts.last.map { String($0) }
    }

    /// 拼接端口参数：npm/npx 类命令需要 `--` 分隔符透传。
    private static func appendPort(_ command: String, portArg: String, forceSeparator: Bool) -> String {
        forceSeparator ? "\(command) -- \(portArg)" : "\(command) \(portArg)"
    }

    /// npm/npx exec 场景需要 `--` 分隔符（与现有 buildCommandLine 语义一致）。
    private static func needsSeparator(_ command: String) -> Bool {
        command.starts(with: "npm ") || command.starts(with: "npx ")
    }
}
