// ============================================================
// transportDto — @dfh/honeycomb transport 契约的 DTO 类型镜像
// ------------------------------------------------------------
// 依据：docs/honeycomb-transport-api.md（REST 端点 + WS schema）
// 与 packages/honeycomb/src/types.ts 的 DTO/领域模型。
//
// 为什么本地镜像而不是 `import type from '@dfh/honeycomb'`：
// prototypes/team-panel 目前不在 npm/pnpm workspace 里，`@dfh/honeycomb`
// 包不可解析。等 实现-Pro-2 的客户端 SDK（@dfh/honeycomb 的可消费面）
// 落地后，把这里的 `LocalHiveXxx` 换成 `import type { ... } from '@dfh/honeycomb'`
// 即可，字段名与取值完全对齐，无需改业务层。
//
// 本文件只声明类型，是 type-only 的，打包时会被擦除，不引入运行时依赖。
// ============================================================

// ---------- 通用信封（§3 约定） ----------
export interface OkEnvelope<T> {
  ok: true
  data: T
}
export interface ErrEnvelope {
  ok: false
  error: { code: string; message: string }
}
export type ApiEnvelope<T> = OkEnvelope<T> | ErrEnvelope

// ---------- 领域基元 ----------
export type LocalMemberId = string
export type LocalHiveId = string
export type LocalTaskId = string
export type LocalMessageId = string

// ---------- Hive ----------
export interface LocalHive {
  id: LocalHiveId
  name: string
  workspace: string
  workspaceMode: string
  queenId?: LocalMemberId
  createdAt: number
  updatedAt: number
}

// ---------- Member（RosterService DTO） ----------
export type LocalMemberRole = 'queen' | 'worker'
export type LocalMemberStatus =
  | 'hatching'
  | 'idle'
  | 'working'
  | 'waiting'
  | 'paused'
  | 'dismissed'
  | 'failed'

export interface LocalMember {
  id: LocalMemberId
  hiveId: LocalHiveId
  name: string
  role: LocalMemberRole
  backend: string
  connectorId?: string | null
  status: LocalMemberStatus
  model?: string
  icon?: string
  createdAt: number
  updatedAt: number
}

/** `GET /v1/hives/{hiveId}/members/{id}/state` → MemberStateView */
export interface LocalMemberStateView {
  memberId: LocalMemberId
  status: LocalMemberStatus
  workState: LocalWorkState
  blockedReason?: string | null
  queued: { foreground: number; background: number }
  activeTurnId?: string | null
}
export type LocalWorkState = 'idle' | 'queued' | 'starting' | 'running' | 'paused' | 'blocked'

export interface LocalHatchMemberInput {
  name: string
  role?: LocalMemberRole
  backend: string
  connectorId?: string | null
  model?: string
  cwd?: string
}

/** `POST /v1/hives/{hiveId}/members`（RegisterMemberInput — 仅注册不孵化） */
export interface LocalRegisterMemberInput {
  name: string
  role?: LocalMemberRole
  backend: string
  connectorId?: string | null
  model?: string
}

// ---------- Task（LedgerService DTO） ----------
export type LocalTaskStatus = 'backlog' | 'in-progress' | 'completed' | 'cancelled' | 'blocked'

export interface LocalTask {
  id: LocalTaskId
  hiveId: LocalHiveId
  subject: string
  description?: string
  status: LocalTaskStatus
  owner?: LocalMemberId
  blockedBy: LocalTaskId[]
  blocks: LocalTaskId[]
  createdAt: number
  updatedAt: number
}

/** TaskFilter（query.filter JSON 编码） */
export interface LocalTaskFilter {
  status?: LocalTaskStatus | LocalTaskStatus[]
  owner?: LocalMemberId
  runnable?: boolean
  limit?: number
}

export interface LocalCreateTaskInput {
  subject: string
  description?: string
  owner?: LocalMemberId | null
  blockedBy?: LocalTaskId[]
}

export type LocalTaskPatch = Partial<{
  status: LocalTaskStatus
  owner: LocalMemberId | null
  description: string
}>

// ---------- Message / Thread（CourierService DTO） ----------
export type LocalMessageKind = 'directive' | 'report' | 'chat' | 'announcement' | 'system'
export type LocalMessageSender = LocalMemberId | 'user' | 'system'
export type LocalMessageRecipient = LocalMemberId | 'all'

export interface LocalMessage {
  id: LocalMessageId
  hiveId: LocalHiveId
  from: LocalMessageSender
  to: LocalMessageRecipient
  kind: LocalMessageKind
  content: string
  summary?: string
  attachments: string[]
  read: boolean
  createdAt: number
}

export interface LocalOutgoingMessage {
  from: LocalMessageSender
  to: LocalMessageRecipient
  kind: LocalMessageKind
  content: string
}

/** InboxFilter（query.filter JSON 编码） */
export interface LocalInboxFilter {
  unreadOnly?: boolean
  kind?: LocalMessageKind
  limit?: number
}

// ---------- Activity（courier.feed） ----------
export type LocalActivityItem =
  | { kind: 'message'; message: LocalMessage }
  | { kind: 'task'; task: LocalTask }

export interface LocalActivityPage {
  items: LocalActivityItem[]
  nextCursor?: { ts: number; id: string }
  hasMore: boolean
}

/** feed 分页游标（message.feed 的 cursor 参数） */
export interface LocalFeedCursor {
  ts: number
  id?: string
}

// ---------- Mandate（§3.5） ----------
export type LocalMandateAction = string
export interface LocalMandateGrant {
  action: LocalMandateAction
  verdict: 'granted' | 'denied' | 'owner-scoped'
  reason?: string
}

// ---------- WebSocket 帧（§4） ----------
export type WsClientMessage =
  | { type: 'subscribe'; hiveId: LocalHiveId | '*' }
  | { type: 'unsubscribe'; hiveId: LocalHiveId }
  | { type: 'hello'; client?: string; version?: number }

export type WsServerFrame =
  | { type: 'event'; topic: LocalTopic; hiveId: LocalHiveId | null; payload: unknown }
  | { type: 'subscribed'; hiveId: LocalHiveId }
  | { type: 'unsubscribed'; hiveId: LocalHiveId }
  | { type: 'hello'; ok: boolean }

/** WS 推送的事件 topic（与 subscribe.ts PUSHED_TOPICS 一致） */
export type LocalTopic =
  | 'hive/created'
  | 'hive/renamed'
  | 'hive/removed'
  | 'member/hatched'
  | 'member/dismissed'
  | 'member/status'
  | 'member/work-state'
  | 'task/created'
  | 'task/updated'
  | 'message/created'
  | 'message/read'
