/**
 * honeycomb 传输层客户端 — `createHoneycombClient` 实现。
 *
 * - REST：覆盖 docs/honeycomb-transport-api.md 全部端点，自动解包 `{ok,data}` /
 *   `{ok:false,error}` 信封；失败抛 `HoneycombTransportError`。
 * - WS：connect / subscribe / unsubscribe / on / close，指数退避重连（上限 30s），
 *   缓存订阅并在重连后自动补订；**重连补订逐个等 ack 完成后才置就绪**（`connected`
 *   为 true 即"已连接且订阅全部生效"），connect() 在连接失败时以 WS_UNAVAILABLE reject。
 * - close() 为永久性拆除：同一实例 close 后不再自动重连，如需复用请新建实例。
 * - 零三方运行时依赖：只用 `fetch` 与平台 `WebSocket`（均可注入，便于测试）。
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
import type {
  HiveClientApi,
  HoneycombClient,
  HoneycombClientOptions,
  MandateClientApi,
  MemberClientApi,
  MessageClientApi,
  TaskClientApi,
} from './client-types'

/** REST 或 WS 调用失败时抛出；`code` 透传服务端 error.code。 */
export class HoneycombTransportError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'HoneycombTransportError'
    this.code = code
    this.status = status
  }
}

type AnyHandler = (payload: unknown) => void

const WS_OPEN = 1
const DEFAULT_RECONNECT_BASE_MS = 500
const DEFAULT_RECONNECT_MAX_MS = 30_000
const DEFAULT_ACK_TIMEOUT_MS = 5_000

interface PendingAck {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface FetchOptions {
  query?: Record<string, unknown>
  body?: unknown
}

/** `{ok:true,data}` | `{ok:false,error}` 信封（对齐 transport/types.ts）。 */
interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

export function createHoneycombClient(options: HoneycombClientOptions): HoneycombClient {
  return new ClientImpl(options)
}

class ClientImpl implements HoneycombClient {
  private readonly httpUrl: string
  private readonly wsUrl: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly wsImpl: typeof globalThis.WebSocket
  private readonly headers: Record<string, string>
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly ackTimeoutMs: number

  // WS 状态
  private socket: WebSocket | null = null
  private connecting: Promise<void> | null = null
  /** 就绪态：socket 已 OPEN 且重连补订全部 ack 完成（MED-5）。 */
  private ready = false
  /** connect() 的 settle 标记：避免 resolve/reject 重复触发（HIGH-2）。 */
  private connectingSettled = false
  private closedByUser = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private readonly subscriptions = new Set<string>()
  private readonly handlers = new Map<string, Set<AnyHandler>>()
  private readonly pendingAcks = new Map<string, PendingAck>()

  constructor(options: HoneycombClientOptions) {
    this.httpUrl = options.httpUrl.replace(/\/+$/, '')
    this.wsUrl = options.wsUrl
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.wsImpl = options.WebSocket ?? globalThis.WebSocket
    this.headers = options.headers ?? {}
    this.baseMs = options.reconnect?.baseMs ?? DEFAULT_RECONNECT_BASE_MS
    this.maxMs = options.reconnect?.maxMs ?? DEFAULT_RECONNECT_MAX_MS
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
  }

  // ---------------------------------------------------------------- REST 域

  readonly hive: HiveClientApi = {
    list: () => this.request('GET', '/v1/hives'),
    get: (id) => this.request('GET', `/v1/hives/${id}`),
    create: (input) => this.request('POST', '/v1/hives', { body: input }),
    rename: (id, name) => this.request('PATCH', `/v1/hives/${id}/name`, { body: { name } }),
    setMode: (id, mode) => this.request('PATCH', `/v1/hives/${id}/mode`, { body: { mode } }),
    setSessionMode: (id, sessionMode) =>
      this.request('PATCH', `/v1/hives/${id}/session-mode`, { body: { sessionMode } }),
    remove: (id) => this.request('DELETE', `/v1/hives/${id}`),
  }

  readonly member: MemberClientApi = {
    list: (hiveId) => this.request('GET', `/v1/hives/${hiveId}/members`),
    get: (hiveId, id) => this.request('GET', `/v1/hives/${hiveId}/members/${id}`),
    state: (hiveId, id) => this.request('GET', `/v1/hives/${hiveId}/members/${id}/state`),
    register: (hiveId, input) => this.request('POST', `/v1/hives/${hiveId}/members`, { body: input }),
    hatch: (hiveId, input) => this.request('POST', `/v1/hives/${hiveId}/members/hatch`, { body: input }),
    dismiss: (hiveId, id) => this.request('POST', `/v1/hives/${hiveId}/members/${id}/dismiss`),
    rename: (hiveId, id, name) =>
      this.request('PATCH', `/v1/hives/${hiveId}/members/${id}/name`, { body: { name } }),
    remove: (hiveId, id) => this.request('DELETE', `/v1/hives/${hiveId}/members/${id}`),
  }

  readonly task: TaskClientApi = {
    list: (hiveId, filter) =>
      this.request('GET', `/v1/hives/${hiveId}/tasks`, { query: filter ? { filter } : undefined }),
    get: (hiveId, id) => this.request('GET', `/v1/hives/${hiveId}/tasks/${id}`),
    create: (hiveId, input) => this.request('POST', `/v1/hives/${hiveId}/tasks`, { body: input }),
    update: (hiveId, id, patch) => this.request('PATCH', `/v1/hives/${hiveId}/tasks/${id}`, { body: patch }),
    setOwner: (hiveId, id, owner) =>
      this.request('POST', `/v1/hives/${hiveId}/tasks/${id}/owner`, { body: { owner } }),
    addDependency: (hiveId, id, blockedBy) =>
      this.request('POST', `/v1/hives/${hiveId}/tasks/${id}/dependency`, { body: { blockedBy } }),
    removeDependency: (hiveId, id, blockedBy) =>
      this.request('DELETE', `/v1/hives/${hiveId}/tasks/${id}/dependency`, { body: { blockedBy } }),
  }

  readonly message: MessageClientApi = {
    send: (hiveId, message) => this.request('POST', `/v1/hives/${hiveId}/messages`, { body: message }),
    deliver: (hiveId, message) =>
      this.request('POST', `/v1/hives/${hiveId}/messages/deliver`, { body: message }),
    inbox: (hiveId, recipient, filter) =>
      this.request('GET', `/v1/hives/${hiveId}/inbox/${recipient}`, {
        query: filter ? { filter } : undefined,
      }),
    markRead: (hiveId, id) => this.request('POST', `/v1/hives/${hiveId}/messages/${id}/read`),
    broadcast: (hiveId, from, content) =>
      this.request('POST', `/v1/hives/${hiveId}/broadcast`, { body: { from, content } }),
    feed: (hiveId, cursor, limit) =>
      this.request('GET', `/v1/hives/${hiveId}/activity`, { query: { cursor, limit } }),
  }

  readonly mandate: MandateClientApi = {
    can: (actor, action, scope) =>
      this.request('GET', '/v1/mandate/can', { query: { actor, action, scope } }),
    assert: (actor, action, scope) =>
      this.request('POST', '/v1/mandate/assert', { body: { actor, action, scope } }),
    grants: (memberId) => this.request('GET', `/v1/mandate/grants/${memberId}`),
  }

  // ------------------------------------------------------------------ WS

  /** 就绪才视为 connected：socket 已 OPEN 且重连补订全部 ack 完成（MED-5）。 */
  get connected(): boolean {
    return !!this.socket && this.socket.readyState === WS_OPEN && this.ready
  }

  async connect(): Promise<void> {
    if (this.connected) return
    if (this.connecting) return this.connecting
    if (!this.wsImpl) {
      throw new HoneycombTransportError('WS_UNAVAILABLE', 'no WebSocket implementation available', 0)
    }
    this.connectingSettled = false
    this.connecting = new Promise<void>((resolve, reject) => {
      let opened = false
      try {
        const sock = new this.wsImpl(this.wsUrl)
        this.socket = sock
        sock.onopen = () => {
          opened = true
          this.reconnectAttempt = 0
          this.ready = false
          this.sendFrame({ type: 'hello', client: 'honeycomb-client', version: 1 })
          // HIGH-1/MED-5：重连补订必须逐个等 ack，全部完成后才置就绪并 resolve connect()，
          // 避免"订阅未注册就收到广播导致第一条事件丢失"。
          void this.resubscribe()
            .catch(() => {
              // resubscribe 内部已吞掉单个 hive 的失败，这里仅兜底
            })
            .finally(() => {
              this.ready = true
              if (!this.connectingSettled) {
                this.connectingSettled = true
                resolve()
              }
            })
        }
        sock.onmessage = (event) => this.handleFrame(event.data)
        sock.onclose = () => {
          if (this.socket === sock) this.socket = null
          this.ready = false
          // MED-3：断线即清掉未决 ack，避免重连后旧 waitAck 挂到假 ACK_TIMEOUT
          this.rejectPendingAcks(new HoneycombTransportError('WS_CLOSED', 'websocket closed before ack', 0))
          // HIGH-2：从未 open 过的 socket 关闭 → reject connect()，调用方不会无限挂起
          if (!opened && !this.connectingSettled) {
            this.connectingSettled = true
            reject(new HoneycombTransportError('WS_UNAVAILABLE', 'websocket connection failed', 0))
          }
          if (!this.closedByUser) this.scheduleReconnect()
        }
        sock.onerror = () => {
          // onclose 随后触发
        }
      } catch (error) {
        this.connectingSettled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  async subscribe(hiveId: string): Promise<void> {
    const isNew = !this.subscriptions.has(hiveId)
    this.subscriptions.add(hiveId)
    if (!isNew) return // 已在缓存中：重连补订或此前订阅已覆盖
    // MED-4：未连接时不再静默 no-op——懒连接（失败会以 WS_UNAVAILABLE 抛给调用方）
    if (!this.connected) await this.connect()
    if (!this.connected) {
      throw new HoneycombTransportError('WS_UNAVAILABLE', 'websocket not connected', 0)
    }
    this.sendFrame({ type: 'subscribe', hiveId })
    await this.waitAck(`sub:${hiveId}`)
  }

  async unsubscribe(hiveId: string): Promise<void> {
    this.subscriptions.delete(hiveId)
    if (!this.connected) return
    this.sendFrame({ type: 'unsubscribe', hiveId })
    await this.waitAck(`unsub:${hiveId}`)
  }

  on<K extends keyof HiveEventMap>(topic: K, handler: (payload: HiveEventMap[K]) => void): () => void {
    const wrapped = handler as AnyHandler
    let set = this.handlers.get(topic)
    if (!set) {
      set = new Set()
      this.handlers.set(topic, set)
    }
    set.add(wrapped)
    return () => {
      const s = this.handlers.get(topic)
      if (s) {
        s.delete(wrapped)
        if (s.size === 0) this.handlers.delete(topic)
      }
    }
  }

  async close(): Promise<void> {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectPendingAcks(new HoneycombTransportError('WS_CLOSED', 'client closed', 0))
    this.subscriptions.clear()
    this.handlers.clear()
    this.ready = false
    const sock = this.socket
    this.socket = null
    this.connecting = null
    if (sock) {
      try {
        sock.close()
      } catch {
        // ignore
      }
    }
  }

  // ------------------------------------------------------------- 内部实现

  /** 组装 query：filter/cursor/scope 走 JSON（URLSearchParams 负责编码），其余走 String。 */
  private buildQuery(query?: Record<string, unknown>): string {
    if (!query) return ''
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue
      if (key === 'filter' || key === 'cursor' || key === 'scope') {
        qs.set(key, JSON.stringify(value))
      } else {
        qs.set(key, String(value))
      }
    }
    const s = qs.toString()
    return s ? `?${s}` : ''
  }

  /** REST 调用：fetch → 解析信封 → 解包 data / 抛 HoneycombTransportError。 */
  private async request<T>(method: string, path: string, opts?: FetchOptions): Promise<T> {
    const url = this.httpUrl + path + this.buildQuery(opts?.query)
    const init: RequestInit = { method, headers: { ...this.headers } }
    if (opts?.body !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' }
      init.body = JSON.stringify(opts.body)
    }
    let res: Response
    try {
      res = await this.fetchImpl(url, init)
    } catch (error) {
      throw new HoneycombTransportError('NETWORK_ERROR', (error as Error).message ?? 'fetch failed', 0)
    }
    let envelope: Envelope<T>
    try {
      envelope = (await res.json()) as Envelope<T>
    } catch {
      throw new HoneycombTransportError('BAD_RESPONSE', `non-JSON response (HTTP ${res.status})`, res.status)
    }
    if (!envelope || envelope.ok !== true) {
      const err = envelope?.error
      throw new HoneycombTransportError(err?.code ?? 'REQUEST_FAILED', err?.message ?? `HTTP ${res.status}`, res.status)
    }
    return envelope.data as T
  }

  private sendFrame(msg: Record<string, unknown>): void {
    // 用原生 socket 而非 connected getter：重连补订窗口（ready=false）也要能发帧
    if (!this.socket || this.socket.readyState !== WS_OPEN) return
    try {
      this.socket!.send(JSON.stringify(msg))
    } catch {
      // ignore
    }
  }

  /** 重连后对缓存订阅逐个补订并等待 ack（顺序执行，避免同 key 并发 waitAck 互相覆盖）。 */
  private async resubscribe(): Promise<void> {
    for (const hiveId of [...this.subscriptions]) {
      try {
        this.sendFrame({ type: 'subscribe', hiveId })
        await this.waitAck(`sub:${hiveId}`)
      } catch {
        // 单个失败不阻塞其余补订；未 ack 的 hive 由下一次重连再补
      }
    }
  }

  /** 断线/关闭时把未决 ack 全部拒绝并清空，防止旧 waitAck 悬挂到假 ACK_TIMEOUT（MED-3）。 */
  private rejectPendingAcks(error: HoneycombTransportError): void {
    for (const ack of this.pendingAcks.values()) {
      clearTimeout(ack.timer)
      ack.reject(error)
    }
    this.pendingAcks.clear()
  }

  private handleFrame(raw: unknown): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    switch (frame.type) {
      case 'event': {
        const topic = String(frame.topic ?? '')
        const payload = frame.payload
        const set = this.handlers.get(topic)
        if (set) for (const handler of [...set]) handler(payload)
        break
      }
      case 'subscribed':
        this.settleAck(`sub:${String(frame.hiveId ?? '')}`)
        break
      case 'unsubscribed':
        this.settleAck(`unsub:${String(frame.hiveId ?? '')}`)
        break
      default:
        break
    }
  }

  private waitAck(key: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(key)
        reject(new HoneycombTransportError('WS_ACK_TIMEOUT', `no ack for ${key}`, 0))
      }, this.ackTimeoutMs)
      this.pendingAcks.set(key, { resolve, reject, timer })
    })
  }

  private settleAck(key: string): void {
    const ack = this.pendingAcks.get(key)
    if (!ack) return
    clearTimeout(ack.timer)
    this.pendingAcks.delete(key)
    ack.resolve()
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return
    const delay = Math.min(this.baseMs * 2 ** this.reconnectAttempt, this.maxMs)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        // onclose 会再次触发 scheduleReconnect
      })
    }, delay)
  }
}
