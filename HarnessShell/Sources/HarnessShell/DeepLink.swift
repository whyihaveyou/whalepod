import Foundation

/// dsh:// URL scheme 深链。
///
/// 支持的格式：
///   - `dsh://open?port=3080`        → 打开指定端口的 harness 实例
///   - `dsh://session/<id>`          → 直接路由到某个 session
///   - 其他格式解析失败时落入 `.unknown`，原样桥接给 Web 端处理
struct DeepLink: Equatable {
    enum Action: Equatable {
        case open(port: Int)
        case session(String)
        case unknown
    }

    /// 原始 URL（透传）
    let rawURL: String
    /// 解析后的动作
    let action: Action

    // MARK: 解析

    /// 从 URL 解析深链；scheme 不是 dsh:// 时返回 nil（调用方忽略）。
    static func parse(_ url: URL) -> DeepLink? {
        guard let scheme = url.scheme?.lowercased(), scheme == "dsh" else { return nil }
        let raw = url.absoluteString
        let action: Action

        switch url.host?.lowercased() {
        case "open":
            let port = DeepLink.port(from: url)
            action = port.map(Action.open) ?? .unknown
        case "session":
            let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            action = id.isEmpty ? .unknown : .session(id)
        default:
            action = .unknown
        }
        return DeepLink(rawURL: raw, action: action)
    }

    private static func port(from url: URL) -> Int? {
        guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = comps.queryItems else { return nil }
        for item in items where item.name.lowercased() == "port" {
            if let value = item.value, let port = Int(value), (1...65535).contains(port) {
                return port
            }
        }
        return nil
    }

    // MARK: Web 桥接载荷

    /// 注入 Web 端的事件载荷（JSON 对象字面量，可直接拼进 JS）。
    var webPayload: String? {
        var object: [String: Any] = [
            "href": rawURL,
            "ts": Date().timeIntervalSince1970,
        ]
        switch action {
        case .open(let port):
            object["type"] = "open"
            object["port"] = port
        case .session(let id):
            object["type"] = "session"
            object["sessionId"] = id
        case .unknown:
            object["type"] = "unknown"
        }
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: data, encoding: .utf8) else {
            return nil
        }
        return json
    }
}
