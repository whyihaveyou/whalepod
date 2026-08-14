/**
 * Honeycomb domain model (§3) and cross-service DTOs (§5 / §6).
 *
 * Everything here is pure data — no framework imports — so the domain model
 * stays independent of the Cordis seam and is trivially unit-testable.
 *
 * @module @dfh/honeycomb/types
 */

// -- identifiers ------------------------------------------------------------

export type HiveId = string
export type MemberId = string
export type TaskId = string
export type MessageId = string

// -- Hive -------------------------------------------------------------------

export type HiveWorkspaceMode = 'shared' | 'isolated'

export interface Hive {
  id: HiveId
  name: string
  /** 工作目录（绝对路径） */
  workspace: string
  workspaceMode: HiveWorkspaceMode
  /** 蜂后（leader）的成员 id；一个 hive 有且仅有一个 queen */
  queenId: MemberId
  /** 会话权限模式（如 "plan" / "auto"），孵化新成员时继承 */
  sessionMode?: string
  createdAt: number
  updatedAt: number
}

// -- Member -----------------------------------------------------------------

export type MemberRole = 'queen' | 'worker'

export type MemberStatus =
  | 'hatching' // 孵化中（运行时启动）
  | 'idle' // 就绪，无任务
  | 'working' // 执行中
  | 'finished' // 当前轮次完成
  | 'failed' // 运行时/执行失败
  | 'dormant' // 休眠（挂起/暂停）

export interface Member {
  id: MemberId
  hiveId: HiveId
  name: string
  role: MemberRole
  /** 运行时后端：原生 agent 或外部 CLI connector */
  backend: string
  /** 回指连接器注册表里的 connector id（外部 CLI 时非空） */
  connectorId?: string | null
  status: MemberStatus
  model?: string
  icon?: string
  createdAt: number
  updatedAt: number
}

// -- Task -------------------------------------------------------------------

export type TaskStatus = 'backlog' | 'in-progress' | 'completed' | 'cancelled' | 'blocked'

export interface Task {
  id: TaskId
  hiveId: HiveId
  subject: string
  description?: string
  status: TaskStatus
  /** 拥有者（可空 = 未指派） */
  owner?: MemberId
  /** 依赖边：被哪些任务阻塞 */
  blockedBy: TaskId[]
  /** 反向边：阻塞了哪些任务（派生，便于查询） */
  blocks: TaskId[]
  createdAt: number
  updatedAt: number
}

// -- Message ----------------------------------------------------------------

export type MessageKind =
  | 'directive' // 指令（queen → worker 的派工）
  | 'report' // 汇报（worker → queen 的交付）
  | 'note' // 普通成员间消息
  | 'shutdown-request' // 遣散请求（见 §6.4）
  | 'system' // 系统消息

export type MessageSender = MemberId | 'user' | 'system'
export type MessageRecipient = MemberId | 'all'

export interface Message {
  id: MessageId
  hiveId: HiveId
  from: MessageSender
  to: MessageRecipient
  kind: MessageKind
  content: string
  summary?: string
  attachments: string[]
  read: boolean
  createdAt: number
}

// -- Hive service DTOs (§5.1) -----------------------------------------------

export interface CreateHiveInput {
  name: string
  workspace: string
  workspaceMode?: HiveWorkspaceMode // 默认 "shared"
  sessionMode?: string
  /** 首任 queen 的成员配置；缺省时孵化一个默认原生 agent */
  queen?: HatchMemberInput
}

// -- Ledger service DTOs (§5.2) ---------------------------------------------

export interface CreateTaskInput {
  subject: string
  description?: string
  owner?: MemberId
  blockedBy?: TaskId[]
}

export type TaskPatch = Partial<Pick<Task, 'subject' | 'description' | 'status' | 'owner'>>

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  owner?: MemberId
  /** 仅返回可执行（无未完成依赖阻塞）的任务 */
  runnable?: boolean
  limit?: number
}

// -- Courier service DTOs (§5.3) --------------------------------------------

export interface OutgoingMessage {
  from: MessageSender
  to: MessageRecipient
  kind: MessageKind
  content: string
  summary?: string
  attachments?: string[]
}

export interface InboxFilter {
  unreadOnly?: boolean
  from?: MessageSender
  limit?: number
}

export type ActivityItem =
  | { kind: 'message'; message: Message }
  | { kind: 'task'; task: Task }

export interface ActivityPage {
  items: ActivityItem[]
  nextCursor?: FeedCursor
  hasMore: boolean
}

export interface FeedCursor {
  ts: number
  id: string
}

// -- Mandate service DTOs (§5.4) --------------------------------------------

export type MandateAction =
  // 团队级（queen-only）
  | 'hive.remove'
  | 'hive.rename'
  | 'hive.set-mode'
  // 名册级（queen-only）
  | 'roster.hatch'
  | 'roster.dismiss'
  | 'roster.register'
  // 台账级
  | 'ledger.create' // queen-only
  | 'ledger.update' // queen 或任务 owner
  | 'ledger.assign' // queen-only
  // 信使级
  | 'courier.send' // 任意成员
  | 'courier.broadcast' // queen-only
  // 生命周期
  | 'hive.shutdown' // queen-only

export interface MandateScope {
  hiveId?: HiveId
  /** 台账更新时校验「是否为该任务 owner」 */
  taskId?: TaskId
}

export interface MandateGrant {
  action: MandateAction
  /** granted | denied | owner-scoped */
  verdict: 'granted' | 'denied' | 'owner-scoped'
  reason?: string
}

// -- Roster service DTOs (§6.1) ---------------------------------------------

export interface RegisterMemberInput {
  name: string
  role?: MemberRole // 默认 "worker"
  backend: string // 命名注册表中的运行时后端 id
  connectorId?: string | null
  model?: string
}

export interface HatchMemberInput extends RegisterMemberInput {
  cwd?: string // 孵化时的工作目录（默认继承 hive.workspace）
}

export type WorkState = 'idle' | 'queued' | 'starting' | 'running' | 'paused' | 'blocked'

export interface MemberStateView {
  memberId: MemberId
  status: MemberStatus
  workState: WorkState
  blockedReason?: string | null
  /** 队列深度（前台/后台） */
  queued: { foreground: number; background: number }
  activeTurnId?: string | null
}
