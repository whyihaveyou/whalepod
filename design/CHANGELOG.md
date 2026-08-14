# 设计变更说明 — token 统一（team-panel × visual-identity）

日期：2026-08-14 · 执行：视觉-K3-1 · 任务：#019ffffb

## 1. 文件归位

- `visual-identity.md` 与 `assets/`（3 份 SVG + 3 份 PNG 导出）从 `deepseek-harness/design/` 移至 `/design/`。
- clone（`deepseek-harness/`，上游仓库）内不再残留产品设计文件，`git status` 已确认干净。

## 2. 唯一 token 源

新增 `design/tokens/`：

- `tokens.css` — CSS variables，`:root` = 深色默认，`[data-theme="light"]` = 浅色覆盖；内置 `prefers-reduced-motion` 降级。
- `tokens.json` — 机器可读版，dark/light 双值，供实现端/工具链消费。

桌面壳与团队面板共用此源；`team-panel/design-tokens.md` 改为纯消费规范（旧 `--dfh-*` 占位 → 正式 token 映射表 + 组件速查），不再自定义色值。

## 3. 主题默认冲突的结论

**统一为暗色优先（dark-first）。** 理由：agent 工作站是长时间盯屏工具，深色降低长时间使用的视觉负担；团队面板 v0.1 即按此设计。已同步修改：

- `visual-identity.md` §5：新增 dark-first 结论段；§5.1/§5.2 表格互换（深色为默认，浅色为 `data-theme="light"` 可选项）；§5.4 工程片段改为指向统一 token 源。
- 切换机制不变：只翻 `data-theme` 属性，组件零改码。

## 4. 关键 token 变更（相对 team-panel v0.1 草稿）

| 项 | 旧（占位） | 新（正式） |
|---|---|---|
| 品牌/强调色 | `#4C8DFF` | `--brand-primary`：dark `#8FA4FF` / light `#4D6BFE` |
| working / in_progress | 绿 `#34C77B` | **`--accent-spark` `#22D3EE`**（呼应标志"中央菱形=活跃 agent"） |
| completed | 蓝 | **`--success`**（dark `#4ADE80`），回归通用语义 |
| spawning / typing | 自造紫 `#B48CF2` | `--brand-violet` `#7A4DFF` |
| warning / danger | 自造值 | visual-identity 语义色（dark `#FBBF24` / `#F87171`） |
| 中性灰阶 | 自造 10 级 | visual-identity 主题表面（bg-app/surface/sunken + 面板扩展 bg-elevated） |
| 字体 | 系统栈 | Inter + PingFang SC；等宽 JetBrains Mono 优先；展示标题 Space Grotesk |
| 字阶基准 | 13px | **14px**（1.25 比例，对齐 visual-identity） |
| 圆角 | 4/6/10 | 4/6/10 + 模态 14（`--radius-xl`） |
| 阴影（暗色） | 投影分层 | 不投影，靠 `bg-surface` + `border-default/strong` 分层 |

无值变化并入统一源的：间距（4px 基栅）、动效时长/缓动、结构尺寸（titlebar/statusbar/栏宽）。

## 5. 其他同步

- `wireframes.md`：状态点颜色描述更新；标题栏图标位明确为 `assets/icon-mono.svg`（`currentColor` 绑 `--text-secondary`）。
- `interaction-spec.md` §9：待对齐项 1、2 标记收口；空态插图风格仍待插画规范（不阻塞实现）。
- `team-panel/README.md`：版本 v0.2，文档索引补 visual-identity 与 tokens/。
- `components/`（视觉-K3-2 的组件规范，8 份）：全部 token 引用从旧 `--dfh-*` 迁移到统一命名（`--dfh-text-md`→`--text-base`、`--dfh-text-lg`→`--text-md`、`--dfh-bg-pane`→`--bg-surface`，其余去前缀同义映射），失效的 px 注解同步修正；权威指针改指 `tokens/tokens.css`。

## 6. 遗留

- 空态插图风格规范（视觉-K3-2 后续插画体系）。
- PNG 栅格导出目前随 SVG 一并归档；正式导出流程（1024→16 全尺寸）待构建管线接入。

## 7. 补丁（2026-08-14，K3-2 对齐）

- 新增 `--accent-fill` / `--accent-fill-hover` / `--text-on-accent`：暗色下主按钮填充统一用浅色同款 `#4D6BFE` + 白字（~4.3:1），不用亮版 `#8FA4FF` 做填充底（白字仅 ~2.3:1）。`#8FA4FF` 仅限暗色文字/链接/选中态。
- `components/buttons.md` primary 变体与 hover 已同步指向 fill 系 token。

## 8. 桌面壳视觉接入（2026-08-14，任务 #01a000cd）

- 新增 `design/shell/shell-visual-spec.md`：HarnessShell 原生 chrome（窗口/工具条/加载页/未运行页/错误页/toast）视觉规范，含 CSS var → Swift 映射表与占位→正式差异清单。
- 新增 `design/shell/ShellTokens.swift`：零依赖 drop-in token 常量（dark/light 动态色、Inter/JetBrains Mono 回落链、尺寸/圆角/间距/动效），`swiftc -typecheck` 通过；复制进 `Sources/HarnessShell/` 即用。
- 服务状态语义与团队面板对齐：running=spark 青、starting=violet（呼吸）、stopped=灰（不再用红）、failed=danger 红。

## 9. 壳视觉落地进源码（2026-08-14，任务 #01a000d2）

- `ShellTokens.swift` 已复制进 `HarnessShell/Sources/HarnessShell/`；`MainWindowController.swift` 按 §9 差异清单重写 chrome：弃 vibrancy → 实色 `bgSurface` + hairline；融合式标题栏（fullSizeContentView + 交通灯安全区 88px + 工具条可拖动窗口）；状态点 10px + starting/restarting 呼吸动画（respect reduce motion）；加载/未运行/错误三态覆盖层；品牌图标为 icon-dark-tile.svg 的 1:1 Core Graphics 程序绘制（零资源文件，不改 Package.swift）。
- 协同适配：Flash-2 的 `config.url(port:)`（自动端口，调用点传 `serviceManager.resolvedPort`）与 Flash-3 的 `.restarting(attempt:delay:)` 状态（视觉同 starting，文案带尝试次数）已接入；`handle(deepLink:)` 最小桥接（webPayload → window CustomEvent，`.open(port)` 直接加载）补在 MainWindowController，因 AppDelegate 已调用——完整深链行为仍归 Flash-3 替换。
- `swift build` 通过。

## 10. QA 修订：idle/offline 状态灰对比度（2026-08-14，K3-2 报）

- 缺陷：`--status-idle`/`--status-offline` 钉在 `--text-disabled`（dark #565C78），在 `bg-surface` 上仅 ~2.7:1——状态文字不达 4.5:1，图形也低于 3:1。
- 决议：idle/offline 状态点/图形改专用灰（dark `#6E7692` ~3.9:1、light `#8A90A6` ~3.2:1）；**状态文字一律 `--text-secondary` 起，禁用 disabled 色**。idle 实心 / offline 空心的形状区分不变。
- 同步：`tokens.css`、`tokens.json`、`team-panel/design-tokens.md`（新增状态文字规则）、两份 `ShellTokens.swift`（design/shell + HarnessShell 源码），`swift build` 复验通过。

## 11. 新增 --text-tertiary（2026-08-15，K3-2 QA §6 建议，token owner 采纳）

- K3-2 QA 复审确认 §10 全部达标（dark 3.72–4.2:1 / light 3.17:1），并建议恢复三级文字层次。
- 新增 `--text-tertiary`：dark `#7E86A0`（bg-surface ~4.9:1）/ light `#6B7280`（白底 ~4.8:1），卡 AA 4.5:1 下限。用途：时间戳、系统条、任务 id 等 meta 文字；`--text-disabled` 收缩为仅 placeholder/装饰用途。
- 同步：tokens.css、tokens.json、两份 ShellTokens.swift（新增 `textTertiary`）、team-panel/design-tokens.md 状态文字规则补注。`swift build` 复验通过。

## 12. light idle/offline 灰全表面校准（2026-08-15，K3-2 边界数据）

- K3-2 实测：light `#8A90A6` 仅对纯白达标（3.17:1），在 bg-app（2.99）/bg-sunken（2.81）跌破图形 3:1 线。
- 采纳其建议微调为 `#848BA1`（sunken ~3.0、白底 ~3.4，留边距），dark `#6E7692` 不变。
- 同步：tokens.css、tokens.json、两份 ShellTokens.swift。`swift build` 复验通过。

## 13. OOBE-M1 首启向导视觉规范（2026-08-15，任务 #01a00113）

- 新增 `design/shell/oobe-visual-spec.md`：S0 运行时检测（原生覆盖层 + 安装进度变体）→ S1 Provider Picker（R1 注入层，2 列文字卡 + 搜索，参考 dsh-desktop patch 形态）→ S2 API key 表单（mono password 输入 + 必备安全提示 + 完整状态机）→ S3 完成（单行确认，无庆祝页）。
- 全部元素绑定 tokens.css 现有 token，**零新增 token、零硬编码**；附 WKUserScript 注入约束（注入层 vs 原生兜底分工、Shadow DOM/类名前缀隔离、`dfhOobe.mount/unmount` 双向契约、reduced-motion）。
- 待 M1 实施确认项 3 条（Credentials loopback 契约、DOM 锚点、安装进度事件源）已列 §9。

## 14. OOBE 注入样式表生成物（2026-08-15，leader 预备要求）

- 新增 `design/shell/gen-oobe-tokens.py`：从 tokens.css 的 dark `:root` 生成注入层 token 环境（作用域 `:host, .dfh-oobe-root`，含 reduced-motion 归零）。
- 产物 `design/shell/oobe-inject-tokens.css`：83 行声明 + 3 个动效变量降级；头部标注 GENERATED 勿手改。M1 实施的 WKUserScript 直接内联此文件。

## 15. OOBE 规范 v1.1（2026-08-15，K3-2 复核修订）

- 输入框高度 h36 → `--input-h` 32px 全局对齐，不引入第三档密度。
- S1 卡片单选语义：aria-pressed → `radiogroup`/`radio` + `aria-checked` + roving tabindex（方向键移动即选中），选中进 S2 交互不变。
- 强制 dark 加护栏：挂载前检测 harness 页面主题，light（或不可识别）时不挂载引导、落回原生设置路径；M2 生成脚本补 light 变体后解除。
- 小项：「更换」按钮最小点击区 28×28px。§8 检查单同步更新。
