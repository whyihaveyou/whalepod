# 状态徽章（StatusDot / StatusBadge）

## 用途

表达两类状态：**agent 运行状态**（spawning / idle / working / failed / offline / shutting_down）与**任务状态**（pending / in_progress / completed / blocked）。出现于 roster 条目、任务卡、详情栏、状态栏、对话系统条。

## 变体

### StatusDot（状态点）

纯图形指示器，**永远与文字搭配出现**，不单用。

| 变体 | 规格 |
|---|---|
| `sm`（列表内） | 8px 实心圆，放 roster 条目主行右侧 |
| `md`（详情/状态栏） | 10px 实心圆 + 4px 间距 + 状态文字 |
| `hollow` | 空心圆（1.5px 描边，无填充）：`pending`、`offline` 专用 |

### StatusBadge（文字徽章）

```
┌───────────┐
│ ● working │   h=20px, padding 0 6px, gap 4px, radius=--radius-sm
└───────────┘   text=--text-xs (11px/500)
```

| 变体 | 视觉 |
|---|---|
| `solid-tint`（默认） | 文字与点 = 状态色；底 = 状态色 `-subtle`（15%） |
| `outline` | 透明底 + 1px 状态色描边：`pending` 用虚线描边（`dashed`），其余实线 |
| `dot-label` | 无底无框，点 + 文字：用于详情栏、状态栏等信息密度低处 |

## 状态映射

| 值 | 点样式 | 色 token | 附加行为 |
|---|---|---|---|
| `spawning` | 三点弹跳动画（不显示圆点） | `--status-progress` | 动效时长见 tokens.css `--duration-*` |
| `idle` | 实心 | `--status-idle` | — |
| `working` | 实心 + 呼吸（opacity 1↔0.45，1.6s） | `--status-active` | reduced-motion 时静止 |
| `failed` | 实心 + 左侧 `✕` 图标（badge 内） | `--status-danger` | roster 中吸顶排序 |
| `offline` | 空心 | `--status-offline` | 文字附加"（已断连）" |
| `shutting_down` | 实心 + `⏳` 前置 | `--status-warn` | 条目右侧出现 `[取消]` |
| `pending`（任务） | 空心 / 虚线描边徽章 | `--status-pending` | — |
| `in_progress`（任务） | 实心 | `--status-active` | 显示已进行时长 |
| `completed`（任务） | 实心 + `✓` 前置 | `--status-done` | 显示完成时间 |
| `blocked`（任务标记） | `⛔` 图标徽章 | `--status-warn` | 附阻塞来源：`被 #112 阻塞` |

## 尺寸与间距

- dot 与文字间距 4px；badge 内 padding `0 6px`，点缩小到 6px；
- 列表行内：dot 距行右缘 12px（对齐条目 padding）；
- 时长/时间后缀（"已工作 42 分钟"）：与状态文字同一文本节点，用 ` · ` 分隔，颜色 `--text-secondary`。

## Token 绑定

| 部位 | Token |
|---|---|
| 徽章文字 | `--text-xs`（11/16/500） |
| 徽章底色 | `{status-color}26`（各状态色的 `-subtle` 变体） |
| 徽章描边（outline） | 状态色，1px |
| 圆角 | `--radius-sm` |

## 可访问性

- 徽章容器 `role="status"` 仅用于动态变化的整体状态区；列表内大量徽章用 `aria-label="{名称}：{状态文字}"` 打在父条目上，徽章本身 `aria-hidden` 避免读屏噪音。
- 呼吸动画遵守 `prefers-reduced-motion`（静止）；1.6s 慢循环不在光敏闪烁风险区间。
- 状态变化时文字同步更新（如 idle→working），读屏通过条目 `aria-label` 变化感知，不用 live region 逐条播报（高频会刷屏）。
