# 按钮（Button / IconButton / SegmentedControl）

## Button

### 用途

触发操作。按确认分级（interaction-spec §3）选择变体：L0/L1 用 primary/secondary，L2/L3 用 danger。

### 变体

| 变体 | bg | border | text | 用途 |
|---|---|---|---|---|
| `primary` | `--accent-fill` | 无 | `--text-on-accent` | 每屏最多 1 个主操作（Spawn、发送关机请求） |
| `secondary` | transparent | 1px `--border-default` | `--text-primary` | 常规操作（取消、改派、发消息） |
| `danger` | transparent | 1px `--status-danger` | `--status-danger` | 破坏性操作（强制关机、删除任务）；hover 填充 danger 15% 底 |
| `ghost` | transparent | 无 | `--text-secondary` | 列表内联操作（重启、取消等待）；hover 文字升 primary + 底 elevated |

### 尺寸

| 尺寸 | 高 | padding | 字号 | 用途 |
|---|---|---|---|---|
| `md`（默认） | 32px | `0 12px` | `--text-base`（14px/500） | 模态 footer、面板操作区 |
| `sm` | 28px | `0 10px` | `--text-sm`（12px/500） | 字段行内、卡片内 |

相邻按钮间距 8px；模态 footer 右对齐，主操作在最右。

### 状态

| 状态 | 视觉 |
|---|---|
| hover | primary: bg `--accent-fill-hover`；secondary: border `--border-strong`；danger: 填充 danger-subtle；过渡 `--duration-fast` |
| pressed | 整体 `transform: scale(.97)`，无阴影变化 |
| disabled | 文字/边框 `--text-disabled`，bg 不变形（primary 褪为 accent 40%），`cursor: default` |
| loading | 前置 12px spinner（`--status-progress` 色）+ 文字保持，宽度不回缩（`min-width` 锁定）；按钮禁用 |

### Token 绑定

radius `--radius-md`；字重 500；focus 环按共享约定 §3。

### 可访问性

- loading 时 `aria-busy="true"` + `aria-disabled`；spinner `aria-hidden`；
- 长按激活（L3 强制关机，1s）：进度在按钮填充层从左到右扫过，松手回退；完成时震动反馈（若平台支持）。键盘等价：聚焦后按住 `Space`/`↵` 1s 同样触发。`aria-describedby` 说明"长按 1 秒确认"。

---

## IconButton

### 用途

纯图标操作：标题栏（⌘K、搜索、设置）、条目 hover 操作（重启、对话）、模态关闭 ✕。

### 规格

- 尺寸 28×28px，图标 16px 居中；radius `--radius-md`；
- 默认 `color: --text-secondary`、透明底；hover：bg `--bg-elevated` + 文字 primary；pressed 同 Button；
- `danger` 变体：图标色 `--status-danger`；
- 出现在列表条目右侧的 IconButton **默认隐藏，条目 hover/focus-within 时淡入**（100ms），保证扫读干净；键盘焦点进入条目时同样显示。

### 可访问性

- 必须有 `aria-label`（无可见文字），如 `aria-label="重启 工程-Flash-1"`；
- hover 出现 ≠ 键盘不可达：条目 `focus-within` 显示，Tab 顺序内。

---

## SegmentedControl（分段控件）

### 用途

二至四选一的模式/筛选切换：roster 排序（按状态/名称/模型）、活动流类型筛选、对话发送键设置（⌘↵ / ↵）。

### 解剖

```
┌──────────┬──────────┬──────────┐
│  按状态   │  按名称   │  按模型   │   h=32px, 容器 padding 2px, 段 padding 0 12px
└──────────┴──────────┴──────────┘   容器 bg=--bg-app, radius=--radius-md, border=--border-default
```

- 选中段：bg `--bg-elevated` + `--shadow-popover` 的 1px 边框层（即 `0 0 0 1px border-strong`），文字 primary/500；未选中：文字 secondary，hover 升 primary；
- 切换动效：选中块滑动 160ms `--ease-out`；
- 段内允许"图标 + 文字"或纯文字，不允许纯图标（歧义大）。

### 可访问性

- 容器 `role="radiogroup"` + `aria-label`；段 `role="radio"` + `aria-checked`；
- 键盘：`←/→` 移动并立即选中（selection follows focus）；容器单 Tab 位。
