// ============================================================
// localHoneycombClient — @whalepod/honeycomb transport 客户端的本地薄封装
// ------------------------------------------------------------
// 目的：team-panel 不在 workspace 里，尚无法 `import { createHoneycombClient }
// from '@whalepod/honeycomb/transport'`。这里按 实现-Pro-2 的客户端 SDK 形态
// （src/transport/client-types.ts 的 HoneycombClient：hive/member/task/message/
// mandate 五个 REST 域 + WS connect/subscribe/on/close）实现一个同构的本地
// 回退，让手面的 service 层先能跑、接口签名与真实 SDK 完全一致。
//
// 切到真实 SDK（自动重连 + 重订阅 + 幂等 connect）时只需替换模块顶部 imports：
// ```ts
// // 换成：import { createHoneycombClient } from '@whalepod/honeycomb/transport'
// // 并把下方 createLocalHoneycombClient() 的调用点改成 createHoneycombClient(...)
// ```
// 业务层（honeycombApi.ts）不感知差异。
//
// ⚠️ 本封装刻意**不实现** WS 自动重连/重订阅（由真实 SDK 负责，避免重复逻辑）。
// 断线后需手动 reconnect()（re-fetch 快照 + reconnect WS）或等 SDK 切换。
// ============================================================

import type {
  LocalHive, LocalMember, LocalMemberStateView, LocalHatchMemberInput,
  LocalRegisterMemberInput, LocalTask, LocalTaskFilter, LocalCreateTaskInput,
  LocalTaskPatch, LocalMessage, LocalOutgoingMessage, LocalInboxFilter,
  LocalActivityPage, LocalFeedCursor, LocalMandateGrant,
  LocalTopic, LocalHiveId, LocalMemberId, LocalTaskId, LocalMessageId,
} from './transportDto'

// honeycombApi.ts 从本模块引 LocalTopic（与 client.on 的 topic 参数同源）
export type { LocalTopic } from './transportDto'

// ---------- 构造参数（对齐 HoneycombClientOptions） ----------
export interface LocalHoneycombClientOptions {
  httpUrl: string
  wsUrl: string
  hiveId: LocalHiveId
  fetch?: typeof globalThis.fetch
  WebSocket?: typeof globalThis.WebSocket
  headers?: Record<string, string>
}

// ---------- 域 API（签名对齐 client-types.ts） ----------
export interface LocalHiveApi {
  list(): Promise<LocalHive[]>
  get(id: LocalHiveId): Promise<LocalHive>
}
export interface LocalMemberApi {
  list(hiveId: LocalHiveId): Promise<LocalMember[]>
  get(hiveId: LocalHiveId, id: LocalMemberId): Promise<LocalMember>
  state(hiveId: LocalHiveId, id: LocalMemberId): Promise<LocalMemberStateView>
  hatch(hiveId: LocalHiveId, input: LocalHatchMemberInput): Promise<LocalMember>
  dismiss(hiveId: LocalHiveId, id: LocalMemberId): Promise<true>
  remove(hiveId: LocalHiveId, id: LocalMemberId): Promise<true>
}
export interface LocalTaskApi {
  list(hiveId: LocalHiveId, filter?: LocalTaskFilter): Promise<LocalTask[]>
  create(hiveId: LocalHiveId, input: LocalCreateTaskInput): Promise<LocalTask>
  update(hiveId: LocalHiveId, id: LocalTaskId, patch: LocalTaskPatch): Promise<LocalTask>
}
export interface LocalMessageApi {
  send(hiveId: LocalHiveId, message: LocalOutgoingMessage): Promise<LocalMessage>
  inbox(hiveId: LocalHiveId, recipient: string, filter?: LocalInboxFilter): Promise<LocalMessage[]>
  broadcast(hiveId: LocalHiveId, from: string, content: string): Promise<void>
  feed(hiveId: LocalHiveId, cursor?: LocalFeedCursor, limit?: number): Promise<LocalActivityPage>
}
export interface LocalMandateApi {
  can(actor: LocalMemberId, action: string): Promise<boolean>
  grants(memberId: LocalMemberId): Promise<LocalMandateGrant[]>
}

export interface LocalHoneycombClient {
  hive: LocalHiveApi
  member: LocalMemberApi
  task: LocalTaskApi
  message: LocalMessageApi
  mandate: LocalMandateApi
  readonly connected: boolean
  connect(): Promise<void>
  reconnect(): Promise<void>
  subscribe(hiveId: string): Promise<void>
  unsubscribe(hiveId: string): Promise<void>
  on(topic: LocalTopic, handler: (payload: unknown) => void): () => void
  close(): Promise<void>
}

const WS_OPEN = 1

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

/** transport 调用错误（对齐 SDK 的 HoneycombTransportError）。 */
export class LocalTransportError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'LocalTransportError'
    this.code = code
    this.status = status
  }
}

export function createLocalHoneycombClient(options: LocalHoneycombClientOptions): LocalHoneycombClient {
  return new LocalClientImpl(options)
}

class LocalClientImpl implements LocalHoneycombClient {
  private readonly httpUrl: string
  private readonly wsUrl: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly wsImpl: typeof globalThis.WebSocket
  private readonly headers: Record<string, string>

  private socket: WebSocket | null = null
  private closedByUser = false
  private readonly subscriptions = new Set<string>()
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>()

  constructor(options: LocalHoneycombClientOptions) {
    this.httpUrl = options.httpUrl.replace(/\/+$/, '')
    this.wsUrl = options.wsUrl
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.wsImpl = options.WebSocket ?? globalThis.WebSocket
    this.headers = options.headers ?? {}
  }

  readonly hive: LocalHiveApi = {
    list: () => this.request('GET', '/v1/hives'),
    get: (id) => this.request('GET', `/v1/hives/${id}`),
  }

  readonly member: LocalMemberApi = {
    list: (h) => this.request('GET', `/v1/hives/${h}/members`),
    get: (h, id) => this.request('GET', `/v1/hives/${h}/members/${id}`),
    state: (h, id) => this.request('GET', `/v1/hives/${h}/members/${id}/state`),
    hatch: (h, input) => this.request('POST', `/v1/hives/${h}/members/hatch`, { body: input }),
    dismiss: (h, id) => this.request('POST', `/v1/hives/${h}/members/${id}/dismiss`),
    remove: (h, id) => this.request('DELETE', `/v1/hives/${h}/members/${id}`),
  }

  readonly task: LocalTaskApi = {
    list: (h, filter) => this.request('GET', `/v1/hives/${h}/tasks`, { query: filter ? { filter } : undefined }),
    create: (h, input) => this.request('POST', `/v1/hives/${h}/tasks`, { body: input }),
    update: (h, id, patch) => this.request('PATCH', `/v1/hives/${h}/tasks/${id}`, { body: patch }),
  }

  readonly message: LocalMessageApi = {
    send: (h, message) => this.request('POST', `/v1/hives/${h}/messages`, { body: message }),
    inbox: (h, recipient, filter) =>
      this.request('GET', `/v1/hives/${h}/inbox/${recipient}`, { query: filter ? { filter } : undefined }),
    broadcast: (h, from, content) =>
      this.request('POST', `/v1/hives/${h}/broadcast`, { body: { from, content } }),
    feed: (h, cursor, limit) =>
      this.request('GET', `/v1/hives/${h}/activity`, { query: { cursor, limit } }),
  }

  readonly mandate: LocalMandateApi = {
    // 不使用全局 namespace（无 actor 设定的全局查询走 \`actor\` 显式参数）；这里给面板一个默认空查。
    can: (actor, action) => this.request('GET', '/v1/mandate/can', { query: { actor, action } }),
    grants: (memberId) => this.request('GET', `/v1/mandate/grants/${memberId}`),
  }

  get connected(): boolean {
    return !!this.socket && this.socket.readyState === WS_OPEN
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    if (!this.wsImpl) return Promise.reject(new LocalTransportError('WS_UNAVAILABLE', 'no WebSocket impl', 0))
    return new Promise<void>((resolve, reject) => {
      try {
        const sock = new this.wsImpl(this.wsUrl)
        this.socket = sock
        sock.onopen = () => {
          this.sendFrame({ type: 'hello', client: 'team-panel', version: 1 })
          // 补订已缓存订阅
          for (const hiveId of this.subscriptions) this.sendFrame({ type: 'subscribe', hiveId })
          resolve()
        }
        sock.onmessage = (event) => this.handleFrame(event.data)
        sock.onclose = () => {
          this.socket = null
          // TODO(实现-Pro-2 SDK): 自动重连/重订阅交给真实 createHoneycombClient，
          // 本封装不实现；UI 层通过 HoneycombApi.reconnect() 手动恢复。
        }
        sock.onerror = () => {
          reject(new LocalTransportError('WS_CONNECT_FAILED', 'websocket connect failed', 0))
        }
      } catch (error) {
        reject(new LocalTransportError('WS_CONNECT_FAILED', (error as Error).message, 0))
      }
    })
  }

  async subscribe(hiveId: string): Promise<void> {
    this.subscriptions.add(hiveId)
    if (this.connected) this.sendFrame({ type: 'subscribe', hiveId })
  }
  async unsubscribe(hiveId: string): Promise<void> {
    this.subscriptions.delete(hiveId)
    if (this.connected) this.sendFrame({ type: 'unsubscribe', hiveId })
  }
  on(topic: LocalTopic, handler: (payload: unknown) => void): () => void {
    let set = this.handlers.get(topic)
    if (!set) {
      set = new Set()
      this.handlers.set(topic, set)
    }
    set.add(handler)
    return () => {
      const s = this.handlers.get(topic)
      if (s) {
        s.delete(handler)
        if (s.size === 0) this.handlers.delete(topic)
      }
    }
  }
  async close(): Promise<void> {
    this.closedByUser = true
    this.subscriptions.clear()
    this.handlers.clear()
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
  }

  /** 手动重连：re-fetch 由调用方做；这里只重连 WS 并补订。 */
  async reconnect(): Promise<void> {
    await this.close()
    this.closedByUser = false
    await this.connect()
  }

  // ----------------------------------------------------------- 内部

  private buildQuery(query?: Record<string, unknown>): string {
    if (!query) return ''
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue
      if (key === 'filter' || key === 'cursor' || key === 'scope') qs.set(key, JSON.stringify(value))
      else qs.set(key, String(value))
    }
    const s = qs.toString()
    return s ? `?${s}` : ''
  }

  private async request<T>(method: string, path: string, opts?: { query?: Record<string, unknown>; body?: unknown }): Promise<T> {
    const init: RequestInit = { method, headers: { ...this.headers } }
    if (opts?.body !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' }
      init.body = JSON.stringify(opts.body)
    }
    let res: Response
    try {
      res = await this.fetchImpl(this.httpUrl + path + this.buildQuery(opts?.query), init)
    } catch (error) {
      throw new LocalTransportError('NETWORK_ERROR', (error as Error).message ?? 'fetch failed', 0)
    }
    let envelope: Envelope<T>
    try {
      envelope = (await res.json()) as Envelope<T>
    } catch {
      throw new LocalTransportError('BAD_RESPONSE', `non-JSON response (HTTP ${res.status})`, res.status)
    }
    if (!envelope || envelope.ok !== true) {
      const err = envelope?.error
      throw new LocalTransportError(err?.code ?? 'REQUEST_FAILED', err?.message ?? `HTTP ${res.status}`, res.status)
    }
    return envelope.data as T
  }

  private sendFrame(msg: Record<string, unknown>): void {
    if (!this.connected) return
    try {
      this.socket!.send(JSON.stringify(msg))
    } catch {
      /* ignore */
    }
  }

  private handleFrame(raw: unknown): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'event') {
      const topic = String(frame.topic ?? '')
      const payload = frame.payload
      const set = this.handlers.get(topic)
      if (set) for (const handler of [...set]) handler(payload)
    }
  }
}
