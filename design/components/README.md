# 组件规范 — DFH Workstation 团队面板

> 版本：v0.1 · 作者：视觉-K3-2
> 定位：**实现方可直接照做的组件级规范**。token 唯一权威为 [../tokens/tokens.css](../tokens/tokens.css)（+ [../tokens/tokens.json](../tokens/tokens.json)）；本目录只定义组件的解剖、变体、状态、尺寸、token 绑定与可访问性，不重复定义 token 值。
> 视觉识别（品牌/logo/图标）见 [../visual-identity.md](../visual-identity.md)；图标资源在 [../assets/](../assets/)。

## 共享约定（所有组件适用，单组件页不再重复）

1. **Token 引用**：组件只引用 `--*` 语义 token 与状态 token，禁止写死色值/字号/圆角。命名与取值以 [../tokens/tokens.css](../tokens/tokens.css) 为唯一权威。
2. **密度**：桌面紧凑档，4px 基栅；最小可点击区域 28px（图标按钮）/ 32px（常规控件）。
3. **焦点环**：所有可交互元素 `:focus-visible` → `outline: 2px solid var(--accent); outline-offset: 1px`，暗色下对比度 ≥ 3:1。禁止 `outline: none` 无替代。
4. **动效**：默认 `var(--duration-base)` + `var(--ease-out)`；`prefers-reduced-motion` 时全部归零。
5. **状态色双编码**：状态永远同时用颜色 + 文字/形状表达（色盲安全），单独一个色点不构成完整状态指示。
6. **图标**：UI 内图标用 `../assets/icon-mono.svg` 风格的几何线性图标，16px 网格、1.5px 描边，颜色绑 `currentColor`。产品 logo 只出现在标题栏。
7. **命名**：展示一律 display name；数据 key 一律 slot_id / task_id（mono 字体展示时截断为前 8 位，如 `#019ffff4`）。

## 组件索引

| 文件 | 组件 | 主要消费视图 |
|---|---|---|
| [status-badge.md](./status-badge.md) | StatusDot / StatusBadge（agent + 任务状态） | Roster、任务板、详情栏、状态栏 |
| [task-card.md](./task-card.md) | TaskCard（看板卡）+ 任务详情字段布局 | 任务板、详情栏 |
| [buttons.md](./buttons.md) | Button / IconButton / SegmentedControl | 全局 |
| [inputs-composer.md](./inputs-composer.md) | TextInput / Composer（@提及、广播、发送） | 对话、模态、筛选 |
| [modals.md](./modals.md) | Modal 壳 + Spawn 流程 + Shutdown 两步确认 | 全局 |
| [states.md](./states.md) | 空 / 加载 / 错误 / 断连态 | 全局 |
| [agent-detail.md](./agent-detail.md) | Agent 详情面板 | Roster 详情栏 |

## 状态色速查（组件页统一引用此表）

| 语义 | Token | 文字/底色 |
|---|---|---|
| working / in_progress | `--status-active` | 徽章：active 文字 + `-subtle` 底 |
| idle | `--status-idle` | 同上规则 |
| pending | `--status-pending` | 空心点 / 虚线描边徽章 |
| completed | `--status-done` | — |
| failed / error | `--status-danger` | — |
| blocked / warning | `--status-warn` | 任务卡整卡描边 |
| spawning / typing | `--status-progress` | 加载动画专用 |
| offline | `--status-offline` | 空心点 |
