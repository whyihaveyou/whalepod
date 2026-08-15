# @whalepod/honeycomb 编排核心插件设计文档

> 文档编号：WP / HONEY-001
> 产品：鲸群 WhalePod
> 核心包：`@whalepod/honeycomb`（NPM：`dsh-honeycomb`）
> 责任人：架构-Pro-1
> 状态：设计稿 v1（概念级重实现）
> 依赖文档：[repo-map.md](./repo-map.md)、[connector-architecture.md](./connector-architecture.md)（连接器层唯一契约面）、[harness-feature-inventory.md](../harness-feature-inventory.md)

---

## 0. 摘要

`@whalepod/honeycomb` 是 鲸群 WhalePod 的**多智能体编排核心插件**。它把「多个 agent 组成一个团队、leader 分派任务、agent 之间互通消息、按角色授权、空闲状态机调度、运行时孵化/遣散」这一套协作模型，**概念级重实现**在 DeepSeek Harness 的 Cordis 原语之上。

**核心原则：**

1. **不用 AionUi 的任何类名 / API 名**。团队、成员、任务板、消息总线、权限、状态机全部以 honeycomb 自有词汇命名（见 §2 映射表）。
2. **不引入「特权内核」**。honeycomb 本身只是若干 Cordis 插件，通过 `ctx.provide` 暴露 6 个服务，任何其它插件（连接器、前端、策略）都可替换或拦截。
3. **事件溯源 + 派生状态**。hive 的成员、任务、消息、状态变迁作为**仅追加的持久事实**落库；「当前团队快照」是派生结果，与 harness 的 `SessionEvent` 模型同构。
4. **能力 seam 三分法**。每个服务都拆成 *Service Definition（抽象契约）* + *Provider（可换实现）* + *Consumer（编排层消费方）*；成员运行时（原生 agent / 外部 CLI）走**命名注册表**多实现并存，与 `ctx.subagents` 同构。

---

## 1. 目标与范围

### 1.1 要解决的问题

把 AionUi 的多智能体协作模型映射到 Cordis 原语，产出：

- 一份**架构文档**（本文档）；
- 一份**API surface**：团队 / 任务 / 消息 / 权限 四组服务的接口定义（§5）；
- 成员注册表、idle 状态机、hatch/dismiss 生命周期的设计（§6 / §7）。

### 1.2 非目标

- 不实现外部 CLI agent 的协议解析（见 `connector-architecture.md`，由连接器层负责）。
- 不实现模型路由 / 负载均衡。
- 不实现前端 UI；本设计只定义服务契约与事件词汇，前端经 `ctx.clientModules` 消费。

---

## 2. 概念映射表（AionUi → honeycomb → Cordis）

> 这是本文档的**根**。左列是 AionUi 概念（仅作映射来源，不在代码中出现），中列是 honeycomb 自有词汇，右列是落到 Cordis 的原语。

| AionUi 概念 | honeycomb 概念 | Cordis 原语 | 说明 |
| --- | --- | --- | --- |
| `team`（团队） | **Hive**（蜂巢） | `service` + `persistence`（storage domain） | 一个编排单元；`ctx.hive` |
| `leader` / `teammate`（角色） | **Queen** / **Worker** | 领域枚举（`MemberRole`） | 角色决定 Mandate 授权 |
| `roster`（成员注册表） | **Roster**（名册） | `service` + scope-aware 命名注册表（`NamedEntries`） | `ctx.roster`；成员运行时按后端多实现 |
| `task board`（任务板） | **Ledger**（台账） | `service` + `persistence` + `events` | `ctx.ledger`；任务 + 依赖边 |
| `message bus` / `mailbox` | **Courier**（信使） | `events`（emit/waterfall）+ `persistence` | `ctx.courier`；成员间消息 + 统一活动流 |
| `role permissions`（角色权限） | **Mandate**（授权） | `service` + waterfall guard | `ctx.mandate`；lead-only 工具由 waterfall 裁决 |
| `idle state machine`（空闲状态机） | **MemberStatus / WorkState** | `lifecycle`（Fiber/FiberState）+ `events` | 见 §7 |
| `spawn` / `shutdown`（生命周期） | **hatch** / **dismiss** | `lifecycle`（Fiber + disposer）+ `service` | 见 §6 |
| `team.created` 等事件 | `hive/*`、`member/*` | `events`（scope-filtered） | 见 §8 |
| `activity feed`（活动流） | `Courier.feed()` | `persistence` 查询（会话查询同构） | 消息 + 任务统一分页 |
| `TeammateDescriptor`（连接器契约） | `Member` 的 `runtime` 后端输入 | `service`（连接器注册表） | 见 §6.3 |

**命名纪律**：honeycomb 命名全部取「蜂巢」隐喻（Hive / Queen / Worker / Roster / Ledger / Courier / Mandate / hatch / dismiss），从根上杜绝与 AionUi 类名（`TTeam`、`TeamAssistant`、`ITeamTaskItem`、`ITeamMailboxMessage`、`TeammateStatus` 等）的撞名与概念混淆。

---

## 3. 领域模型（Domain Model）

### 3.1 Hive（蜂巢 = 团队）

```ts
type HiveId = string;
type MemberId = string;
type TaskId = string;
type MessageId = string;

/** 工作区共享策略 */
type HiveWorkspaceMode = "shared" | "isolated";

interface Hive {
  id: HiveId;
  name: string;
  /** 工作目录（绝对路径） */
  workspace: string;
  workspaceMode: HiveWorkspaceMode;
  /** 蜂后（leader）的成员 id；一个 hive 有且仅有一个 queen */
  queenId: MemberId;
  /** 会话权限模式（如 "plan" / "auto"），孵化新成员时继承 */
  sessionMode?: string;
  createdAt: number;
  updatedAt: number;
}
```

### 3.2 Member（成员 = 一个 agent 槽位）

```ts
type MemberRole = "queen" | "worker";
type MemberStatus =
  | "hatching"   // 孵化中（运行时启动）
  | "idle"       // 就绪，无任务
  | "working"    // 执行中
  | "finished"   // 当前轮次完成
  | "failed"     // 运行时/执行失败
  | "dormant";   // 休眠（挂起/暂停）

interface Member {
  id: MemberId;
  hiveId: HiveId;
  name: string;
  role: MemberRole;
  /** 运行时后端：原生 agent 或外部 CLI connector */
  backend: string;
  /** 回指连接器注册表里的 connector id（外部 CLI 时非空） */
  connectorId?: string | null;
  status: MemberStatus;
  model?: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
}
```

### 3.3 Task（任务 = 台账条目）

```ts
type TaskStatus = "backlog" | "in-progress" | "completed" | "cancelled" | "blocked";

interface Task {
  id: TaskId;
  hiveId: HiveId;
  subject: string;
  description?: string;
  status: TaskStatus;
  /** 拥有者（可空 = 未指派） */
  owner?: MemberId;
  /** 依赖边：被哪些任务阻塞 */
  blockedBy: TaskId[];
  /** 反向边：阻塞了哪些任务（派生，便于查询） */
  blocks: TaskId[];
  createdAt: number;
  updatedAt: number;
}
```

### 3.4 Message（消息 = 信使投递单元）

```ts
type MessageKind =
  | "directive"        // 指令（queen → worker 的派工）
  | "report"           // 汇报（worker → queen 的交付）
  | "note"             // 普通成员间消息
  | "shutdown-request" // 遣散请求（见 §6.4）
  | "system";          // 系统消息

type MessageSender = MemberId | "user" | "system";
type MessageRecipient = MemberId | "all";

interface Message {
  id: MessageId;
  hiveId: HiveId;
  from: MessageSender;
  to: MessageRecipient;
  kind: MessageKind;
  content: string;
  summary?: string;
  attachments: string[];
  read: boolean;
  createdAt: number;
}
```

---

## 4. Cordis 原语落地总览

| Cordis 原语 | honeycomb 用法 |
| --- | --- |
| **service** | `ctx.provide("hive", ...)` 等 6 个服务；成员运行时后端走命名注册表（`ctx.roster.registerRuntime`）多实现并存 |
| **events** | `hive/*`、`member/*`、`task/*`、`message/*` 为 scope-filtered `emit`；`mandate/decide`、`courier/outgoing` 为 `waterfall` 拦截链 |
| **lifecycle** | `hatch` 用 `ctx.effect`/Fiber 托管成员运行时；`dismiss` 触发 disposer 回收；`MemberStatus` 镜像 `FiberState` |
| **config** | `honeycomb` 配置块（StandardSchema 校验）：hives 列表、idle 阈值、mandate 策略、成员默认值 |
| **persistence** | storage domain `hive`：hive/member/task/message 的仅追加事实日志 + 派生的当前快照（§9） |

---

## 5. API Surface（服务接口定义）

> 下列接口为 **Service Definition（抽象契约）**。Provider 实现可换；Consumer（编排循环、前端、策略插件）只依赖这些接口，不感知实现细节。

### 5.1 团队服务 `ctx.hive`

```ts
interface HiveService {
  create(input: CreateHiveInput): Promise<Hive>;
  list(): Promise<Hive[]>;
  get(id: HiveId): Promise<Hive | undefined>;
  rename(id: HiveId, name: string): Promise<void>;
  setMode(id: HiveId, mode: HiveWorkspaceMode): Promise<void>;
  setSessionMode(id: HiveId, mode: string): Promise<void>;
  remove(id: HiveId): Promise<void>;
}

interface CreateHiveInput {
  name: string;
  workspace: string;
  workspaceMode?: HiveWorkspaceMode;   // 默认 "shared"
  sessionMode?: string;
  /** 首任 queen 的成员配置；缺省时孵化一个默认原生 agent */
  queen?: HatchMemberInput;
}
```

### 5.2 任务服务 `ctx.ledger`

```ts
interface LedgerService {
  create(hiveId: HiveId, input: CreateTaskInput): Promise<Task>;
  get(id: TaskId): Promise<Task | undefined>;
  update(id: TaskId, patch: TaskPatch): Promise<Task>;
  list(hiveId: HiveId, filter?: TaskFilter): Promise<Task[]>;
  /** 建立依赖：`taskId` 被 `blockedBy` 阻塞 */
  addDependency(taskId: TaskId, blockedBy: TaskId): Promise<void>;
  removeDependency(taskId: TaskId, blockedBy: TaskId): Promise<void>;
  setOwner(taskId: TaskId, owner: MemberId | null): Promise<void>;
}

interface CreateTaskInput {
  subject: string;
  description?: string;
  owner?: MemberId;
  blockedBy?: TaskId[];
}

type TaskPatch = Partial<
  Pick<Task, "subject" | "description" | "status" | "owner">
>;

interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  owner?: MemberId;
  /** 仅返回可执行（无未完成依赖阻塞）的任务 */
  runnable?: boolean;
  limit?: number;
}
```

**依赖语义**：`blockedBy` / `blocks` 互为反向，`setOwner` 与 `addDependency` 都走单一写路径（避免双写不一致）；`runnable` 由「所有 `blockedBy` 均已 completed」派生，不单独落库。

### 5.3 消息服务 `ctx.courier`

```ts
interface CourierService {
  /** 同步投递并返回完整 Message（内部走 `courier/outgoing` waterfall） */
  send(hiveId: HiveId, msg: OutgoingMessage): Promise<Message>;
  /** 异步入队（返回投递回执，用于批处理/离线成员） */
  deliver(hiveId: HiveId, msg: OutgoingMessage): Promise<MessageId>;
  /** 读取某成员的收件箱 */
  inbox(hiveId: HiveId, recipient: MemberId, opts?: InboxFilter): Promise<Message[]>;
  /** 标记已读 */
  markRead(hiveId: HiveId, messageId: MessageId): Promise<void>;
  /** 广播给所有 worker（不含 user/system） */
  broadcast(hiveId: HiveId, from: MemberId, content: string): Promise<void>;
  /** 统一活动流（消息 + 任务混合，keyset 分页） */
  feed(hiveId: HiveId, cursor?: FeedCursor): Promise<ActivityPage>;
}

interface OutgoingMessage {
  from: MessageSender;
  to: MessageRecipient;
  kind: MessageKind;
  content: string;
  summary?: string;
  attachments?: string[];
}

interface InboxFilter {
  unreadOnly?: boolean;
  from?: MessageSender;
  limit?: number;
}

type ActivityItem =
  | { kind: "message"; message: Message }
  | { kind: "task"; task: Task };

interface ActivityPage {
  items: ActivityItem[];
  nextCursor?: FeedCursor;
  hasMore: boolean;
}

interface FeedCursor { ts: number; id: string; }
```

### 5.4 权限服务 `ctx.mandate`

```ts
interface MandateService {
  can(actor: MemberId, action: MandateAction, scope?: MandateScope): Promise<boolean>;
  assert(actor: MemberId, action: MandateAction, scope?: MandateScope): Promise<void>;
  grants(member: Member): MandateGrant[];
}

type MandateAction =
  // 团队级（queen-only）
  | "hive.remove" | "hive.rename" | "hive.set-mode"
  // 名册级（queen-only）
  | "roster.hatch" | "roster.dismiss" | "roster.register"
  // 台账级
  | "ledger.create"        // queen-only
  | "ledger.update"        // queen 或任务 owner
  | "ledger.assign"        // queen-only
  // 信使级
  | "courier.send"         // 任意成员
  | "courier.broadcast"    // queen-only
  // 生命周期
  | "hive.shutdown";       // queen-only

interface MandateScope {
  hiveId?: HiveId;
  /** 台账更新时校验「是否为该任务 owner」 */
  taskId?: TaskId;
}

interface MandateGrant {
  action: MandateAction;
  /** granted | denied | owner-scoped */
  verdict: "granted" | "denied" | "owner-scoped";
  reason?: string;
}
```

**裁决实现**（与 `tools/pre-execute` 同构）：

- `can()` 内部触发 `mandate/decide` **waterfall**，`next()` 委派默认策略；
- 默认策略：`queen` 拥有一切动作；`worker` 仅拥有 `courier.send` 与「owner-scoped 的 `ledger.update`」；
- 任一插件可插入该 waterfall 做**审计 / 收紧 / 放行**，返回 `verdict` 即短路。

### 5.5 服务装配（Cordis 侧）

```ts
// honeycomb/plugin.ts（概念级）
export const name = "honeycomb";

export function apply(ctx: Context, config: HoneycombConfig) {
  ctx.provide("hive", createHiveService(ctx, config));
  ctx.provide("ledger", createLedgerService(ctx, config));
  ctx.provide("courier", createCourierService(ctx, config));
  ctx.provide("mandate", createMandateService(ctx, config));
  ctx.provide("roster", createRosterService(ctx, config));

  // 消费方通过注入拿到服务：
  //   ctx.inject(["roster", "ledger"], (roster, ledger) => { ... })
}
```

---

## 6. 名册与生命周期（Roster / hatch / dismiss）

### 6.1 名册服务 `ctx.roster`

```ts
interface RosterService {
  register(hiveId: HiveId, input: RegisterMemberInput): Promise<Member>;
  list(hiveId: HiveId): Promise<Member[]>;
  get(hiveId: HiveId, id: MemberId): Promise<Member | undefined>;
  remove(hiveId: HiveId, id: MemberId): Promise<void>;
  rename(hiveId: HiveId, id: MemberId, name: string): Promise<void>;
  /** 孵化（spawn）：启动成员运行时 */
  hatch(hiveId: HiveId, input: HatchMemberInput): Promise<Member>;
  /** 遣散（shutdown）：回收成员运行时 */
  dismiss(hiveId: HiveId, id: MemberId): Promise<void>;
  /** 成员工作状态视图（idle/queued/starting/running/paused/blocked） */
  state(hiveId: HiveId, id: MemberId): Promise<MemberStateView>;
}

interface RegisterMemberInput {
  name: string;
  role?: MemberRole;            // 默认 "worker"
  backend: string;              // 命名注册表中的运行时后端 id
  connectorId?: string | null;
  model?: string;
}

interface HatchMemberInput extends RegisterMemberInput {
  cwd?: string;                 // 孵化时的工作目录（默认继承 hive.workspace）
}

type WorkState = "idle" | "queued" | "starting" | "running" | "paused" | "blocked";

interface MemberStateView {
  memberId: MemberId;
  status: MemberStatus;
  workState: WorkState;
  blockedReason?: string | null;
  /** 队列深度（前台/后台） */
  queued: { foreground: number; background: number };
  activeTurnId?: string | null;
}
```

### 6.2 成员运行时后端 = 命名注册表

成员「如何跑起来」由**命名注册表**多实现并存（与 `ctx.subagents`、`ctx.llm` 同构）：

```ts
// 运行时后端契约（Service Definition）
interface MemberRuntime {
  readonly id: string;                     // backend id，如 "native" / "external-cli"
  hatch(ctx: Context, input: RuntimeHatchInput): Promise<RuntimeHandle>;
}

interface RuntimeHandle {
  readonly sessionId: string;
  send(msg: RuntimeMessage): Promise<void>;
  events(): AsyncIterable<RuntimeEvent>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

interface RuntimeHatchInput {
  member: Member;
  cwd: string;
  env: Record<string, string>;
}
```

- 原生 agent 后端：一个 provider 实现，直接委托 `ctx.agents.spawn`；
- 外部 CLI 后端：由连接器层注册（见 `connector-architecture.md` 的 `AgentAdapter` / `TeammateDescriptor`），honeycomb 只消费统一契约；
- 注册方式：`ctx.roster.registerRuntime(runtime)` → 存入命名注册表（`NamedEntries`）。

### 6.3 与连接器层契约面的衔接

连接器层的 `TeammateDescriptor`（见 `connector-architecture.md` §3.2）是连接器 ↔ 编排层的**唯一契约面**，映射关系：

| `TeammateDescriptor` 字段 | honeycomb 落点 |
| --- | --- |
| `teammateId` | `Member.id` |
| `displayName` | `Member.name` |
| `origin: "external-cli"` | `Member.backend = "external-cli"` + `Member.connectorId` |
| `connectorId` | `Member.connectorId` |
| `capabilities` | `Mandate.grants()` 的输入（能力矩阵参与授权判定） |
| `session.spawnable` | 决定 `hatch()` 是否可用 |

### 6.4 hatch / dismiss 生命周期（Cordis `lifecycle` 原语）

```
hatch(member)
  → ctx.effect(() => { ... spawn runtime ...; return disposer })
  → 建 Fiber（FiberState: PENDING → LOADING → ACTIVE）
  → Member.status: hatching → idle
  → emit("member/hatched", { member })

dismiss(memberId)
  → 找到该成员的 Fiber，触发 disposer（close/kill 运行时）
  → FiberState: ACTIVE → DISPOSED
  → Member.status → dormant（或直接移除）
  → emit("member/dismissed", { memberId })
```

- **每个成员的运行时被一个 Fiber 托管**：Fiber 的 dispose 即「关进程、回收句柄、清临时状态」，保证 `dismiss` 无泄漏；
- **shutdown-request 协议**：queen 向 worker 发 `MessageKind = "shutdown-request"`；worker 回 `shutdown_approved` / `shutdown_rejected: <reason>` 消息后，queen 才调用 `dismiss`（避免强杀正在写的文件）；
- **idle 超时**：`HoneycombConfig.idleTimeoutMs` 到期后，`ctx.effect` 内的定时器触发自动 `dismiss`（见 §10 配置）。

---

## 7. Idle 状态机（MemberStatus × WorkState）

### 7.1 两个正交维度

- **`MemberStatus`**：成员**生命周期**态（hatching → idle → working → finished/failed/dormant），与 FiberState 镜像；
- **`WorkState`**：成员**工作队列**态（idle/queued/starting/running/paused/blocked），回答「此刻手头有没有活、活卡在哪」。

### 7.2 合法转移表

```
MemberStatus:
  hatching ──▶ idle ──▶ working ──▶ idle        （正常一轮）
                  │          └──▶ finished      （本轮交付）
                  └──▶ failed                   （运行时崩溃 / 执行错误）
  idle ──▶ dormant                              （暂停 / 遣散保留）
  dormant ──▶ idle                              （恢复）

WorkState:
  idle ──▶ queued ──▶ starting ──▶ running ──▶ idle
  running ──▶ paused ──▶ running
  queued/starting/running ──▶ blocked ──▶ queued
```

### 7.3 落地为事件 + 派生视图

- 每次转移 `emit("member/status", {...})` 与 `emit("member/work-state", {...})`（scope-filtered，只投递给同一 hive 的订阅者）；
- `RosterService.state()` 返回的 `MemberStateView` 是**派生视图**，不落库；真实值由最近一条状态事件决定；
- 前端经 `ctx.clientModules` 订阅这两个事件流，即可得到与 AionUi 活动视图等效的实时状态。

---

## 8. 事件模型（Event Model）

> 统一在 `hive` 作用域下 scope-filtered 分发；除标注外均为 `emit`（观察者失败被隔离，不阻塞主链）。

```ts
interface HiveEventMap {
  // 团队
  "hive/created":  { hive: Hive };
  "hive/renamed":  { hiveId: HiveId; name: string };
  "hive/removed":  { hiveId: HiveId };

  // 名册 / 生命周期
  "member/hatched":   { hiveId: HiveId; member: Member };
  "member/dismissed": { hiveId: HiveId; memberId: MemberId };
  "member/status":    { hiveId: HiveId; memberId: MemberId; status: MemberStatus; note?: string };
  "member/work-state":{ hiveId: HiveId; memberId: MemberId; state: WorkState; blockedReason?: string };

  // 台账
  "task/created": { task: Task };
  "task/updated": { task: Task; change: "status" | "owner" | "dependency" | "description" };

  // 信使
  "message/created": { message: Message };
  "message/read":    { hiveId: HiveId; messageId: MessageId };
}
```

**waterfall 钩子**（允许插件拦截/改写/审计，与 `tools/pre-execute` 同构）：

| 钩子 | 语义 |
| --- | --- |
| `mandate/decide` | 权限裁决链；返回 `MandateGrant` 短路，`next()` 委派默认策略 |
| `courier/outgoing` | 消息出口拦截链；可改写、脱敏、丢消息、注入附件 |

---

## 9. 持久化（Persistence）

### 9.1 存储域

- 注册 storage domain `hive`（`ctx.storageDomain`）：hive / member / task / message 的**仅追加事实日志**；
- **事实日志 → 派生快照**：当前 `Hive.members`、`Task.status`、`Message.read` 等都是对事实日志的回放结果（与 `SessionEvent` 派生 LLM 历史同构），从不双写当前状态。

### 9.2 事实类型（概念级）

```ts
type HiveFact =
  | { type: "hive-created"; hive: Hive }
  | { type: "hive-renamed"; hiveId: HiveId; name: string; at: number }
  | { type: "hive-removed"; hiveId: HiveId; at: number }
  | { type: "member-registered"; member: Member; at: number }
  | { type: "member-status"; memberId: MemberId; status: MemberStatus; at: number }
  | { type: "member-dismissed"; memberId: MemberId; at: number }
  | { type: "task-created"; task: Task; at: number }
  | { type: "task-updated"; taskId: TaskId; patch: TaskPatch; at: number }
  | { type: "task-dependency"; taskId: TaskId; blockedBy: TaskId; op: "add" | "remove"; at: number }
  | { type: "message-created"; message: Message; at: number }
  | { type: "message-read"; messageId: MessageId; at: number };
```

### 9.3 后端

复用 harness 持久化抽象：`jsonl`（默认）或 `sqlite`（1 事实 1 行），崩溃恢复沿用 `session/flush` 检查点语义。

---

## 10. 配置（Config）

```ts
interface HoneycombConfig {
  /** 默认 hive 工作区模式 */
  defaultWorkspaceMode?: HiveWorkspaceMode;
  /** 空闲超时（ms）：成员 idle 超过此值自动 dismiss；0 = 不自动 */
  idleTimeoutMs?: number;
  /** 默认 mandate 策略 */
  mandate?: {
    /** 是否允许插件在 mandate/decide waterfall 放行 queen-only 动作 */
    allowOverrides?: boolean;
  };
  /** 名册里预注册的成员运行时后端 */
  runtimes?: string[];
  /** 持久化后端 */
  persistence?: "jsonl" | "sqlite";
}
```

- 经 StandardSchema 校验，`cordis.yml` 可覆盖（与 harness 的 `config-catalog` 一致）；
- `defaultWorkspaceMode`、`idleTimeoutMs` 为**服务级默认**，`CreateHiveInput` 可逐 hive 覆盖。

---

## 11. 目录结构（建议）

```
packages/honeycomb/
  package.json                  # @whalepod/honeycomb（NPM: dsh-honeycomb）
  src/
    plugin.ts                   # apply(ctx, config)：装配 6 个服务
    config.ts                   # HoneycombConfig + StandardSchema
    types.ts                    # 领域模型（Hive/Member/Task/Message）
    events.ts                   # HiveEventMap + waterfall 钩子
    services/
      hive.ts                   # ctx.hive
      ledger.ts                 # ctx.ledger
      courier.ts                # ctx.courier
      mandate.ts                # ctx.mandate
      roster.ts                 # ctx.roster
    runtime/
      registry.ts               # 成员运行时命名注册表
      native-runtime.ts         # 原生 agent 后端（委托 ctx.agents）
      fiber.ts                  # hatch/dismiss 的 Fiber 托管
    persistence/
      facts.ts                  # HiveFact 词汇
      store.ts                  # storage domain 注册 + 回放
      providers/
        jsonl.ts
        sqlite.ts
    consumer/
      orchestration-loop.ts     # 编排循环（消费 roster/ledger/courier）
```

---

## 12. 与其他层的关系

| 层 | 文档 | honeycomb 角色 |
| --- | --- | --- |
| 连接器层 | `connector-architecture.md` | 以 `MemberRuntime` 命名注册表挂载外部 CLI agent；`TeammateDescriptor` 是其契约面 |
| 前端 | （后续） | 经 `ctx.clientModules` + `hive/*` 事件流渲染团队/任务/活动视图 |
| 编排循环 | 本文档 `consumer/orchestration-loop.ts` | 消费 `roster`/`ledger`/`courier`，驱动 queen 分派 → worker 交付 → 状态机转移 |

---

## 13. 关键设计决策记录

1. **命名隔离**：全部使用蜂巢隐喻词汇，杜绝与 AionUi 类名撞名，满足「概念级重实现」的硬约束。
2. **服务三分法**：6 个服务全部是抽象契约 + 可换 Provider，无特权内核；任一 Provider 可替换（例如把 `ledger` 换成远程实现）。
3. **事件溯源**：状态一律由事实日志派生，成员运行时由 Fiber 托管，保证 `dismiss` 可逆、崩溃可恢复。
4. **权限 = waterfall**：`mandate/decide` 与 `courier/outgoing` 复用 harness 的 waterfall 语义，允许策略插件插入而不改核心。
5. **连接器解耦**：honeycomb 只认 `MemberRuntime` 统一契约，不感知 Claude/Codex/Kimi 等具体 CLI，实现编排与接入的彻底分离。
