/**
 * honeycomb 传输层客户端 — 公开类型面（纯类型，无运行时逻辑）.
 *
 * 与 `client.ts` 分离：实现（REST + WS 状态机）在 client.ts，这里只声明
 * `createHoneycombClient` 返回的完整类型面，方便实现-Pro-3 直接 `import type`。
 *
 * @module @whalepod/honeycomb/transport
 */

import type { HiveEventMap } from '../events'
import type {
  ActivityPage,
  CreateHiveInput,
  CreateTaskInput,
  FeedCursor,
  HatchMemberInput,
  Hive,
  HiveId,
  HiveWorkspaceMode,
  InboxFilter,
  MandateAction,
  MandateGrant,
  MandateScope,
  Member,
  MemberId,
  MemberStateView,
  Message,
  MessageId,
  MessageRecipient,
  MessageSender,
  OutgoingMessage,
  RegisterMemberInput,
  Task,
  TaskFilter,
  TaskId,
  TaskPatch,
} from '../types'

/** 客户端构造参数。fetch / WebSocket 可注入（测试用假服务器/假 WS）。 */
export interface HoneycombClientOptions {
  /** REST 基地址，例如 `http://127.0.0.1:8787`（不带尾斜杠）。 */
  httpUrl: string
  /** WS 地址，例如 `ws://127.0.0.1:8787/ws`。 */
  wsUrl: string
  /** 覆盖默认 `globalThis.fetch`（测试注入 in-memory 假服务器）。 */
  fetch?: typeof globalThis.fetch
  /** 覆盖默认 `globalThis.WebSocket`（测试注入假 WS）。 */
  WebSocket?: typeof globalThis.WebSocket
  /** 断线重连退避参数（毫秒）。默认 base=500，max=30000。 */
  reconnect?: {
    baseMs?: number
    maxMs?: number
  }
  /** WS ack 等待超时（毫秒），默认 5000。 */
  ackTimeoutMs?: number
  /** 附加到每个 REST 请求的 header。 */
  headers?: Record<string, string>
}

/** hive 域（§3.1）。 */
export interface HiveClientApi {
  list(): Promise<Hive[]>
  get(id: HiveId): Promise<Hive>
  create(input: CreateHiveInput): Promise<Hive>
  rename(id: HiveId, name: string): Promise<true>
  setMode(id: HiveId, mode: HiveWorkspaceMode): Promise<true>
  setSessionMode(id: HiveId, sessionMode: string): Promise<true>
  remove(id: HiveId): Promise<true>
}

/** member 域（§3.2）。 */
export interface MemberClientApi {
  list(hiveId: HiveId): Promise<Member[]>
  get(hiveId: HiveId, id: MemberId): Promise<Member>
  state(hiveId: HiveId, id: MemberId): Promise<MemberStateView>
  register(hiveId: HiveId, input: RegisterMemberInput): Promise<Member>
  hatch(hiveId: HiveId, input: HatchMemberInput): Promise<Member>
  dismiss(hiveId: HiveId, id: MemberId): Promise<true>
  rename(hiveId: HiveId, id: MemberId, name: string): Promise<true>
  remove(hiveId: HiveId, id: MemberId): Promise<true>
}

/** task 域（§3.3）。 */
export interface TaskClientApi {
  list(hiveId: HiveId, filter?: TaskFilter): Promise<Task[]>
  get(hiveId: HiveId, id: TaskId): Promise<Task>
  create(hiveId: HiveId, input: CreateTaskInput): Promise<Task>
  update(hiveId: HiveId, id: TaskId, patch: TaskPatch): Promise<Task>
  setOwner(hiveId: HiveId, id: TaskId, owner: MemberId | null): Promise<true>
  addDependency(hiveId: HiveId, id: TaskId, blockedBy: TaskId[]): Promise<true>
  removeDependency(hiveId: HiveId, id: TaskId, blockedBy: TaskId[]): Promise<true>
  /**
   * 取消在途任务：`POST /v1/tasks/{id}/cancel`（唯一非 hive 作用域的端点，taskId
   * 全局唯一）。成功返回取消后的任务快照（status=cancelled）；失败抛
   * `HoneycombTransportError`，code 矩阵：`TASK_NOT_FOUND` / `TASK_TERMINAL` /
   * `TASK_NOT_RUNNING`（409 三分）与 `ORCHESTRATION_UNAVAILABLE`（503，编排循环
   * 未挂钩——部署内嵌模式时不会出现）。对已 cancelled 任务重复调用幂等（仍 202 +
   * 最新快照，不二次写事实）。`reason` 可选，透传进 task-cancelled 事实。
   */
  cancel(id: TaskId, reason?: string): Promise<Task>
}

/** message 域（§3.4）。 */
export interface MessageClientApi {
  send(hiveId: HiveId, message: OutgoingMessage): Promise<Message>
  deliver(hiveId: HiveId, message: OutgoingMessage): Promise<MessageId>
  inbox(hiveId: HiveId, recipient: MessageRecipient, filter?: InboxFilter): Promise<Message[]>
  markRead(hiveId: HiveId, id: MessageId): Promise<true>
  broadcast(hiveId: HiveId, from: MessageSender, content: string): Promise<void>
  feed(hiveId: HiveId, cursor?: FeedCursor, limit?: number): Promise<ActivityPage>
}

/** mandate 域（§3.5）。 */
export interface MandateClientApi {
  can(actor: MemberId, action: MandateAction, scope?: MandateScope): Promise<boolean>
  /** 通过返回 `true`；未授权时抛 `HoneycombTransportError`（403）。 */
  assert(actor: MemberId, action: MandateAction, scope?: MandateScope): Promise<true>
  grants(memberId: MemberId): Promise<MandateGrant[]>
}

/** 完整客户端：5 个 REST 域 + WS 订阅层。 */
export interface HoneycombClient {
  hive: HiveClientApi
  member: MemberClientApi
  task: TaskClientApi
  message: MessageClientApi
  mandate: MandateClientApi

  /** WS 就绪状态：socket 已 OPEN 且（重连后的）补订全部 ack 完成。 */
  readonly connected: boolean

  /**
   * 打开 WS（自动 hello + 重连已缓存订阅，补订逐个等 ack 完成后才 resolve）。
   * 重复调用幂等；连接失败时以 `HoneycombTransportError{code:'WS_UNAVAILABLE'}` reject（后台仍会退避重试）。
   */
  connect(): Promise<void>
  /**
   * 订阅 hive 事件（自动缓存，重连后自动补订）。未连接时会懒连接（失败抛 WS_UNAVAILABLE）；
   * 已订阅过的 hive 重复调用为幂等 no-op。
   */
  subscribe(hiveId: string): Promise<void>
  /** 退订 hive 事件（同步移除缓存，重连后不再补订）。 */
  unsubscribe(hiveId: string): Promise<void>
  /** 注册事件处理器；返回取消注册函数。 */
  on<K extends keyof HiveEventMap>(topic: K, handler: (payload: HiveEventMap[K]) => void): () => void
  /**
   * 主动关闭：停重连、关 socket、清处理器与缓存订阅。**永久性**——同一实例 close 后
   * 不再自动重连，如需复用请新建实例（createHoneycombClient）。
   */
  close(): Promise<void>
}
