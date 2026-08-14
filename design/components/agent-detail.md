# Agent 详情面板

## 用途

Roster 视图中选中 agent 后，详情栏展示其身份、当前任务、能力与操作入口。是"看清这个 agent 在干什么 + 对它操作"的单一入口。

## 解剖

```
┌─────────────────────────────────────────┐
│ {display name}              [对话]      │  ← --text-md + primary-outline 按钮
│─────────────────────────────────────────│
│ 角色   teammate · 视觉设计               │  ← 字段行（同任务详情：label 72px）
│ 模型   kimi-code/k3                    │  ← mono
│ 状态   ● working · 已工作 42 分钟        │  ← StatusBadge dot-label 变体
│ slot   019fffca-ce41…  [复制]          │  ← mono 12px 截断 + IconButton 复制
│─────────────────────────────────────────│
│ 当前任务                                │  ← 区块标题 --text-sm secondary
│ #019ffff4 【团队面板 UI 设计】            │  ← 可点击 → 任务板对应卡片
│ 状态: in_progress · 开始于 10:22        │
│（无任务时：一行 "当前无进行中任务" disabled）│
│─────────────────────────────────────────│
│ 能力                                    │
│ skills:  代码审查 · 文档生成             │  ← tag 列表：h 20px chip
│ MCP:     sciverse, survey-gates        │  ← mono 12px secondary
│─────────────────────────────────────────│
│ 操作                                    │
│ [发消息]  [分配任务]  [请求关机…]        │  ← secondary / secondary / danger
└─────────────────────────────────────────┘
```

## 规则

- 面板 padding 16px，字段行高 28px（无控件行）；区块分隔 1px `--border-default`，上下间距 16px；
- 区块顺序固定：**身份 → 当前任务 → 能力 → 操作**；能力区只读（skills/MCP 由 spawn 模板决定，UI 不提供编辑——编辑走重 spawn）；
- 状态行：
  - working 超 30 分钟无事件 → 时长文字常驻（"已工作 42 分钟"），超 2 小时文字变 warn 色；
  - failed → 状态行下方出现内联条（danger-subtle）："{失败原因，截断 1 行} [重启]"，重启为 ghost sm；
  - shutting_down → 顶部出现等待条（见 modals.md 第二步），操作区按钮全部 disabled；
- 当前任务区块：点击跳到任务板并选中卡片（详情栏同步切任务详情）；无任务时单行占位，不渲染卡片样式；
- 操作区：
  - `[发消息]` → 详情栏切对话视图（composer 自动聚焦）；
  - `[分配任务]` → 内联展开一个迷你表单（TextInput 任务描述 + [创建并指派] primary sm），创建后跳到任务板；
  - `[请求关机…]` danger → Shutdown 模态（见 modals.md）；
- 头部 `[对话]` 按钮与 `[发消息]` 同效，二者保留（头部快捷 + 操作区完整组）。

## Token 绑定

| 部位 | Token |
|---|---|
| 名称 | `--text-md` / `--text-primary` |
| 字段 label / 区块标题 | `--text-sm`（label 400 / 区块标题 500），`--text-secondary` |
| 字段值 | `--text-base` / `--text-primary`；id、模型、MCP 用 `--font-mono` |
| 能力 chip | h 20px，padding `0 6px`，bg `--bg-elevated`，radius `--radius-sm`，`--text-xs` |
| 内联条 / 等待条 | states.md 区块级规则 |

## 可访问性

- 字段区 `<dl>`；状态行文字双编码（点 + 文字）；
- `[复制]` 按钮 `aria-label="复制 slot_id"`，成功后按钮短暂变 `✓`（1.5s）+ toast status 级；
- 状态实时变化时（如 working→idle）不整面板重渲染，单行 160ms 过渡；读屏通过状态行 `aria-label` 变化感知。
