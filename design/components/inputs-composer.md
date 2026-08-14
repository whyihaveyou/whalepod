# 输入框（TextInput）与对话 Composer

## TextInput

### 用途

单行文本输入：筛选框、spawn 名称/初始任务、改派搜索。

### 规格

- 高 32px，padding `0 10px`，radius `--radius-md`，字号 `--text-base`；
- bg `--bg-app`，border 1px `--border-default`；
- 前置图标（如 🔍 筛选）16px，左 padding 变 30px，图标色 secondary；
- placeholder：`--text-disabled`，句式用动作提示（"筛选…"、"（可选）上线后立即指派…"）。

### 状态

| 状态 | 视觉 |
|---|---|
| hover | border `--border-strong` |
| focus | border `--accent` + 外发光 `0 0 0 2px var(--accent-subtle)` |
| disabled | bg 不变，文字/placeholder `--text-disabled`，`cursor: default` |
| error | border `--status-danger`；下方 4px 间距后错误文案 12px danger 色 |

### 可访问性

- 可见 label 优先；无 label 时 `aria-label`（筛选框允许只用图标 + `aria-label="筛选成员"`）；
- error 文案 `role="alert"`，输入框 `aria-invalid="true"` + `aria-describedby` 关联。

---

## Composer（对话输入区）

### 用途

详情栏底部与 teammate 对话的输入组件：多行文本、@提及、附件、广播开关、发送。对应 `team_send_message`。

### 解剖

```
┌──────────────────────────────────────────────┐
│ 发消息给 视觉-K3-1…                       ⌘↵ │  ← textarea 自动增高 1–6 行
└──────────────────────────────────────────────┘
[📎 附件]  [@ 提及]        [◯ 广播到全队]  [发送]  ← 工具行 h=36px
```

- 容器：bg `--bg-surface`，顶部 1px `--border-default` 分隔，padding 12px；
- textarea：无独立边框（融入容器），focus 时容器顶部描边变 accent；最小 1 行（20px）最大 6 行，超出内部滚动；
- 发送键：`⌘↵` 发送 / `↵` 换行（默认，设置中可反转，用 SegmentedControl 配置）；
- `[发送]`：primary sm；输入为空时 disabled。

### @提及

- 输入 `@` 触发成员 popover（向上展开，max-h 240px）：条目 = StatusDot sm + display name + 角色（secondary）；type-ahead 过滤；
- 选中后插入 chip：`@视觉-K3-1`（accent 文字 + accent-subtle 底，radius-sm，可整体删除——一次 Backspace 删除整个 chip，不逐字删）；
- 数据层：chip 绑定 slot_id，发送时序列化为协议格式；**禁止用 display name 做发送目标**。

### 广播开关

- 工具行右侧 toggle（`[◯ 广播到全队]`）：开启后 — 容器描边整体变 `--accent`、placeholder 变"广播给全队 11 人…"、发送按钮文字变"发送全队"；
- 广播发送 = L1 轻确认：首次点击发送时按钮变形为"确认发送全队？"，二次点击才发出；`Esc` 退出广播模式；
- 广播与 @提及互斥：开广播时 @ chip 自动清除并提示。

### 状态

| 状态 | 表现 |
|---|---|
| 发送中 | 气泡立即上屏（乐观更新，60% 不透明度），成功后恢复 |
| 发送失败 | 气泡右下角 `✕` danger 色 + hover 显示 `[重发]`；composer 内容保留 |
| 对方 offline | composer 顶部内联提示条（warn）："对方已断连，消息将在其重连后送达"——**不阻断输入** |
| 断连（全局） | composer 禁用，placeholder 变"连接已断开"（见 states.md） |

### 可访问性

- textarea `aria-label="发消息给 {display name}"`，广播时同步更新为"广播给全队"；
- @提及 popover：标准 `listbox`，`↑/↓` 移动、`↵` 选中、`Esc` 关闭；chip 可聚焦，`Delete` 删除；
- 发送失败提示 `aria-live="polite"`。
