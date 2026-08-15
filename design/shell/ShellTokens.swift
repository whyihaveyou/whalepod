import AppKit

/// WhalePod 设计 token — AppKit 落地常量。
/// 唯一权威源：design/tokens/tokens.css（暗色优先）。
/// 规范文档：design/shell/shell-visual-spec.md。
/// 本文件为零依赖 drop-in：复制进 Sources/HarnessShell/ 即可用。
/// 颜色均为 dark/light 动态色；MVP 期窗口固定 .darkAqua 时取 dark 值。
enum ShellTokens {

    // MARK: - 颜色（dark / light 动态）

    enum Color {
        /// --bg-app：窗口/覆盖层背景
        static let bgApp = dynamic(dark: 0x0D1020, light: 0xF7F8FC)
        /// --bg-surface：顶部工具条、卡片
        static let bgSurface = dynamic(dark: 0x161A2E, light: 0xFFFFFF)
        /// --bg-sunken：日志/错误详情块
        static let bgSunken = dynamic(dark: 0x0A0D1A, light: 0xEFF1F8)
        /// --bg-elevated：toast、浮层
        static let bgElevated = dynamic(dark: 0x1D2340, light: 0xFFFFFF)

        /// --text-primary
        static let textPrimary = dynamic(dark: 0xE8EAF6, light: 0x1A1D2E)
        /// --text-secondary
        static let textSecondary = dynamic(dark: 0x9AA0BE, light: 0x5A6072)
        /// --text-tertiary：meta 文字（时间戳/系统条/id），卡 AA 4.5:1 下限
        static let textTertiary = dynamic(dark: 0x7E86A0, light: 0x6B7280)
        /// --text-disabled（仅 placeholder/装饰，不做正文级文字）
        static let textDisabled = dynamic(dark: 0x565C78, light: 0x9BA1B5)

        /// --border-default
        static let borderDefault = dynamic(dark: 0x262B45, light: 0xE2E5F0)
        /// --border-strong
        static let borderStrong = dynamic(dark: 0x3A4066, light: 0xC9CEDF)

        /// --accent：文字/链接/选中（暗色亮版）
        static let accent = dynamic(dark: 0x8FA4FF, light: 0x4D6BFE)
        /// --accent-fill：主按钮填充底（两主题同 #4D6BFE；暗色不用亮版填充，白字对比度不足）
        static let accentFill = dynamic(dark: 0x4D6BFE, light: 0x4D6BFE)
        /// --accent-fill-hover
        static let accentFillHover = dynamic(dark: 0x5B7CFF, light: 0x3B5BEE)
        /// --text-on-accent：填充按钮上的文字
        static let textOnAccent = NSColor.white

        /// --accent-spark：活跃/在线指示（logo 中央菱形语义）
        static let spark = dynamic(dark: 0x22D3EE, light: 0x22D3EE)
        /// --brand-violet：进行中指示（spawning/starting）
        static let violet = dynamic(dark: 0x7A4DFF, light: 0x7A4DFF)

        /// --success（仅一次性完成反馈，不做常态状态点）
        static let success = dynamic(dark: 0x4ADE80, light: 0x16A34A)
        /// --warning
        static let warning = dynamic(dark: 0xFBBF24, light: 0xD97706)
        /// --danger
        static let danger = dynamic(dark: 0xF87171, light: 0xDC2626)

        // 服务状态语义（shell-visual-spec §4，与团队面板全局一致）
        /// running：活跃/在线
        static let statusActive = spark
        /// starting：进行中
        static let statusProgress = violet
        /// stopped：空闲/离线（专用灰，全表面 ≥3:1；旧值 textDisabled 仅 ~2.7:1，QA 否决。
        /// 状态文字用 textSecondary，不用 disabled 色）
        static let statusIdle = dynamic(dark: 0x6E7692, light: 0x848BA1)
        /// failed
        static let statusDanger = danger
    }

    // MARK: - 字体（Inter → 系统回落；JetBrains Mono → 系统等宽回落）

    enum Font {
        /// UI/正文：Inter（西文）+ PingFang SC（中文，系统混排天然支持），未安装 Inter 时回落系统字体。
        static func ui(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
            if let inter = NSFont(name: "Inter", size: size) {
                return inter
            }
            return NSFont.systemFont(ofSize: size, weight: weight)
        }

        /// 等宽：JetBrains Mono，回落系统等宽。用于 host:port、日志、错误详情。
        static func mono(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
            if let jb = NSFont(name: "JetBrains Mono", size: size) {
                return jb
            }
            return NSFont.monospacedSystemFont(ofSize: size, weight: weight)
        }

        // 壳内常用档位（规范 §3/§5/§6）
        static let statusText = ui(13)                       // 工具条状态文字
        static let statusEndpoint = mono(12)                 // 运行中端口号
        static let overlayBody = ui(13)                      // 加载/错误页说明
        static let overlayCaption = mono(12)                 // 加载页 host:port
        static let errorTitle = ui(15, weight: .semibold)    // 错误页标题
        static let errorDetail = mono(12)                    // 错误详情块
        static let buttonLabel = ui(13, weight: .medium)     // 按钮
    }

    // MARK: - 尺寸 / 圆角 / 间距 / 动效

    enum Metrics {
        // 结构
        static let topBarHeight: CGFloat = 48
        static let statusDotSize: CGFloat = 10
        static let buttonHeight: CGFloat = 28          // 工具条按钮
        static let primaryButtonHeight: CGFloat = 32   // 错误页主按钮

        // 圆角（--radius-md / --radius-lg）
        static let radiusMD: CGFloat = 6
        static let radiusLG: CGFloat = 10

        // 间距（--space-1…6，4px 基栅）
        static let space1: CGFloat = 4
        static let space2: CGFloat = 8
        static let space3: CGFloat = 12
        static let space4: CGFloat = 16
        static let space6: CGFloat = 24

        // 动效（--duration-fast / --duration-base；尊重 reduce motion）
        static let durationFast: TimeInterval = 0.10
        static let durationBase: TimeInterval = 0.16
        /// starting 状态点呼吸（opacity 1↔0.45，1.6s）
        static let breathingDuration: TimeInterval = 1.6
    }

    // MARK: - 内部工具

    /// 由 0xRRGGBB 构造 dark/light 动态色。
    private static func dynamic(dark: UInt32, light: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        }
    }
}

private extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            calibratedRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}
