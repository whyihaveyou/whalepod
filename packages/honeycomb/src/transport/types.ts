/**
 * Transport — 面向团队面板前端的传输层 DTO 与端口类型 (§1–§2).
 *
 * Transport 是「薄适配层」：把 5 个 service 的查询/变更翻译成 REST 端点，
 * 把 honeycomb 的 emit 事件桥接成 WebSocket 推送。本文件只定义端口接口与
 * DTO，不含任何真实网络栈（内存版见 `memory.ts`，真实网络适配器在接入端注入）。
 *
 * 设计准则（见 docs/honeycomb-transport-api.md）：
 * - REST 负责查询与变更，WS 负责实时事件推送；
 * - 数据形态直接复用 `types.ts` 的 DTO，不新增第二套 JSON 结构；
 * - REST 路径词汇与 WS 订阅主题共享（hive/member/task/message/activity）。
 *
 * @module @dfh/honeycomb/transport
 */

import type { Events } from '../framework'
import type { HiveId, MemberId, TaskId, MessageId } from '../types'

// ---------------------------------------------------------------------------
// HTTP DTO
// ---------------------------------------------------------------------------

/** HTTP 请求视图（transport 不绑定具体框架）。 */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  query: Record<string, string | undefined>
  body: any
}

/** HTTP 响应视图。 */
export interface HttpResponse {
  status: number
  body: any
}

/** 统一成功响应。 */
export function ok<T>(data: T): HttpResponse {
  return { status: 200, body: { ok: true, data } }
}

/** 统一错误响应（§6.1）。 */
export function fail(code: string, message: string, status = 400): HttpResponse {
  return { status, body: { ok: false, error: { code, message } } }
}

/**
 * URL 路径参数解析。pattern 形如 `/v1/hives/{hiveId}/tasks/{id}`；
 * 返回捕获的具名参数；不匹配返回 null。
 */
export function matchPath(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const s = path.split('/').filter(Boolean)
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]
    if (seg.startsWith('{') && seg.endsWith('}')) {
      params[seg.slice(1, -1)] = decodeURIComponent(s[i])
    } else if (seg !== s[i]) {
      return null
    }
  }
  return params
}

// ---------------------------------------------------------------------------
// WebSocket DTO
// ---------------------------------------------------------------------------

/** WS 服务端 → 客户端事件帧（§4.2）。 */
export interface WsEventFrame<K extends keyof Events = keyof Events> {
  type: 'event'
  topic: K
  hiveId: HiveId | null
  payload: Events[K]
}

/** WS 客户端 → 服务端指令（§4.1）。 */
export type WsClientMessage =
  | { type: 'subscribe'; hiveId: HiveId }
  | { type: 'unsubscribe'; hiveId: HiveId }
  | { type: 'hello'; client?: string; version?: number }

/** WS 服务端 → 客户端帧（§4.2）。transport 只发；由 WsConn.send 转发。 */
export type WsMessage =
  | { type: 'event'; topic: string; hiveId: HiveId | null; payload: any }
  | { type: 'subscribed'; hiveId: HiveId }
  | { type: 'unsubscribed'; hiveId: HiveId }
  | { type: 'hello'; ok: boolean }

/** WS 客户端连接视图（transport 驱动订阅与推送）。 */
export interface WsConn {
  readonly id: string
  /** 当前订阅的 hiveId 集合；`"*"` 表示广播订阅。 */
  readonly subscriptions: Set<HiveId>
  send(msg: WsMessage): void
  close(): void
}

// 注：HttpAdapter / WsAdapter 端口接口定义在 port.ts（需引用 HoneycombTransport），
// 从 index.ts 一并导出。
