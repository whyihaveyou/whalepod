# HarnessShell 桌面壳视觉规范

> 版本：v1.0 · 作者：视觉-K3-1 · 任务：#01a000cd
> 范围：**仅壳原生 chrome**——窗口/标题栏/顶部工具条、启动加载页、服务未启动页、错误页、状态提示。WebView 内的 harness Web UI 视觉不在此范围（团队面板线负责）。
> token 源：[`../tokens/tokens.css`](../tokens/tokens.css)（暗色优先）。本规范不定义新色值。
> 落地物料：[`ShellTokens.swift`](./ShellTokens.swift)，可直接复制进 `HarnessShell/Sources/HarnessShell/`。

---

## 1. 总体原则

- **暗色默认**：窗口 `appearance = .darkAqua`，不跟随系统切换（MVP 期）；light 值已在 `ShellTokens.swift` 用动态颜色备好，后续开放跟随系统只需改 appearance。
- **平面化，不用 vibrancy**：品牌色底要求确定性，`NSVisualEffectView` 的混色不可控。顶部工具条用实色 `surface` + 1px 底部分隔线，不用 `.headerView` material。
- **状态语义与团队面板一致**：服务状态点直接复用面板状态语义（见 §4），用户在壳和面板看到的颜色语言是同一套。

## 2. 窗口 chrome

| 项 | 规格 |
|---|---|
| 窗口背景 | `ShellTokens.Color.bgApp`（dark `#0D1020`） |
| 标题栏 | 与内容融合：`titleVisibility = .hidden`、`titlebarAppearsTransparent = true`、`styleMask += .fullSizeContentView`；交通灯按钮悬浮在顶部工具条左端（见 §3 布局） |
| 尺寸 | 默认 1200×800，最小 800×560（现状保留） |
| 圆角/阴影 | 交给系统窗口，壳内不额外绘制 |

## 3. 顶部工具条（服务状态栏）

```
┌──────────────────────────────────────────────────────────────────┐
│ ● 运行中 · 127.0.0.1:4096                    [停止服务][刷新][浏览器打开]│ ← 48px
├──────────────────────────────────────────────────────────────────┤ ← 1px borderDefault
```

| 部位 | 规格 |
|---|---|
| 容器 | 高 48px，bg `bgSurface`（dark `#161A2E`），底部 1px `borderDefault`（hairline，`1 / backingScaleFactor`） |
| 内边距 | 左右 16px（`space4`），元素间距 10px |
| 状态点 | **10px** 圆（现状 14px 偏大），色 = §4 状态色；starting 态带呼吸动画（opacity 1↔0.45，1.6s，`prefers-reduced-motion` 时静止） |
| 状态文字 | 13px（`Font.ui(13)`），`textSecondary`；运行中时端口号段用 `Font.mono(12)` |
| 按钮 | 高 28px，圆角 6px（`radiusMD`）；「启动/停止服务」= bordered（border `borderDefault`，文字 `textPrimary`）；「刷新」「浏览器打开」= borderless，文字 `textSecondary`，hover 升 `textPrimary` |
| 错误时 | 状态文字截断显示，完整信息进错误页（§6） |

布局建议：交通灯区与工具条同行——`fullSizeContentView` 下工具条左移，状态区起始 x = 88px（交通灯安全区），由实现侧以 `NSWindow.standardWindowButton` 定位微调。

## 4. 服务状态 → token 映射

| 服务状态 | 状态点色 | 语义 | 面板对应 |
|---|---|---|---|
| `running` 运行中 | `statusActive`（spark `#22D3EE`） | 活跃/在线 | agent working |
| `starting` 启动中 | `statusProgress`（violet `#7A4DFF`）+ 呼吸动画 | 进行中 | spawning |
| `stopped` 未运行 | `statusIdle`（`textDisabled`） | 空闲/离线 | agent idle |
| `failed` 失败 | `statusDanger`（`#F87171`） | 错误 | agent failed |

> 与占位版的差异：stopped 不再用红（未运行 ≠ 错误，红色留给 failed）；running 不用绿，用 spark 青——"在线"语义与 logo 中央菱形一致。绿（`success`）只用于一次性完成反馈（如"已重启成功"的短暂提示）。

## 5. 启动加载页（服务 starting 时覆盖 WebView 区域）

```
│                  ┌────────┐                     │
│                  │ 图标    │  icon-dark-tile 96px │
│                  └────────┘                     │
│                   ⣿ loading   spinner，spark 色   │
│              正在启动服务…         13px textSecondary │
│         127.0.0.1:4096（mono 12px textDisabled）  │
```

| 项 | 规格 |
|---|---|
| 覆盖层背景 | 实色 `bgApp`（不用 92% 半透明——WebView 未加载时下面是白底，半透明会闪） |
| 图标 | `../assets/icon-dark-tile.svg` 导出 96px（@2x 192px）；下方间距 24px |
| spinner | `NSProgressIndicator` spinning，着色 `statusActive`（`contentFilters` 或换 `ASProgressIndicator`；MVP 可直接用系统 spinner，允许） |
| 主文案 | 13px `textSecondary`，居中，最多 3 行 |
| 副文案 | host:port，mono 12px `textDisabled`，与主文案间距 6px |
| 进入/退出 | 淡入淡出 160ms（`durationBase`），禁用交互穿透 |

## 6. 服务未运行 / 错误页

未运行（stopped）：

```
│                   ○（空心灰点 20px）              │
│                服务未运行                          │
│        [ 启动服务 ]（primary 按钮）                │
```

错误（failed）：

```
│              ⚠ 服务启动失败         标题 15px/600 textPrimary
│      {message}                   13px textSecondary，最多 3 行
│  ┌──────────────────────────┐
│  │ 错误详情（mono 12px，bgSunken，│  可选：有 stderr 尾行时显示
│  │ radius 10px，padding 12px） │
│  └──────────────────────────┘
│   [ 重试 ] (primary)   [ 查看日志 ] (bordered)
```

| 项 | 规格 |
|---|---|
| primary 按钮 | bg `accentFill` `#4D6BFE`、文字 `textOnAccent` 白、hover `accentFillHover` `#5B7CFF`、高 32px、圆角 6px、padding `0 16px` |
| bordered 按钮 | 透明底、1px `borderDefault`、文字 `textPrimary`、hover border 升 `borderStrong` |
| 错误详情块 | bg `bgSunken`、圆角 10px（`radiusLG`）、内边距 12px、mono 12px `textSecondary`、最多 5 行滚动 |
| 文案分层 | 标题 15px/600 `textPrimary`；说明 13px `textSecondary`；详情 mono 12px |

## 7. 状态提示（一次性反馈）

壳内短暂反馈（如"服务已重启"、"页面已刷新"）用窗口内 toast：右上滑入，bg `bgElevated` + 1px `borderStrong`，左侧 3px 状态色条，圆角 10px，padding `10px 12px`，5s 自动消失（danger 不自动消失）。MVP 阶段可暂缓，状态栏文字已覆盖主要反馈。

## 8. token 映射表（CSS var → Swift）

| CSS var（tokens.css） | Swift 常量 | Dark | Light |
|---|---|---|---|
| `--bg-app` | `Color.bgApp` | `#0D1020` | `#F7F8FC` |
| `--bg-surface` | `Color.bgSurface` | `#161A2E` | `#FFFFFF` |
| `--bg-sunken` | `Color.bgSunken` | `#0A0D1A` | `#EFF1F8` |
| `--bg-elevated` | `Color.bgElevated` | `#1D2340` | `#FFFFFF` |
| `--text-primary` | `Color.textPrimary` | `#E8EAF6` | `#1A1D2E` |
| `--text-secondary` | `Color.textSecondary` | `#9AA0BE` | `#5A6072` |
| `--text-disabled` | `Color.textDisabled` | `#565C78` | `#9BA1B5` |
| `--border-default` | `Color.borderDefault` | `#262B45` | `#E2E5F0` |
| `--border-strong` | `Color.borderStrong` | `#3A4066` | `#C9CEDF` |
| `--accent`（文字/链接） | `Color.accent` | `#8FA4FF` | `#4D6BFE` |
| `--accent-fill`（填充按钮） | `Color.accentFill` | `#4D6BFE` | `#4D6BFE` |
| `--accent-fill-hover` | `Color.accentFillHover` | `#5B7CFF` | `#3B5BEE` |
| `--text-on-accent` | `Color.textOnAccent` | `#FFFFFF` | `#FFFFFF` |
| `--accent-spark` | `Color.spark` | `#22D3EE` | 同 |
| `--brand-violet` | `Color.violet` | `#7A4DFF` | 同 |
| `--success` | `Color.success` | `#4ADE80` | `#16A34A` |
| `--warning` | `Color.warning` | `#FBBF24` | `#D97706` |
| `--danger` | `Color.danger` | `#F87171` | `#DC2626` |
| `--status-active` | `Color.statusActive` | = spark | = spark |
| `--status-progress` | `Color.statusProgress` | = violet | = violet |
| `--status-idle` | `Color.statusIdle` | = textDisabled | 同 |
| `--status-danger` | `Color.statusDanger` | = danger | = danger |

| 类别 | CSS | Swift |
|---|---|---|
| 字号 | `--text-xs/sm/base/md` 11/12/14/17.5 | `Font.ui(11…)` / `Font.mono(…)`；shell 用到的档位：11、12、13、15、17.5（13/15 为壳内档位，走 `Font.ui(size)` 直接传值） |
| 圆角 | `--radius-md/lg` 6/10 | `Metrics.radiusMD / radiusLG` |
| 间距 | `--space-1…6` 4–24 | `Metrics.space1…space6` |
| 动效 | `--duration-fast/base` 100/160ms | `Metrics.durationFast / durationBase` |

> 字体栈：UI 西文 Inter（未安装回落系统 SF）→ 中文 PingFang SC（系统兜底天然支持）；等宽 JetBrains Mono（回落 `NSFont.monospacedSystemFont`）。`ShellTokens.swift` 的 `Font.ui/mono` 已封装回落链。

## 9. 现状差异清单（占位 → 正式）

| 占位现状（MainWindowController.swift） | 改为 |
|---|---|
| topBar 用 `NSVisualEffectView .headerView` | 实色 `bgSurface` + 底部 hairline `borderDefault` |
| 状态点 14px、systemGreen/Yellow/Red/Orange | 10px，spark/violet/textDisabled/danger（§4） |
| overlay 92% 半透明 windowBackgroundColor | 实色 `bgApp` + 96px 品牌图标 + spark spinner |
| stopped 红色 | 灰色（红只留 failed） |
| 系统 rounded 按钮 | primary / bordered / borderless 三档（§6） |
| 状态文字 12px | 13px；端口段 mono 12px |
| 原生标题栏 + 标题文字 | 融合式标题栏（`fullSizeContentView`），交通灯与工具条同行 |

接入只需：`ShellTokens.swift` 复制进 `Sources/HarnessShell/`，按 §9 替换 `setupUI()`/`updateUI(state:)` 中的颜色与尺寸常量，行为逻辑不动。
