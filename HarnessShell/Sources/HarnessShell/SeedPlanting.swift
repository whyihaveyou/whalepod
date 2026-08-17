import Foundation

/// OOB-7：首启种子种植——把盒内 `Resources/dsh_home`（honeycomb/面板 insert patch +
/// 共享层 node_modules 指针）幂等合并进运行时 DSH_HOME（`WhalePod/harness/`）。
///
/// 背景（OOB-F3 根因）：build 期把种子预置进 .app（build-app.sh 3c/3e），但从未种植到
/// 用户 DSH_HOME（HarnessServiceManager.mergedEnvironment 无条件注入用户本地 DSH_HOME），
/// 开箱断言 c/d/e（种子可见 + honeycomb 可解析 + patch 生效）全挂。
///
/// 语义（与 Migration 同风格，失败不硬崩、下次启动重试）：
/// - 幂等 marker：`harness/seed-planted` 内容 = 上次种植的盒路径；路径一致 → 跳过。
/// - 不覆盖：`profiles/web/*` 配置只补缺——用户已有 profile 改动永远优先（升级路径：
///   已有 web profile 不含 honeycomb 时本层不代改 patch，属后续「合并 patch」范围）。
/// - node_modules 是「盒指针层」：首启整体拷贝，symlink 目标重写为当前盒
///   `Contents/Resources/node_modules` 绝对路径（相对链在用户家目录下会断；dsh heal
///   只修自有包链、不修 honeycomb/面板链）；盒移动后重跑只修指向旧盒的链。
/// - symlink 目标含空格无需转义（文件系统原始字符串，createSymbolicLink 直接可用）。
enum SeedPlanting {

    static let markerName = "seed-planted"

    /// 启动早期调用一次（Migration 之后、服务启动之前、拿到单例锁之后）。
    static func runFirstLaunchSeedIfNeeded() {
        guard let seedURL = bundledSeedURL(),
              FileManager.default.fileExists(atPath: seedURL.path) else { return }
        let home = DataRoot.harnessHomeURL
        // marker 内容 = 上次种植的盒路径；一致 → 已种（幂等跳过）
        if let planted = try? String(contentsOf: home.appendingPathComponent(markerName), encoding: .utf8),
           planted.trimmingCharacters(in: .whitespacesAndNewlines) == seedURL.path {
            return
        }
        do {
            try plant(seed: seedURL, home: home)
            try seedURL.path.write(to: home.appendingPathComponent(markerName),
                                   atomically: true, encoding: .utf8)
            try? writeLog("seeded: \(seedURL.path) → \(home.path)")
        } catch {
            try? writeLog("SEED FAILED: \(error.localizedDescription)")
        }
    }

    /// 盒内种子：`Contents/Resources/dsh_home`。
    static func bundledSeedURL() -> URL? {
        guard let res = Bundle.main.resourceURL else { return nil }
        return res.appendingPathComponent("dsh_home", isDirectory: true)
    }

    /// 当前盒的 Resources 目录（盒指针层目标基准）。
    private static func boxedResourcesPath() -> String {
        Bundle.main.resourceURL?.path ?? ""
    }

    // MARK: - 种植

    private static func plant(seed: URL, home: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: home, withIntermediateDirectories: true)
        // 种子顶层只有 profiles/；其余条目按「只补缺」拷贝（未来种子扩展兼容）
        for item in try fm.contentsOfDirectory(at: seed, includingPropertiesForKeys: nil) {
            let destItem = home.appendingPathComponent(item.lastPathComponent)
            if item.lastPathComponent == "profiles" {
                try mergeProfiles(from: item, to: destItem)
            } else if !fm.fileExists(atPath: destItem.path) {
                try fm.copyItem(at: item, to: destItem)
            }
        }
    }

    /// profiles 合并：web/* 只补缺；node_modules 指针层首启拷贝 / 盒移动时修链。
    private static func mergeProfiles(from src: URL, to dest: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        for item in try fm.contentsOfDirectory(at: src, includingPropertiesForKeys: nil) {
            let destItem = dest.appendingPathComponent(item.lastPathComponent)
            if item.lastPathComponent == "node_modules" {
                if fm.fileExists(atPath: destItem.path) {
                    try repairBoxPointers(in: destItem)       // 已有层：修旧盒链
                } else {
                    try copyPointerLayer(from: item, to: destItem) // 首启：整体拷贝
                }
            } else if !fm.fileExists(atPath: destItem.path) {
                try fm.copyItem(at: item, to: destItem)       // 配置只补缺，不覆盖
            }
        }
    }

    /// 首启整体拷贝指针层：每个 symlink 目标重写为「当前盒 Resources/node_modules」绝对路径。
    private static func copyPointerLayer(from src: URL, to dest: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        for item in try fm.contentsOfDirectory(at: src, includingPropertiesForKeys: nil) {
            let destItem = dest.appendingPathComponent(item.lastPathComponent)
            if fm.fileExists(atPath: destItem.path) { continue }
            let values = try? item.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
            if values?.isSymbolicLink == true {
                // 源链在盒内解析（种子在盒里）→ 取 node_modules/ 之后的后缀
                guard let suffix = boxSuffix(of: item) else { continue }
                try fm.createSymbolicLink(at: destItem,
                                          withDestinationURL: URL(fileURLWithPath: boxedResourcesPath() + "/node_modules/" + suffix))
            } else if values?.isDirectory == true {
                try copyPointerLayer(from: item, to: destItem)
            }
        }
    }

    /// 修复已有指针层里指向旧盒的链（递归）：目标含 `/Contents/Resources/node_modules/`
    /// → 重写为当前盒（dsh 自有包链 dsh heal 会自理，本层兜 honeycomb/面板等非 manifest 链）。
    private static func repairBoxPointers(in dir: URL) throws {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
        for item in items {
            let values = try? item.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
            if values?.isSymbolicLink == true {
                let target = (try? fm.destinationOfSymbolicLink(atPath: item.path)) ?? ""
                if target.contains("/Contents/Resources/node_modules/"),
                   let suffix = boxSuffix(of: item) {
                    try? fm.removeItem(at: item)
                    try? fm.createSymbolicLink(at: item,
                                               withDestinationURL: URL(fileURLWithPath: boxedResourcesPath() + "/node_modules/" + suffix))
                }
            } else if values?.isDirectory == true {
                try repairBoxPointers(in: item)
            }
        }
    }

    /// 从 symlink 的解析结果取「/Contents/Resources/node_modules/ 之后」的包后缀；非盒链返回 nil。
    private static func boxSuffix(of link: URL) -> String? {
        let resolved = link.resolvingSymlinksInPath().path
        guard let range = resolved.range(of: "/Contents/Resources/node_modules/") else { return nil }
        return String(resolved[range.upperBound...])
    }

    // MARK: - 日志

    private static func writeLog(_ line: String) throws {
        try FileManager.default.createDirectory(at: DataRoot.logsDirURL, withIntermediateDirectories: true)
        let entry = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: DataRoot.shellLogURL) {
            defer { try? handle.close() }
            handle.seekToEndOfFile()
            try? handle.write(contentsOf: Data(entry.utf8))
        } else {
            try entry.write(to: DataRoot.shellLogURL, atomically: true, encoding: .utf8)
        }
    }
}
