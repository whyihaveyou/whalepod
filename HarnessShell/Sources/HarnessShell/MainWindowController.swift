import AppKit
import WebKit

/// 主窗口：顶部工具条（服务状态）+ WKWebView（加载 harness Web UI）。
/// 视觉按 design/shell/shell-visual-spec.md 落地（token 见 ShellTokens.swift）；
/// 行为逻辑不变：状态仍全部来自 HarnessServiceManager。
final class MainWindowController: NSWindowController {

    let serviceManager: HarnessServiceManager
    private let config: ServiceConfig

    // MARK: UI 元素
    private let topBar = TopBarView()
    private let topBarHairline = ThemedView(fill: ShellTokens.Color.borderDefault)
    private let statusDot = ThemedView(fill: ShellTokens.Color.statusIdle)
    private let statusLabel = NSTextField(labelWithString: "检测中…")
    private var toggleButton = ChromeButton()
    private var reloadButton = ChromeButton()
    private var openButton = ChromeButton()
    private let overlayView = ThemedView(fill: ShellTokens.Color.bgApp)
    private let overlayIcon = NSImageView()
    private let overlayGlyph = HollowStatusDot()
    private let overlayTitle = NSTextField(labelWithString: "")
    private let overlayLabel = NSTextField(labelWithString: "")
    private let overlayCaption = NSTextField(labelWithString: "")
    private var overlayPrimaryButton = ChromeButton()
    /// 「复制最近日志」按钮（仅 .failed 态显示，其余隐藏）。
    private var copyLogButton = ChromeButton()
    /// 启动等待提示：.starting/.restarting 超过 25s 后在副文案提示可能需要几分钟。
    private var slowStartTimer: Timer?
    private var startingWaitBeganAt: Date?
    private let spinner = NSProgressIndicator()

    private var webView: WKWebView!
    private var hasLoadedInitialURL = false
    /// 页面是否已完成一次加载（didFinish 后为 true）。
    private var isPageLoaded = false
    /// 尚未消费的深链：页面未加载完成前先缓存，didFinish 时补注。
    private var pendingDeepLink: DeepLink?
    /// 上次加载的端口（用于崩溃重启后端口变化的 reload 跟随，风险 B）。
    private var lastLoadedPort: Int?

    init() {
        config = ServiceConfig.load()
        serviceManager = HarnessServiceManager(config: config)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "鲸群 WhalePod"
        // 壳视觉规范 §2：暗色默认 + 融合式标题栏（交通灯悬浮在工具条左端）
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = ShellTokens.Color.bgApp
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 800, height: 560)
        window.center()
        super.init(window: window)

        setupUI()
        bindServiceManager()
        // 启动即尝试拉起服务；若端口已被外部占用会直接识别为运行中
        serviceManager.start()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// 应用退出前清理：停止服务进程。
    func shutdown() {
        serviceManager.shutdown()
    }

    // MARK: - UI 搭建

    private func setupUI() {
        guard let contentView = window?.contentView else { return }
        contentView.wantsLayer = true

        // ---- 顶部工具条（实色 bgSurface + 底部 hairline，规范 §3） ----
        topBar.fill = ShellTokens.Color.bgSurface
        topBar.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(topBar)

        topBarHairline.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(topBarHairline)

        let toolbarStack = NSStackView()
        toolbarStack.orientation = .horizontal
        toolbarStack.alignment = .centerY
        toolbarStack.spacing = 10
        toolbarStack.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(toolbarStack)

        // 状态点（10px，规范 §3）
        statusDot.layer?.cornerRadius = ShellTokens.Metrics.statusDotSize / 2
        statusDot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            statusDot.widthAnchor.constraint(equalToConstant: ShellTokens.Metrics.statusDotSize),
            statusDot.heightAnchor.constraint(equalToConstant: ShellTokens.Metrics.statusDotSize),
        ])

        // 状态文字（13px secondary）
        statusLabel.font = ShellTokens.Font.statusText
        statusLabel.textColor = ShellTokens.Color.textSecondary
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        // 按钮（bordered / borderless，规范 §3）
        toggleButton = makeChromeButton(title: "启动服务", action: #selector(toggleService), style: .bordered)
        reloadButton = makeChromeButton(title: "刷新", action: #selector(reloadPage), style: .borderless)
        openButton = makeChromeButton(title: "浏览器打开", action: #selector(openInBrowser), style: .borderless)

        toolbarStack.addArrangedSubview(statusDot)
        toolbarStack.addArrangedSubview(statusLabel)
        toolbarStack.addArrangedSubview(NSView.spacer())
        toolbarStack.addArrangedSubview(toggleButton)
        toolbarStack.addArrangedSubview(reloadButton)
        toolbarStack.addArrangedSubview(openButton)

        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: contentView.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            topBar.heightAnchor.constraint(equalToConstant: ShellTokens.Metrics.topBarHeight),
            // 融合式标题栏：交通灯安全区 88px
            toolbarStack.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 88),
            toolbarStack.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -ShellTokens.Metrics.space4),
            toolbarStack.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            topBarHairline.leadingAnchor.constraint(equalTo: topBar.leadingAnchor),
            topBarHairline.trailingAnchor.constraint(equalTo: topBar.trailingAnchor),
            topBarHairline.bottomAnchor.constraint(equalTo: topBar.bottomAnchor),
            topBarHairline.heightAnchor.constraint(equalToConstant: 1),
        ])

        // ---- WKWebView ----
        let webConfiguration = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: webConfiguration)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(webView)

        // ---- 覆盖层（加载页 / 未运行页 / 错误页，规范 §5/§6） ----
        overlayView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(overlayView)

        let overlayStack = NSStackView()
        overlayStack.orientation = .vertical
        overlayStack.alignment = .centerX
        overlayStack.spacing = ShellTokens.Metrics.space3
        overlayStack.translatesAutoresizingMaskIntoConstraints = false
        overlayView.addSubview(overlayStack)

        // 品牌图标（dark-tile，程序绘制，规范 §5）
        overlayIcon.image = BrandIcon.darkTileImage(size: 96)
        overlayIcon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            overlayIcon.widthAnchor.constraint(equalToConstant: 96),
            overlayIcon.heightAnchor.constraint(equalToConstant: 96),
        ])

        // 未运行页的空心灰点（规范 §6）
        overlayGlyph.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            overlayGlyph.widthAnchor.constraint(equalToConstant: 20),
            overlayGlyph.heightAnchor.constraint(equalToConstant: 20),
        ])

        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.widthAnchor.constraint(equalToConstant: 28).isActive = true
        spinner.heightAnchor.constraint(equalToConstant: 28).isActive = true

        overlayTitle.font = ShellTokens.Font.errorTitle
        overlayTitle.textColor = ShellTokens.Color.textPrimary
        overlayTitle.alignment = .center

        overlayLabel.font = ShellTokens.Font.overlayBody
        overlayLabel.textColor = ShellTokens.Color.textSecondary
        overlayLabel.alignment = .center
        overlayLabel.lineBreakMode = .byWordWrapping
        overlayLabel.maximumNumberOfLines = 3
        overlayLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        overlayCaption.font = ShellTokens.Font.overlayCaption
        overlayCaption.textColor = ShellTokens.Color.textDisabled
        overlayCaption.alignment = .center

        overlayPrimaryButton = makeChromeButton(title: "启动服务", action: #selector(toggleService), style: .primary)
        copyLogButton = makeChromeButton(title: "复制最近日志", action: #selector(copyRecentLog), style: .bordered)
        copyLogButton.setAccessibilityLabel("复制最近日志")
        copyLogButton.isHidden = true

        overlayStack.addArrangedSubview(overlayIcon)
        overlayStack.addArrangedSubview(overlayGlyph)
        overlayStack.addArrangedSubview(spinner)
        overlayStack.addArrangedSubview(overlayTitle)
        overlayStack.addArrangedSubview(overlayLabel)
        overlayStack.addArrangedSubview(overlayCaption)
        overlayStack.addArrangedSubview(overlayPrimaryButton)
        overlayStack.addArrangedSubview(copyLogButton)
        // 品牌图标下方留 24px（规范 §5）
        overlayStack.setCustomSpacing(ShellTokens.Metrics.space6, after: overlayIcon)

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            overlayView.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            overlayView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            overlayView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            overlayView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            overlayStack.centerXAnchor.constraint(equalTo: overlayView.centerXAnchor),
            overlayStack.centerYAnchor.constraint(equalTo: overlayView.centerYAnchor),
            overlayStack.leadingAnchor.constraint(greaterThanOrEqualTo: overlayView.leadingAnchor, constant: 40),
            overlayStack.trailingAnchor.constraint(lessThanOrEqualTo: overlayView.trailingAnchor, constant: -40),
        ])
    }

    private enum ChromeButtonStyle {
        case bordered, borderless, primary
    }

    /// 工具条/覆盖层按钮（规范 §3/§6）：bordered = 1px 描边；borderless = 次级文字；primary = accentFill 填充。
    private func makeChromeButton(title: String, action: Selector, style: ChromeButtonStyle) -> ChromeButton {
        let button = ChromeButton(title: "", target: self, action: action)
        switch style {
        case .bordered:
            button.fill = nil
            button.borderColor = ShellTokens.Color.borderDefault
            button.titleColor = ShellTokens.Color.textPrimary
            button.font = ShellTokens.Font.buttonLabel
            button.contentInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
            button.heightAnchor.constraint(equalToConstant: ShellTokens.Metrics.buttonHeight).isActive = true
        case .borderless:
            button.fill = nil
            button.borderColor = nil
            button.titleColor = ShellTokens.Color.textSecondary
            button.font = ShellTokens.Font.buttonLabel
            button.contentInsets = NSEdgeInsets(top: 0, left: 6, bottom: 0, right: 6)
            button.heightAnchor.constraint(equalToConstant: ShellTokens.Metrics.buttonHeight).isActive = true
        case .primary:
            button.fill = ShellTokens.Color.accentFill
            button.hoverFill = ShellTokens.Color.accentFillHover
            button.borderColor = nil
            button.titleColor = ShellTokens.Color.textOnAccent
            button.font = ShellTokens.Font.buttonLabel
            button.contentInsets = NSEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
            button.heightAnchor.constraint(equalToConstant: ShellTokens.Metrics.primaryButtonHeight).isActive = true
        }
        button.setTitle(title)
        return button
    }

    // MARK: - 绑定服务状态

    private func bindServiceManager() {
        serviceManager.onStateChange = { [weak self] state in
            self?.updateUI(state: state)
        }
        serviceManager.onOutput = { [weak self] line in
            self?.appendLog(line)
        }
    }

    // MARK: - 启动等待提示 / 复制日志

    /// .starting/.restarting 期间每 15s 刷新副文案：超过 25s 提示「冷启动可能需要几分钟」，
    /// 避免用户在首次 pnpm 自愈 / npm 拉包等长冷启动时误以为卡死（「一直在转」反馈的根源）。
    private func scheduleSlowStartHint() {
        if startingWaitBeganAt == nil { startingWaitBeganAt = Date() }
        guard slowStartTimer == nil else { return }
        let timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in
            guard let self, let beganAt = self.startingWaitBeganAt else { return }
            let waited = Int(Date().timeIntervalSince(beganAt))
            guard waited >= 25 else { return }
            self.overlayCaption.stringValue = "冷启动可能需要几分钟（已等待 \(waited)s）…"
        }
        RunLoop.main.add(timer, forMode: .common)
        slowStartTimer = timer
    }

    private func cancelSlowStartHint() {
        slowStartTimer?.invalidate()
        slowStartTimer = nil
        startingWaitBeganAt = nil
    }

    /// .failed 页按钮：把最近 300 行输出（含日志目录指引）复制到剪贴板，便于测试者贴回问题。
    @objc private func copyRecentLog() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        let header = "—— WhalePod 诊断（日志目录：\(serviceManager.logDirectoryURL.path)；完整文件 shell.log / shell-prev.log）——"
        let body = serviceManager.recentLogText
        pasteboard.setString(header + "\n" + (body.isEmpty ? "（暂无输出）" : body), forType: .string)
        copyLogButton.setTitle("已复制 ✓")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.copyLogButton.setTitle("复制最近日志")
        }
    }

    private func updateUI(state: HarnessServiceManager.State) {
        if case .failed = state {
            copyLogButton.isHidden = false
        } else {
            copyLogButton.isHidden = true
        }
        switch state {
        case .running:
            statusDot.fill = ShellTokens.Color.statusActive
            stopBreathing()
            cancelSlowStartHint()
            statusLabel.attributedStringValue = runningStatusText()
            toggleButton.setTitle("停止服务")
            toggleButton.isEnabled = true
            setOverlayVisible(false)
            spinner.stopAnimation(nil)
            // 首次就绪时加载；崩溃重启后若端口变化（自动端口模式）则跟随新端口 reload（风险 B / T7）
            if hasLoadedInitialURL {
                reloadIfPortChanged()
            } else {
                loadInitialURLIfNeeded()
            }
        case .starting:
            statusDot.fill = ShellTokens.Color.statusProgress
            startBreathing()
            scheduleSlowStartHint()
            statusLabel.stringValue = "正在启动服务…"
            toggleButton.setTitle("停止服务")
            toggleButton.isEnabled = true
            // 加载页（规范 §5）：品牌图标 + spinner + 主文案 + mono 端口
            overlayIcon.isHidden = false
            overlayGlyph.isHidden = true
            overlayTitle.isHidden = true
            overlayLabel.stringValue = "正在启动服务…"
            overlayCaption.stringValue = endpointText()
            overlayCaption.isHidden = false
            overlayPrimaryButton.isHidden = true
            setOverlayVisible(true)
            spinner.startAnimation(nil)
        case .restarting(let attempt, let delay):
            // 崩溃退避重启：视觉同 starting（进行中），文案带尝试次数
            statusDot.fill = ShellTokens.Color.statusProgress
            startBreathing()
            scheduleSlowStartHint()
            statusLabel.stringValue = "服务意外退出，\(Int(delay))s 后第 \(attempt) 次重启…"
            toggleButton.setTitle("停止服务")
            toggleButton.isEnabled = true
            overlayIcon.isHidden = false
            overlayGlyph.isHidden = true
            overlayTitle.isHidden = true
            overlayLabel.stringValue = "服务意外退出，正在重启（第 \(attempt) 次尝试）…"
            overlayCaption.stringValue = endpointText()
            overlayCaption.isHidden = false
            overlayPrimaryButton.isHidden = true
            setOverlayVisible(true)
            spinner.startAnimation(nil)
        case .stopped:
            statusDot.fill = ShellTokens.Color.statusIdle
            stopBreathing()
            cancelSlowStartHint()
            statusLabel.stringValue = "服务未运行"
            toggleButton.setTitle("启动服务")
            toggleButton.isEnabled = true
            // 未运行页（规范 §6）：空心灰点 + 标题 + primary 按钮
            overlayIcon.isHidden = true
            overlayGlyph.isHidden = false
            overlayTitle.stringValue = "服务未运行"
            overlayTitle.isHidden = false
            overlayLabel.stringValue = "点击「启动服务」拉起本地服务"
            overlayCaption.isHidden = true
            overlayPrimaryButton.setTitle("启动服务")
            overlayPrimaryButton.isHidden = false
            setOverlayVisible(true)
            spinner.stopAnimation(nil)
        case .failed(let message):
            statusDot.fill = ShellTokens.Color.statusDanger
            stopBreathing()
            cancelSlowStartHint()
            statusLabel.stringValue = message
            toggleButton.setTitle("启动服务")
            toggleButton.isEnabled = true
            // 错误页（规范 §6）：标题 + 说明 + primary 重试
            overlayIcon.isHidden = true
            overlayGlyph.isHidden = true
            overlayTitle.stringValue = "⚠ 服务启动失败"
            overlayTitle.isHidden = false
            overlayLabel.stringValue = message
            overlayCaption.stringValue = "输出日志目录：\(serviceManager.logDirectoryURL.path)"
            overlayCaption.isHidden = false
            overlayPrimaryButton.setTitle("重试")
            overlayPrimaryButton.isHidden = false
            setOverlayVisible(true)
            spinner.stopAnimation(nil)
        }
        statusDot.needsDisplay = true
    }

    /// 运行中状态文字："运行中 · "（13px secondary）+ host:port（mono 12 disabled），规范 §3。
    private func runningStatusText() -> NSAttributedString {
        let head = NSAttributedString(
            string: "运行中 · ",
            attributes: [
                .font: ShellTokens.Font.statusText,
                .foregroundColor: ShellTokens.Color.textSecondary,
            ]
        )
        let endpoint = NSAttributedString(
            string: endpointText(),
            attributes: [
                .font: ShellTokens.Font.statusEndpoint,
                .foregroundColor: ShellTokens.Color.textDisabled,
            ]
        )
        let result = NSMutableAttributedString()
        result.append(head)
        result.append(endpoint)
        return result
    }

    /// host:port 展示文案：自动端口模式下取服务实际解析出的端口。
    private func endpointText() -> String {
        let port = serviceManager.resolvedPort ?? config.port
        return "\(config.host):\(port)"
    }

    /// starting 状态点呼吸动画（opacity 1↔0.45，1.6s；reduce motion 时静止）。
    private func startBreathing() {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        guard statusDot.layer?.animation(forKey: "breathing") == nil else { return }
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = 1.0
        animation.toValue = 0.45
        animation.duration = ShellTokens.Metrics.breathingDuration
        animation.autoreverses = true
        animation.repeatCount = .infinity
        statusDot.layer?.add(animation, forKey: "breathing")
    }

    private func stopBreathing() {
        statusDot.layer?.removeAnimation(forKey: "breathing")
        statusDot.layer?.opacity = 1
    }

    /// 覆盖层淡入淡出（durationBase）。
    private func setOverlayVisible(_ visible: Bool) {
        if visible {
            overlayView.isHidden = false
            NSAnimationContext.runAnimationGroup { context in
                context.duration = ShellTokens.Metrics.durationBase
                overlayView.animator().alphaValue = 1
            }
        } else {
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = ShellTokens.Metrics.durationBase
                overlayView.animator().alphaValue = 0
            }, completionHandler: { [weak self] in
                // 淡出期间若状态又切回可见，alpha 已回升，不应再隐藏
                guard let self, self.overlayView.alphaValue == 0 else { return }
                self.overlayView.isHidden = true
            })
        }
    }

    // MARK: - 深链

    /// 深链入口（AppDelegate 路由至此）：聚焦窗口 + 解析结果桥接给 Web UI。
    /// 覆盖 K3-1 的最小实现，落地完整宿主行为：
    ///   - 聚焦/激活应用窗口
    ///   - `.open(port)`：直接加载对应实例页面（与最小实现一致）
    ///   - `.session(id)`：交给 Web 端按 sessionId 路由
    ///   - 桥接注入 `window.__DSH_BOOT__`（含最后深链 `__DSH_LAST_LINK__`）+ 派发
    ///     `dsh:deeplink`/`dsh-deeplink` 双事件
    /// 页面未加载完成时先缓存，`didFinish` 回调补注。
    func handle(deepLink: DeepLink) {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        appendLog("→ 深链 \(deepLink.rawURL)")

        // 确保服务在跑：未启动则拉起来（Web 端 ready 后再按 port/session 路由）
        switch serviceManager.state {
        case .stopped, .failed:
            serviceManager.start()
        default:
            break
        }

        // `.open` 显式换实例页：
        //   - 固定端口模式：用 deep-link 传入的端口（或配置的有效端口）
        //   - 自动端口模式：必须以 serviceManager.resolvedPort 为准，忽略/回落 deep-link 里
        //     可能过时或不匹配的端口（风险 A / T4.3）
        if case .open(let explicitPort) = deepLink.action {
            let targetPort: Int? = config.isAutoPort
                ? serviceManager.resolvedPort
                : (explicitPort != 0 ? explicitPort : serviceManager.resolvedPort)
            if let url = config.url(port: targetPort) {
                hasLoadedInitialURL = true
                lastLoadedPort = targetPort   // 记录，供崩溃重启端口跟随（风险 B）比对
                webView.load(URLRequest(url: url))
                appendLog("→ 深链 open 加载 \(url.absoluteString)")
            }
        }

        // 页面已加载完则立即注入，否则缓存等 didFinish 补注（冷启动场景）
        if isPageLoaded {
            pendingDeepLink = nil
            bridgeDeepLinkToWeb(deepLink)
        } else {
            pendingDeepLink = deepLink
        }
    }

    /// 把深链解析结果注入 WKWebView：`window.__DSH_BOOT__` + `__DSH_LAST_LINK__` + CustomEvent。
    private func bridgeDeepLinkToWeb(_ deepLink: DeepLink) {
        guard let payload = deepLink.webPayload else { return }
        let js = """
        (function () {
          try {
            if (!window.__DSH_BOOT__) window.__DSH_BOOT__ = {};
            Object.assign(window.__DSH_BOOT__, \(payload));
            window.__DSH_LAST_LINK__ = \(payload);
            window.dispatchEvent(new CustomEvent('dsh:deeplink', { detail: \(payload) }));
            window.dispatchEvent(new CustomEvent('dsh-deeplink', { detail: \(payload) }));
          } catch (e) {
            console.error('[harness-shell] deeplink bridge failed', e);
          }
        })();
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private func loadInitialURLIfNeeded() {
        guard !hasLoadedInitialURL else { return }
        hasLoadedInitialURL = true
        guard let url = config.url(port: serviceManager.resolvedPort) else { return }
        lastLoadedPort = serviceManager.resolvedPort
        webView.load(URLRequest(url: url))
        appendLog("→ 加载 \(url.absoluteString)")
    }

    /// 崩溃重启后：若自动端口模式下 resolvedPort 发生变化，跟随新端口重新加载。
    /// 固定端口模式端口不变，无需 reload（风险 B / T7）。
    private func reloadIfPortChanged() {
        guard config.isAutoPort,
              let newPort = serviceManager.resolvedPort,
              newPort != lastLoadedPort else { return }
        lastLoadedPort = newPort
        guard let url = config.url(port: newPort) else { return }
        webView.load(URLRequest(url: url))
        appendLog("→ 服务重启端口变化，reload \(url.absoluteString)")
    }

    private func appendLog(_ line: String) {
        // MVP：输出到 stderr（即时刷盘，Xcode 控制台可见）。后续接入视觉/日志面板时在此处汇入。
        fputs("[harness-shell] \(line)\n", stderr)
        fflush(stderr)
    }

    // MARK: - 按钮动作

    @objc private func toggleService() {
        switch serviceManager.state {
        case .running, .starting, .restarting:
            serviceManager.stop()
        case .stopped, .failed:
            serviceManager.start()
        }
    }

    @objc private func reloadPage() {
        webView.reload()
    }

    @objc private func openInBrowser() {
        guard let url = config.url(port: serviceManager.resolvedPort) else { return }
        NSWorkspace.shared.open(url)
    }
}

// MARK: - WKNavigationDelegate

extension MainWindowController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        statusLabel.stringValue = "页面加载失败：\(error.localizedDescription)"
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isPageLoaded = true
        // 冷启动补注：页面加载完成后若仍有未消费的深链，再注入一次
        if let link = pendingDeepLink {
            pendingDeepLink = nil
            bridgeDeepLinkToWeb(link)
        }
    }
}

// MARK: - 壳视觉组件（规范 §3；仅本文件使用）

/// 动态色填充视图：layer 背景跟随 appearance 解析，避免直接缓存动态色的 cgColor。
private class ThemedView: NSView {
    var fill: NSColor? {
        didSet { needsDisplay = true }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
    }

    convenience init(fill: NSColor?) {
        self.init(frame: .zero)
        self.fill = fill
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func updateLayer() {
        layer?.backgroundColor = fill?.cgColor
    }
}

/// 顶部工具条：实色填充 + 允许按住拖动窗口（融合式标题栏）。
private final class TopBarView: ThemedView {
    override var mouseDownCanMoveWindow: Bool { true }
}

/// 未运行页的空心状态点（20px，2px 描边，textDisabled）。
private final class HollowStatusDot: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 2
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func updateLayer() {
        layer?.borderColor = ShellTokens.Color.statusIdle.cgColor
        layer?.backgroundColor = nil
    }
}

/// 壳按钮：支持自定义填充/描边/文字色与 hover 填充（bordered / borderless / primary 三档）。
private final class ChromeButton: NSButton {
    var fill: NSColor? { didSet { needsDisplay = true } }
    var hoverFill: NSColor?
    var borderColor: NSColor? { didSet { needsDisplay = true } }
    var titleColor: NSColor = .white { didSet { applyTitle() } }
    var contentInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)

    private var hovering = false
    private var buttonTitle = ""

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = ShellTokens.Metrics.radiusMD
        font = ShellTokens.Font.buttonLabel
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    convenience init(title: String, target: AnyObject?, action: Selector?) {
        self.init(frame: .zero)
        self.target = target
        self.action = action
        setTitle(title)
    }

    func setTitle(_ title: String) {
        self.buttonTitle = title
        applyTitle()
    }

    private func applyTitle() {
        attributedTitle = NSAttributedString(
            string: buttonTitle,
            attributes: [.font: font ?? ShellTokens.Font.buttonLabel, .foregroundColor: titleColor]
        )
    }

    override func updateLayer() {
        let activeFill = (hovering ? (hoverFill ?? fill) : fill)
        layer?.backgroundColor = activeFill?.cgColor
        layer?.borderWidth = borderColor == nil ? 0 : 1
        layer?.borderColor = borderColor?.cgColor
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways],
            owner: self,
            userInfo: nil
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        needsDisplay = true
    }

    override var intrinsicContentSize: NSSize {
        var size = attributedTitle.size()
        size.width += contentInsets.left + contentInsets.right
        size.height = max(size.height, ShellTokens.Metrics.buttonHeight)
        return size
    }
}

/// 品牌图标：1:1 移植 design/assets/icon-dark-tile.svg 的几何与渐变（Core Graphics 程序绘制，无资源文件）。
/// NSImage(flipped: true) 使坐标系与 SVG 一致（y 向下，1024 画板）。
private enum BrandIcon {
    static func darkTileImage(size: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let s = rect.width / 1024
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
            func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> CGColor {
                CGColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: a)
            }
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            func gradient(_ colors: [CGColor]) -> CGGradient {
                CGGradient(colorsSpace: colorSpace, colors: colors as CFArray, locations: [0, 1])!
            }

            // 底块：深靛蓝渐变圆角方块（#1B2140 → #12152B，135°）+ 顶部 rim 高光
            let tileRect = CGRect(x: 102 * s, y: 102 * s, width: 820 * s, height: 820 * s)
            let tilePath = CGPath(roundedRect: tileRect, cornerWidth: 186 * s, cornerHeight: 186 * s, transform: nil)
            ctx.saveGState()
            ctx.addPath(tilePath)
            ctx.clip()
            ctx.drawLinearGradient(
                gradient([rgb(0x1B, 0x21, 0x40), rgb(0x12, 0x15, 0x2B)]),
                start: pt(102, 102), end: pt(922, 922), options: []
            )
            ctx.drawLinearGradient(
                gradient([rgb(255, 255, 255, 0.14), rgb(255, 255, 255, 0.04)]),
                start: pt(512, 102), end: pt(512, 922), options: []
            )
            ctx.restoreGState()

            // "W" 节点连线（48px 圆头描边 → 转为可填充轮廓）
            let wire = CGMutablePath()
            wire.move(to: pt(272, 390))
            wire.addLine(to: pt(402, 630))
            wire.addLine(to: pt(512, 455))
            wire.addLine(to: pt(622, 630))
            wire.addLine(to: pt(752, 390))
            let wireOutline = wire.copy(strokingWithWidth: 48 * s, lineCap: .round, lineJoin: .round, miterLimit: 10)

            // 四个圆点 + 中央菱形火花
            let dots = CGMutablePath()
            for (cx, cy) in [(272, 390), (402, 630), (622, 630), (752, 390)] as [(CGFloat, CGFloat)] {
                dots.addEllipse(in: CGRect(x: (cx - 46) * s, y: (cy - 46) * s, width: 92 * s, height: 92 * s))
            }
            dots.move(to: pt(512, 397))
            dots.addLine(to: pt(570, 455))
            dots.addLine(to: pt(512, 513))
            dots.addLine(to: pt(454, 455))
            dots.closeSubpath()

            // 图形渐变填充（#8FA4FF → #A98BFF，135°）
            ctx.saveGState()
            ctx.addPath(wireOutline)
            ctx.addPath(dots)
            ctx.clip()
            ctx.drawLinearGradient(
                gradient([rgb(0x8F, 0xA4, 0xFF), rgb(0xA9, 0x8B, 0xFF)]),
                start: pt(272, 390), end: pt(752, 630), options: []
            )
            ctx.restoreGState()

            return true
        }
    }
}

// MARK: - 工具

private extension NSView {
    /// 弹性占位视图（把按钮推到工具条右侧）。
    static func spacer() -> NSView {
        let view = NSView()
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
}
