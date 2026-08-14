# 团队面板 UI 原型（React + mock 数据版）

DFH Workstation 团队管理面板的可运行前端原型。技术栈 **React 18 + Vite 5 + TypeScript**，严格按
`design/` 下的统一设计 token（`design/tokens/tokens.css`）与组件规范（`design/components/`、`design/team-panel/`）实现。

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 类型检查 + 产物构建
npm run preview    # 预览构建产物
```

## 已实现视图

| 视图 | 入口 | 说明 |
|---|---|---|
| 团队成员 roster | `⌘1` | LEAD/TEAMMATES 分组、状态排序、搜索过滤、failed 吸顶 + 重启、选中态、成员详情 |
| 任务板 Kanban | `⌘2` | 待处理/进行中/已完成 三列、拖拽跨列、阻塞任务不可进「进行中」（bounce-back）、任务详情 |
| 活动流 | `⌘3` | 全宽时间线：消息/任务/状态三类事件，可跳转成员/任务 |
| 对话 | 成员详情 → 对话 | 消息流 + 系统条 + @提及 + 广播模式 + typing 指示 |
| 扩编 Spawn | `⌘⇧N` / 导航栏 | 模板卡片网格、名称自动建议、初始任务、高级配置折叠、`⌘↵` 提交 |
| 关机 Shutdown | 成员详情 → 关机 | 两步协商：等待确认 / 强制（输入首词 + 长按 1s）、等待条、批准/拒绝结果 |
| 命令面板 | `⌘K` | 搜索命令/成员/任务，↑↓ 选择、↵ 执行 |
| 新建任务 | `⌘N` | 快速建卡 |

## 键盘快捷键

| 快捷键 | 动作 |
|---|---|
| `⌘1` / `⌘2` / `⌘3` | 切换 团队成员 / 任务板 / 活动流 |
| `⌘K` | 命令面板 |
| `⌘⇧N` | 扩编（Spawn） |
| `⌘N` | 新建任务 |
| `⌘B` | 展开/折叠导航栏 |
| `⌘↵` | 发送消息 / 确认模态 |
| `Esc` | 关闭模态 / 面板 |
| `↑` `↓` `↵` | 列表/命令面板选择 |

## 目录结构

```
src/
├── types/          # 领域类型（Agent/Task/Message/…）
├── services/
│   ├── api.ts      # ★ TeamApi 抽象接口（组件只依赖它）
│   └── mockApi.ts  # mock 实现（延迟、状态机、事件推送）
├── data/           # mock 硬编码数据（仅 mock 层使用）
├── hooks/          # useRoster / useTasks / useChat / useActivities…
├── components/
│   ├── common/     # Button/StatusBadge/Modal/TextInput…
│   ├── shell/      # TitleBar/NavRail/StatusBar
│   ├── roster/     # RosterList/AgentDetail
│   ├── board/      # TaskBoard/TaskCard/TaskDetail
│   ├── chat/       # ChatPane/Composer
│   ├── activity/   # ActivityView
│   └── modals/     # SpawnModal/ShutdownModal/CommandPalette/NewTaskModal
└── styles/
    ├── tokens.css  # 直接拷贝自 design/tokens/tokens.css（单一事实源）
    └── global.css  # 全部组件样式，只引用 token 变量
```

## 数据层抽象（接入真实 @dfh/honeycomb API）

组件**不感知 mock 实现**。所有数据访问都通过 `TeamApi` 接口（`src/services/api.ts`）：

```ts
export interface TeamApi {
  listAgents(); listTasks(); getThread(agentId); listActivities(); listTemplates();
  spawnAgent(req); restartAgent(id); requestShutdown(id, force);
  updateTaskStatus(id, status); createTask(title, assigneeId);
  sendMessage(to, text); subscribe(listener);
}
```

替换真实 API 的步骤：

1. 新建 `src/services/honeycombApi.ts`，实现同一 `TeamApi` 接口（`to` 传 slot_id，与
   `team_send_message`/`team_task_update` 语义对齐）。
2. 在 `src/hooks/useTeamStore.ts` 的 `useTeamApi()` 中把 `new MockApi()` 换成真实实现。
3. 若真实 API 为拉取式（polling），在 `subscribe` 里轮询并调用 listener 即可——hooks 侧无需改动。

设计上的对齐点：

- **slot_id 即 `Agent.id`**，display name 仅用于展示，禁止做 key。
- 消息 `to: "*"` 表示广播（对应 `team_send_message` 的 `to="*"`）。
- `SpawnTemplate` 对应 `team_list_assistants` 的 assistant 目录。

## 设计对齐

- 颜色 / 间距 / 圆角 / 字号全部来自 `src/styles/tokens.css`（源：`design/tokens/tokens.css`），
  未写死任何色值。
- 状态视觉：spawning 三点弹跳、working 呼吸光晕、failed 实心 ✕、offline 空心、shutting_down 警示，
  见 `StatusBadge.tsx`。
- 组件尺寸：按钮 md=32px / sm=26px；输入框 32px；模态 440px（confirm）/ 560px（spawn）。
- 无障碍：模态 focus trap + Esc、`role="dialog"`、按钮 aria-label、`prefers-reduced-motion`
  动画均基于 token 的 `--duration-*` 过渡（动画禁用可后续按需接入媒体查询）。

## 已知边界（原型）

- 拖拽目前为 HTML5 DnD；阻塞 bounce-back 为简化模拟（真实系统应在 API 层校验）。
- 任务「改派」原型上简化为「复制为新任务指派」，未做真实迁移语义。
- 广播的 L1 确认、长按 1s 激活为主观实现，与交互规范的「防误触」意图一致。
- mock 回复语料与成员行为为演示性硬编码。
