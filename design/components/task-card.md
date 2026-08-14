# 任务卡片（TaskCard）与任务详情

## TaskCard（看板卡）

### 用途

任务板三列（PENDING / IN PROGRESS / COMPLETED）中的任务单元；点击在详情栏打开任务详情，拖拽跨列改状态。

### 解剖

```
┌──────────────────────────┐
│ 【标题，最多 2 行截断】     │  ← --text-base (14/22/600), text-primary
│ 视觉-K3-1        ● 状态点  │  ← 负责人行：dot 8px + 名 12px secondary
│ 42 分钟 / ✓ 09:58 / ⛔ #112│  ← 元信息行：12px secondary
└──────────────────────────┘
 padding: 12px；行间距 6px；radius=--radius-md
```

- 标题：`display: -webkit-box; -webkit-line-clamp: 2`，超出省略；
- 负责人行：负责人状态点（复用 StatusDot sm）+ display name；无负责人显示"未指派"（`--text-disabled`）；
- 元信息行按状态三选一：in_progress → 已进行时长；completed → `✓` + 完成时间；有阻塞依赖 → `⛔ 被 #xxx 阻塞`（warn 色文字）。

### 状态

| 状态 | 视觉 |
|---|---|
| default | bg `--bg-elevated`，border 1px `--border-default` |
| hover | border `--border-strong`，光标 `pointer` |
| selected（详情打开中） | border `--accent` + 左侧 2px accent 指示条 |
| dragging | 缩放 1.02 + `--shadow-popover`，原位列显示虚线占位框 |
| drag-over-invalid | 目标列头变 warn 色；松手回弹 240ms + 列头微提示"该任务被 #112 阻塞" |
| blocked | border `--status-warn`（整卡），`⛔` 元信息行 |
| disabled（他人任务，无权限拖动） | 不响应 drag，hover 无 drag 光标，其余不变 |

### 尺寸与间距

- 宽度 = 列宽 - 24px（列 padding 12px 两侧）；列内卡片间距 8px；
- 最小高度 76px（三行内容）；空列内 `[+ 添加]` 按钮高 32px、虚线描边、`--text-secondary`；
- 列头：列名 + 计数（`--text-sm`，计数用 secondary），列头色按列语义：PENDING=pending、IN PROGRESS=active、COMPLETED=done。

### 可访问性

- 卡片是 `<article tabindex="0">`，`aria-label="#{id前8位} {标题}，{状态}，负责人 {名}"`；
- 拖拽必须有键盘等价操作：卡片聚焦时 `⌘↑/⌘↓` 在列间移动，或用详情面板的状态下拉（见下）；`aria-grabbed` / `aria-dropeffect` 标注；
- 阻塞卡 `aria-describedby` 指向阻塞来源文本。

---

## 任务详情（详情栏字段布局）

### 解剖

```
┌─────────────────────────────────────┐
│ #019ffff4 【标题】                    │  ← id mono 12px secondary + 标题 --text-md
├─────────────────────────────────────┤
│ 状态    [in_progress ▾]             │  ← 字段行：label 72px + 控件
│ 负责人  视觉-K3-1        [改派…]      │
│ 创建于  10:15 · 由 Aion CLI          │
│ 依赖    无 / #019fff11（可点击跳卡）   │
├─────────────────────────────────────┤
│ 描述                                │  ← 区块标题 --text-sm secondary
│ {描述全文，空时显示"无描述" disabled}  │  ← 正文 --text-base
├─────────────────────────────────────┤
│ 动态                                │
│ 10:22  视觉-K3-1 标记为 in_progress  │  ← 时间 mono 12px secondary + 事件 13px
└─────────────────────────────────────┘
```

### 规则

- 面板 padding 16px；字段区 label 列固定 72px、右对齐→不对齐，label 左对齐、`--text-sm` secondary；值列 `--text-base`；字段行高 32px（含交互控件时对齐控件高度）；
- 区块间 1px `--border-default` 分隔线，上下各 16px 间距；
- 状态下拉：列出 pending / in_progress / completed（deleted 不在 UI 提供，走命令面板）；改状态即调 `team_task_update`，无需确认（L0/L1 之间，本人任务 L0，他人任务 L1 内联确认）；
- `[改派…]`：次按钮 sm，弹出成员选择 popover（复用 Composer @提及的列表样式）；
- 依赖字段：每个依赖渲染为 mono id chip（h 20px，bg `--bg-app`，radius-sm，padding 0 6px），点击跳转到对应任务详情；
- 动态区：倒序，最多展示 20 条，超出"加载更早"；无动态时整区隐藏（不显示空态）。

### 可访问性

- 字段区用 `<dl>`（label=`<dt>`，value=`<dd>`），读屏按字段对朗读；
- 状态下拉标准 listbox；改派 popover 标准 listbox + type-ahead；
- 动态区追加新事件用 `aria-live="polite"`（详情打开时才有）。
