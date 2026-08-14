# 模态（Modal）与确认流程

## Modal 壳

### 用途

承载确认分级 L1–L3 的操作与 Spawn 流程。所有模态共用此壳。

### 解剖

```
│ 遮罩：--bg-overlay（#0009），点击遮罩 = 取消（L3 除外，L3 只允许显式按钮）
┌─────────────────────────────┐
│ 标题                       ✕ │  ← header：--text-md，h=52px，下 1px border-default
│─────────────────────────────│
│                             │
│ 内容区（padding 16px）        │  ← max-h 60vh，超出内部滚动
│                             │
│─────────────────────────────│
│              [取消] [主操作] │  ← footer：右对齐，h=60px，上 1px border-default
└─────────────────────────────┘
```

- 宽度：确认类 440px，表单类（Spawn）560px；radius `--radius-xl`（模态专用 14px），bg `--bg-surface`，shadow `--shadow-modal`；
- 进出动效：遮罩淡入 + 面板从 96% 缩放到 100%（240ms）；关闭反向 160ms；
- 快捷键：`Esc` 取消（L3 除外），`⌘↵` 触发主操作。

### 可访问性

- `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（标题）；
- focus trap；打开时焦点落在第一个可交互元素（L3 落在取消按钮——防回车误触）；关闭后焦点还原来源元素；
- 模态打开期间背景 `inert`。

---

## Spawn 模态（扩编，L1）

布局与字段见 wireframes §4，此处给组件级规则：

| 区块 | 组件 | 规则 |
|---|---|---|
| 模板选择 | 卡片网格（3 列，gap 8px） | 每卡：模板名（13px/600）+ 模型（12px secondary mono）；选中 = border accent + 左上 `✓` chip；数据源 `team_list_assistants`，hover 卡片显示 `team_describe_assistant` 摘要 tooltip |
| 名称 | TextInput | 自动建议 `{模板名}-{N+1}`（N=现有同模板数），可改；重名时 error 态内联提示 |
| 初始任务 | TextInput（可选） | 有值时下方出现说明块（bg elevated，radius-md，padding 10px，12px secondary）："将根据描述在任务板创建并指派" |
| 高级 | 折叠区（disclosure） | 模型/技能/MCP 覆盖，默认继承模板；展开态记忆到本次会话 |
| footer | [取消] secondary + [Spawn ⌘↵] primary | 未选模板时主按钮 disabled |

**提交后**：模态立即关闭（L1 乐观）；roster 顶部插入 spawning 条目（三点弹跳动画），任务板同步出现新卡（若有初始任务）。失败：条目转 failed 态 + danger toast（含 `[重试]`，点击重开模态并回填上次内容）。

---

## Shutdown 模态（关机，L2/L3）

协商式两步流程，对应 shutdown_request / approved / rejected 协议。

### 第一步：确认模态（440px）

```
┌──────── 请求关机：{display name} ────────✕─┐
│ 该成员当前状态：idle · 无进行中任务           │  ← 状态摘要行（StatusBadge dot-label）
│ ⚠ 该成员有 1 个进行中任务（有条件时显示）      │  ← warn 色内联警告，bg warn-subtle
│                                             │
│ ● 等待成员确认（推荐）                        │  ← radio，默认选中
│   成员可批准或拒绝；拒绝时你会收到原因。        │  ← 说明 12px secondary，缩进 20px
│ ○ 强制关机（不等待确认，可能丢失未保存工作）    │  ← radio，文字 danger 色
│                                             │
│                [取消]  [发送关机请求]        │
└─────────────────────────────────────────────┘
```

- 主按钮文字随 radio 变化："发送关机请求"（primary）/ "强制关机"（danger）；
- 选中"强制关机"时升级为 **L3**：footer 追加确认行——TextInput"输入 `{名称首词}` 以确认"+ 主按钮变为长按 1s 激活（见 buttons.md）；两项都满足才可触发；
- 无进行中任务的 idle 成员，radio 默认仍推荐协商，但允许直接强制（仍走 L3 输入确认）。

### 第二步：等待态（非模态，内联）

发送请求后模态关闭，**不阻塞用户**：

- roster 条目状态变 `shutting_down`（⏳ + warn 色），条目右侧出现 `[取消]` ghost 按钮；
- 该 agent 详情面板顶部出现内联等待条：`等待关机确认… [取消]`（bg warn-subtle，h 36px）；
- 对话界面同步系统条："已向 {name} 发送关机请求"。

### 结果

| 结果 | 表现 |
|---|---|
| approved | 条目 240ms 淡出移除；活动流记录"{name} 已关机（成员批准）"；详情栏若打开则切换空态 |
| rejected | danger toast + 对话界面系统条"{name} 拒绝关机：{原因}"；条目恢复原状态；toast 含 `[查看对话]` 按钮跳转 |

### 可访问性

- radio 组 `role="radiogroup"`，说明文字 `aria-describedby`；
- L3 输入确认：主按钮 `aria-disabled` 直到输入匹配；长按见 buttons.md；
- 等待条 `role="status"`；结果 toast approved=`polite` / rejected=`assertive`。
