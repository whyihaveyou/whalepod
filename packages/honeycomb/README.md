# @whalepod/honeycomb

> 多智能体编排核心（Multi-Agent Orchestration Core）：把一组 agent 组织成「蜂群（Hive）」——蜂后（Queen）派工、工蜂（Worker）交付、名册（Roster）管成员、台账（Ledger）记任务、信使（Courier）传消息、权限（Mandate）控动作，全部状态以**事实日志（event sourcing）**落盘、可重放。
>
> 基于 DeepSeek Harness 的 Cordis 生态构建，蜂巢词汇与协作模型为**概念级重实现**（不依赖、不含 AionUi 代码）。

> **⚠️ 迁移状态**：本包正在做 cordis 全量迁移（编排-Pro 在树上作业），公开 API 以迁移完成后为准；本 README 的 API 参考以当前代码为基线，迁移后若公开签名有变，会增量修订（见文末「状态与文档同步」）。

---

## 目录

- [一、定位](#一定位)
- [二、蜂巢词汇表（一页速览）](#二蜂巢词汇表一页速览)
- [三、架构总览](#三架构总览)
- [四、安装与最小示例](#四安装与最小示例)
- [五、quickstart 指引](#五quickstart-指引)
- [六、API 参考](#六api-参考)
- [七、事件溯源：事实日志与重放](#七事件溯源事实日志与重放)
- [八、测试与验证](#八测试与验证)
- [九、状态与文档同步](#九状态与文档同步)

---

## 一、定位

`@whalepod/honeycomb` 是一个**进程内可嵌入**的多智能体编排核心，三个关键词：

1. **蜂巢协作模型**：`Hive` 是基本协作单元（一个工作区 + 一名 queen + 若干 worker）。queen 通过 `ledger` 派工、worker 通过 `courier` 交付汇报，`roster` 管理成员生命周期（hatch / dismiss），`mandate` 做动作级授权。
2. **事件溯源（event sourcing）**：一切状态变更以 `HiveFact` 追加写日志（默认 `~/.dfh/hive/<hiveId>/facts.ndjson`），进程重启后重放日志重建快照——无需迁移脚本，天然可审计、可重建。
3. **传输与前端就绪**：内置 HTTP + WebSocket transport（REST 查询/变更 + WS 事件推送），并配套**类型化客户端 SDK**（`createHoneycombClient`），React 等前端可以直接联调。

对外暴露形态：

- **嵌入**：`apply(ctx, config)` 装配到 Cordis 上下文（`ctx.hive / ctx.roster / ctx.ledger / ctx.courier / ctx.mandate`）；
- **服务化**：`config.transport.enabled = true` 或 `createNodeTransportServer(ctx, …)` 起 HTTP+WS 服务；
- **前端**：`createHoneycombClient({ httpUrl, wsUrl })` 类型化消费（REST + WS 订阅，断线自动重连）。

---

## 二、蜂巢词汇表（一页速览）

| 词汇 | 含义 | 代码对应 |
| --- | --- | --- |
| **Hive** 蜂群 | 一个协作单元：工作区 + queen + workers | `Hive`（`src/types.ts`）、`ctx.hive` |
| **Queen** 蜂后 | 每个 hive 有且仅有一名 leader 成员：派工、审批、解散 | `Member.role === 'queen'` |
| **Worker** 工蜂 | 执行成员，被 queen 派工后干活并汇报 | `Member.role === 'worker'` |
| **Roster** 名册 | 成员注册表：注册/孵化/遣散/状态 | `ctx.roster` |
| **Ledger** 台账 | 任务账本：建任务、依赖、指派、更新 | `ctx.ledger` |
| **Courier** 信使 | 消息总线：指令/汇报/通知/广播/收件箱 | `ctx.courier` |
| **Mandate** 权限 | 动作级授权：can / assert / grants | `ctx.mandate` |
| **hatch** 孵化 | 注册并启动一个新成员（拉起运行时会话） | `ctx.roster.hatch(...)` |
| **dismiss** 遣散 | 优雅下线成员（协商式，收 shutdown-request） | `ctx.roster.dismiss(...)` |
| **Session** 会话 | 成员的一次运行实例（`RuntimeHandle`：send/events/close/kill） | `src/runtime/registry.ts` |
| **Runtime** 运行时 | 成员背后的执行器：原生 agent 或外部 CLI connector | `MemberRuntime` 命名注册表 |
| **Connector** 连接器 | 外部 CLI agent（codex/kimi/opencode/hermes…）适配 | `src/connectors/` |

---

## 三、架构总览

```
┌─────────────────────────────── 前端 / 外部接入 ───────────────────────────────┐
│   React 团队面板等                        createHoneycombClient (client SDK) │
│        │ REST + WS 事件推送                        │ 类型化方法 / 自动重连     │
└────────┼───────────────────────────────────────────┼──────────────────────────┘
         ▼                                           ▼
┌────────────────────── transport ──────────────────────────────────────────────┐
│   HoneycombTransport (port) · Router(31 端点) · SubscribeCenter(WS 订阅)      │
│   NodeHttpAdapter / NodeWsAdapter（真实 HTTP+WS） · MemoryTransport（测试桩）   │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   ▼
┌────────────────────── 编排核心（Cordis 上下文） ──────────────────────────────┐
│  ctx.hive  ctx.roster  ctx.ledger  ctx.courier  ctx.mandate  ← 5 个服务        │
│  consumer/orchestration-loop（queen 派工闭环，事件驱动）                       │
│  runtime/registry (MemberRuntime) · runtime/fiber (生命周期)                   │
│  runtime/agent-runtime (SessionEvent → WorkState 胶水)                        │
│  connectors/（外部 CLI agent 检测/适配/桥接）                                  │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   ▼
┌────────────────────── 事件溯源 ───────────────────────────────────────────────┐
│  HiveFact（13 类事实）→ FactBackend.append（append-only）                      │
│  JsonlFactBackend：~/.dfh/hive/<hiveId>/facts.ndjson（损坏行跳过+告警）         │
│  启动时 replay(facts) → 派生快照（Hive/Member/Task/Message 全量恢复）           │
└───────────────────────────────────────────────────────────────────────────────┘
```

分层说明：

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 领域模型 | 纯数据的 DTO（`Hive/Member/Task/Message`…），零框架依赖 | `src/types.ts` |
| 5 个服务 | hive / roster / ledger / courier / mandate（公开方法见 §6.2） | `src/services/` |
| 编排循环 | queen 派工：runnable 判定 → capability 匹配 → 交付闭环 → 阻塞恢复 → 失败重派（事件驱动，不轮询） | `src/consumer/orchestration-loop.ts` |
| 运行时 | `MemberRuntime` 命名注册表 + `fiber`（hatch/dismiss 托管）+ agent-runtime 胶水 | `src/runtime/` |
| 连接器 | 外部 CLI agent 的 detect/spawn/事件标准化 | `src/connectors/` |
| 传输 | HTTP/WS 服务端 + 内存桩 + 类型化客户端 SDK | `src/transport/` |
| 持久化 | 事实日志 + 重放 → 快照 | `src/persistence/` |

---

## 四、安装与最小示例

```bash
# 从仓库（monorepo 工作区）
pnpm install            # 或 npm install
# 依赖 peer：@deepseek-ai/cordis（与 deepseek-harness 同源）
```

**嵌入最小示例**（进程内装配 5 个服务）：

```ts
import { Context, apply } from '@whalepod/honeycomb'

const ctx = new Context()
await apply(ctx, { persistenceDir: '.dfh/hive' })

// 建 hive（自动孵化一名 queen）
const hive = await ctx.hive.create({ name: 'docs', workspace: '/tmp/docs' })

// 孵化一名 worker（backend 需先在 roster 注册过运行时，默认有 'native'）
const worker = await ctx.roster.hatch(hive.id, { name: 'w1', backend: 'native' })

// 派工：queen 建任务 → worker 收到指令
await ctx.ledger.create(hive.id, { subject: '写文档', owner: worker.id })
await ctx.courier.send(hive.id, {
  from: hive.queenId, to: worker.id, kind: 'directive', content: '开工',
})

console.log(await ctx.roster.list(hive.id))
```

**起 HTTP+WS transport（供前端联调）**——两种方式等价：

```ts
// 方式 A：apply 时开启（config.transport.enabled）
await apply(ctx, {
  persistenceDir: '.dfh/hive',
  transport: { enabled: true, port: 0 }, // port 0 = 随机可用端口
})

// 方式 B：显式创建
import { createNodeTransportServer } from '@whalepod/honeycomb'
const server = await createNodeTransportServer(ctx, { host: '127.0.0.1', port: 0 })
console.log(`transport 就绪: http://${server.host}:${server.port}`)
// 结束时: await server.close()
```

---

## 五、quickstart 指引

`examples/hive-quickstart/` 提供**一条命令跑通**完整一圈的活示例（boot → 建 hive → 孵化 worker → 建任务 → 编排流转 → 消息 → 打印关键事件流）：

```bash
cd packages/honeycomb
npm run example        # 或按 examples/hive-quickstart/README.md 的指引
```

- 当前示例默认走 **mock 驱动**（把「建 hive → 孵化 → 建任务 → 派工 → 交付 → courier 消息 → 落盘恢复」显式演出来，确定、可读）；想切到真实的 `consumer/orchestration-loop.ts` 事件驱动循环，见 examples/hive-quickstart/README.md「切到真编排循环」一节（含模板代码 + 两处已知阻塞 bug 说明，需循环 owner 先修，任务边界不改 src/）；
- 想改行为参数（如 `idleTimeoutMs`、runtimes），见 §6.5 `HoneycombConfig` 字段表。

---

## 六、API 参考

> transport 端点的**完整契约**（31 个 REST 端点清单、WS 消息 schema、错误码）见 **`../../docs/honeycomb-transport-api.md`**（仓库根 `docs/` 下的权威文档，本 README 只做摘要与 SDK 用法，不重复）。事件主题清单见 §6.4。

### 6.1 入口与装配

| 入口 | 签名 | 语义 |
| --- | --- | --- |
| `apply` | `apply(ctx: Context, config?: HoneycombConfig): Promise<void>` | 装配 5 个服务 + 持久化 + 运行时 + 可选 transport server |
| `createNodeTransportServer` | `(ctx, opts?: { host?, port?, wsPath? }) → Promise<NodeTransportServerHandle>` | 起真实 HTTP+WS 服务；`host` 默认 `127.0.0.1`，`port` 默认 `0`（随机；注意与 `config.transport` 的默认 `8765` 不同），`wsPath` 默认 `/ws`；句柄含 `{ transport, host, port, close() }` |
| `createHoneycombClient` | `(opts: HoneycombClientOptions) → HoneycombClient` | 前端类型化客户端（见 §6.7） |

### 6.2 五个服务的公开方法（以 `src/services/` 现状为准）

**`ctx.hive`（HiveService）** — 蜂群生命周期：

| 方法 | 签名 | 语义 |
| --- | --- | --- |
| create | `create(input: CreateHiveInput) → Promise<Hive>` | 建 hive（自动孵化 queen）；`CreateHiveInput = { name, workspace, workspaceMode?, sessionMode?, queen? }` |
| list | `list() → Promise<Hive[]>` | 全部 hive |
| get | `get(id: HiveId) → Promise<Hive \| undefined>` | 单个 hive |
| rename | `rename(id: HiveId, name: string) → Promise<void>` | 改名 |
| setMode | `setMode(id: HiveId, mode: 'shared' \| 'isolated') → Promise<void>` | 工作区模式 |
| setSessionMode | `setSessionMode(id: HiveId, sessionMode: string) → Promise<void>` | 会话权限模式（孵化继承） |
| remove | `remove(id: HiveId) → Promise<void>` | 解散 hive（mandate: `hive.remove`） |

**`ctx.roster`（RosterService）** — 成员注册表：

| 方法 | 签名 | 语义 |
| --- | --- | --- |
| register | `register(hiveId, input: RegisterMemberInput) → Promise<Member>` | 注册成员（不拉起会话）；`RegisterMemberInput = { name, role?, backend, connectorId?, model? }` |
| hatch | `hatch(hiveId, input: HatchMemberInput) → Promise<Member>` | 注册 + 拉起运行时会话（孵化）；`HatchMemberInput` 追加 `cwd?`（默认继承 hive.workspace） |
| list | `list(hiveId) → Promise<Member[]>` | 成员列表 |
| get | `get(hiveId, memberId) → Promise<Member \| undefined>` | 单个成员 |
| remove | `remove(hiveId, memberId) → Promise<void>` | 移除成员 |
| rename | `rename(hiveId, memberId, name) → Promise<void>` | 改名 |
| dismiss | `dismiss(hiveId, memberId) → Promise<void>` | 遣散（优雅下线，走 shutdown 协商） |
| state | `state(hiveId, memberId) → Promise<MemberStateView>` | 状态视图：`{ memberId, status, workState, blockedReason?, queued: {foreground, background}, activeTurnId? }` |
| registerRuntime | `registerRuntime(runtime: MemberRuntime) → Promise<void>` | 注册命名运行时后端（如 `'native'`） |
| listRuntimes | `listRuntimes() → Promise<MemberRuntime[]>` | 已注册运行时 |
| sendTo | `sendTo(hiveId, memberId, msg: RuntimeMessage) → Promise<boolean>` | 向成员会话投递指令（store/forward）；`RuntimeMessage = { role, content }` |

**`ctx.ledger`（LedgerService）** — 任务账本：

| 方法 | 签名 | 语义 |
| --- | --- | --- |
| create | `create(hiveId, input: CreateTaskInput) → Promise<Task>` | 建任务；`CreateTaskInput = { subject, description?, owner?, blockedBy? }` |
| get | `get(id: TaskId) → Promise<Task \| undefined>` | 单个任务 |
| update | `update(id: TaskId, patch: TaskPatch) → Promise<Task>` | 更新；`TaskPatch = Partial<Pick<Task,'subject'\|'description'\|'status'\|'owner'>>` |
| addDependency | `addDependency(taskId, blockedBy: TaskId) → Promise<void>` | 加依赖边（task 被 blockedBy 阻塞） |
| removeDependency | `removeDependency(taskId, blockedBy: TaskId) → Promise<void>` | 删依赖边 |
| setOwner | `setOwner(taskId, owner: MemberId \| null) → Promise<void>` | 指派/回收 owner |
| list | `list(hiveId, filter?: TaskFilter) → Promise<Task[]>` | 任务列表；`TaskFilter = { status?, owner?, runnable?, limit? }`（`runnable` 仅返回无未完成依赖阻塞的任务） |

**`ctx.courier`（CourierService）** — 消息：

| 方法 | 签名 | 语义 |
| --- | --- | --- |
| send | `send(hiveId, msg: OutgoingMessage) → Promise<Message>` | 发送（经 `courier/outgoing` waterfall，被拒则抛 `MessageDroppedError`）；`OutgoingMessage = { from, to, kind, content, summary?, attachments? }` |
| deliver | `deliver(hiveId, msg: OutgoingMessage) → Promise<MessageId>` | 直投（绕过 waterfall，返回消息 id） |
| inbox | `inbox(hiveId, recipient: MessageRecipient, filter?: InboxFilter) → Promise<Message[]>` | 收件箱；`InboxFilter = { unreadOnly?, from?, limit? }` |
| markRead | `markRead(hiveId, messageId) → Promise<void>` | 标记已读（发 `message/read`） |
| broadcast | `broadcast(hiveId, from: MessageSender, content: string) → Promise<void>` | 群发全体成员（mandate: `courier.broadcast`） |
| feed | `feed(hiveId, cursor?: FeedCursor, limit?: number) → Promise<ActivityPage>` | 活动流；`FeedCursor = { ts, id }`；`ActivityPage = { items, nextCursor?, hasMore }` |

**`ctx.mandate`（MandateService）** — 授权：

| 方法 | 签名 | 语义 |
| --- | --- | --- |
| can | `can(actor: MemberId, action: MandateAction, scope?: MandateScope) → boolean` | 查询是否允许 |
| assert | `assert(actor, action, scope?) → void` | 不允许时抛 `MandateDeniedError` |
| grants | `grants(member: MemberId) → MandateGrant[]` | 成员全部授权结论；`MandateGrant = { action, verdict: 'granted'\|'denied'\|'owner-scoped', reason? }` |

`MandateAction` 共 12 项：`hive.remove` `hive.rename` `hive.set-mode` `roster.hatch` `roster.dismiss` `roster.register` `ledger.create` `ledger.update` `ledger.assign` `courier.send` `courier.broadcast` `hive.shutdown`。
默认策略：queen 全授权；worker 仅 `courier.send` 全局 + `ledger.update`（owner 限定，`scope.taskId`）可放行，其余拒绝（可经 `config.mandate.allowOverrides` 开关，见 §6.5）。

### 6.3 领域类型速查（`src/types.ts`）

| 类型 | 关键字段 / 取值 |
| --- | --- |
| `Hive` | `id, name, workspace, workspaceMode, queenId, sessionMode?, createdAt, updatedAt` |
| `Member` | `id, hiveId, name, role: 'queen'\|'worker', backend, connectorId?, status, model?, icon?, createdAt, updatedAt` |
| `MemberStatus` | `'hatching' \| 'idle' \| 'working' \| 'finished' \| 'failed' \| 'dormant'` |
| `WorkState` | `'idle' \| 'queued' \| 'starting' \| 'running' \| 'paused' \| 'blocked'` |
| `Task` | `id, hiveId, subject, description?, status, owner?, blockedBy[], blocks[], createdAt, updatedAt` |
| `TaskStatus` | `'backlog' \| 'in-progress' \| 'completed' \| 'cancelled' \| 'blocked'` |
| `Message` | `id, hiveId, from, to, kind, content, summary?, attachments[], read, createdAt` |
| `MessageKind` | `'directive' \| 'report' \| 'note' \| 'shutdown-request' \| 'system'` |
| `MessageSender / Recipient` | `MemberId \| 'user' \| 'system'` / `MemberId \| 'all'` |
| `ActivityItem` | `{ kind: 'message'; message } \| { kind: 'task'; task }` |

### 6.4 事件主题清单（`HiveEventMap`，`src/events.ts`）

WS 推送主题与进程内事件表**同一套**（`subscribe.ts` 的 `PUSHED_TOPICS`）：

| 主题 | payload | 触发 |
| --- | --- | --- |
| `hive/created` | `{ hive }` | hive 创建 |
| `hive/renamed` | `{ hiveId, name }` | hive 改名 |
| `hive/removed` | `{ hiveId }` | hive 解散 |
| `member/hatched` | `{ hiveId, member }` | 成员孵化 |
| `member/dismissed` | `{ hiveId, memberId }` | 成员遣散 |
| `member/status` | `{ hiveId, memberId, status, note? }` | 成员状态转移 |
| `member/work-state` | `{ hiveId, memberId, state, blockedReason? }` | 会话工作状态转移 |
| `task/created` | `{ task }` | 建任务 |
| `task/updated` | `{ task, change: 'status'\|'owner'\|'dependency'\|'description' }` | 任务更新（含依赖/owner 变更） |
| `message/created` | `{ message }` | 新消息 |
| `message/read` | `{ hiveId, messageId }` | 消息已读 |

### 6.5 HoneycombConfig 全字段（`src/config.ts`）

| 字段 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `defaultWorkspaceMode` | `'shared' \| 'isolated'` | `'shared'` | 新 hive 默认工作区模式 |
| `idleTimeoutMs` | `number` | 0（永不） | worker 空闲超时自动 dismiss |
| `mandate.allowOverrides` | `boolean` | `true` | 是否允许 owner-scoped / 显式授权覆盖默认策略 |
| `runtimes` | `string[]` | `['native']` | 启动时注册的运行时后端 id 列表 |
| `persistence` | `'jsonl' \| 'sqlite'` | `'jsonl'` | 存储后端（sqlite 未实现时回落 jsonl） |
| `persistenceDir` | `string` | `~/.dfh/hive` | 事实日志根目录（每 hive 一个 `facts.ndjson`） |
| `transport.enabled` | `boolean` | `false` | apply 时是否自动起 HTTP+WS server |
| `transport.host` | `string` | `'127.0.0.1'` | 监听地址 |
| `transport.port` | `number` | `8765` | 监听端口（config 默认 8765；`0` = 随机可用） |

### 6.6 transport 端点摘要（完整契约见 `../../docs/honeycomb-transport-api.md`）

REST 共 **31 个端点**，按域划分（wire 信封统一为 `{ status, body: { ok:true, data } | { ok:false, error:{ code, message } } }`；JSON query 参数如 `filter/cursor/scope` 为**单次 URLSearchParams 编码**）：

| 域 | 端点 |
| --- | --- |
| hive | create / list / get / rename / set-mode / session / remove（7） |
| member | register / hatch / list / get / state / rename / dismiss / remove（8） |
| task | create / list / get / update / owner / dependencies(+/-)（7） |
| message | send / deliver / inbox / mark-read / broadcast / feed（6） |
| mandate | can / assert / grants（3） |

WS：`hello` / `subscribe {hiveId}` / `unsubscribe {hiveId}`；服务端 ack `subscribed`/`unsubscribed`/`hello.ok`；事件帧 `{ type:'event', topic, hiveId, payload }`（topic ∈ §6.4）。

### 6.7 client SDK 用法示例（`createHoneycombClient`，真实签名）

```ts
import { createHoneycombClient } from '@whalepod/honeycomb'

const client = createHoneycombClient({
  httpUrl: 'http://127.0.0.1:8787',
  wsUrl: 'ws://127.0.0.1:8787/ws',
  // 可选：fetch / WebSocket 注入；reconnect: { baseMs?, maxMs? }（默认 500ms → 30s 封顶）
  // ackTimeoutMs?: 默认 5000；headers?: 附加请求头
})
await client.connect()               // 自动 hello；补订完成后 resolve；失败抛 WS_UNAVAILABLE
await client.subscribe(hiveId)       // 未连接时懒连接；断线自动重连并补订，无需前端自管
client.on('task/created', ({ task }) => console.log('新任务:', task.subject))

const runnable = await client.task.list(hiveId, { runnable: true }) // 已解包，直接是 Task[]
const hive = await client.hive.create({ name: 'panel', workspace: '/tmp/panel' })

await client.unsubscribe(hiveId)
await client.close()                 // 永久关闭（同一实例不再自动重连，复用需新建实例）
```

要点：

- 5 个 REST 域方法全覆盖（`client.hive/member/task/message/mandate`），自动解包 `{ok,data}`；失败抛 `HoneycombTransportError{ code, status }`（如 `NOT_FOUND`(404) / `FORBIDDEN`(403) / `NETWORK_ERROR` / `WS_UNAVAILABLE`）；
- `filter/cursor/scope` 等 JSON query 参数**直接传对象**（如 `{ runnable: true }`），客户端负责单次 JSON 编码；
- `on(topic, handler)` 返回取消订阅函数；`connected` 为**就绪语义**（socket 已 OPEN 且重连补订全部 ack 完成）；
- 类型全部 `import type` 自包内 DTO（`types.ts` / `transport/types.ts` / `events.ts`），前端无需另造类型；
- 零运行时第三方依赖（`globalThis.fetch` + 平台 WebSocket）。

---

## 七、事件溯源：事实日志与重放

### 7.1 事实词汇（`HiveFact`，共 13 类）

| 事实 | 字段 | 说明 |
| --- | --- | --- |
| `hive-created` | `{ hive }` | 全量 hive 快照 |
| `hive-renamed` | `{ hiveId, name }` | 改名 |
| `hive-updated` | `{ hiveId, patch }` | 模式/会话等增量更新 |
| `hive-removed` | `{ hiveId }` | 解散 |
| `member-registered` | `{ member }` | 注册（含孵化） |
| `member-renamed` | `{ memberId, name }` | 改名 |
| `member-status` | `{ memberId, status }` | 状态转移 |
| `member-dismissed` | `{ memberId }` | 遣散 |
| `task-created` | `{ task }` | 全量任务快照 |
| `task-updated` | `{ taskId, patch }` | 增量更新 |
| `task-dependency` | `{ taskId, blockedBy, op: 'add'\|'remove' }` | 依赖边变更 |
| `message-created` | `{ message }` | 全量消息快照 |
| `message-read` | `{ messageId }` | 已读 |

每条落盘为 `FactRecord = { seq: number; at: number; hiveId: HiveId; fact: HiveFact }`（`seq` 单调递增，`at` 时间戳）。

### 7.2 append-only 语义

- 事实**只追加、永不修改/删除**——服务层每次状态变更先 `backend.append(record)` 成功后才更新内存快照并 emit 事件；
- 介质为 `JsonlFactBackend`：每 hive 一个文件 `facts.ndjson`（`{persistenceDir}/{hiveId}/facts.ndjson`，默认根 `~/.dfh/hive`），一行一条 JSON；
- 写入失败/损坏行（无法解析或未知事实类型）**跳过并告警**（`onWarn` 回调），不中断启动。

### 7.3 重放语义

- 启动时按 `seq` 顺序 `replay(hiveId?)` 读回全部事实，经纯函数 `replay(facts)`（`src/persistence/store.ts`）逐条应用，重建派生快照：`hives() / hive(id) / membersOf(hiveId) / tasksOf(hiveId) / messagesOf(hiveId)` 等查询全部来自快照；
- 幂等可审计：同一份日志在任何机器/任何时刻重放，得到同一份状态；
- 追加日志即备份——无需数据库迁移，历史可完整回溯。

---

## 八、测试与验证

```bash
cd packages/honeycomb
npx tsx test/smoke.ts                        # 传输层 smoke（REST 信封 + WS 事件推送）
npx tsx --test test/transport-client.test.ts # client SDK 7 用例：方法映射/错误解包/重连补订/ack-before-ready/WS_UNAVAILABLE
npx tsx --test test/persistence.test.ts      # 事实日志落盘 + 重放 + 损坏容忍
npx tsx --test test/e2e-core.test.ts         # 核心端到端（services×persistence×events）
npm run example        # 活示例 = examples/hive-quickstart/index.ts（详见其 README）
```

---

## 九、状态与文档同步

| 事项 | 状态 |
| --- | --- |
| 5 个服务 + 事件溯源 + transport（服务端 + client SDK） | ✅ 已实现，测试绿 |
| 编排循环（queen 派工） | ✅ 已实现（含看门狗） |
| 连接器（外部 CLI agent 适配） | ✅ 已实现（opencode 实测过链路） |
| **cordis 全量迁移**（framework shim → 真 `@deepseek-ai/cordis`） | 🔄 进行中（编排-Pro）——迁移后若公开 API 有变，本 README 由 实现-Pro-2 增量修订 |
| 品牌收束（`@whalepod/honeycomb` → `@whalepod/honeycomb`、鲸群 WhalePod 更名） | ⏳ 待执行（见任务板【品牌收束】） |

文档基线：`2026-08-14`（以当前代码为准）。
