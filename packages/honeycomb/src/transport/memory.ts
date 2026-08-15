/**
 * memory — 内存版 HTTP / WS 适配器（docs/honeycomb-transport-api.md §2）.
 *
 * 「内存版实现骨架」的网络栈替身。不做真实 socket/监听；而是提供可编程的
 * 分发入口与广播方法，供主进程桥、测试或真实网络适配器驱动：
 *
 * - `MemoryHttpAdapter.dispatch(method, path, query, body)`：模拟一次 HTTP 请求，
 *   交由接入的 `HoneycombTransport` 处理并返回响应。
 * - `MemoryWsAdapter`：维护内存连接集合；算法 bridge 端用 `memoryWs.pushTo(...)`
 *   把某事件推给指定连接（与真实 WS 的 send 走同一路径）。
 *
 * 真实网络栈（Node http + ws、或主进程 IPC 桥）在接入端实现 `HttpAdapter` /
 * `WsAdapter` 端口后调用 `HoneycombTransport.attachHttp / attachWs`，即可复用
 * 全部路由与订阅逻辑，无需改动 transport 核心。
 *
 * @module @whalepod/honeycomb/transport
 */

import type { Context } from '@deepseek-ai/cordis'
import { HoneycombTransport } from './port'
import type { HttpAdapter, WsAdapter } from './port'
import { createHoneycombTransport } from './core'
import { SubscribeCenter } from './subscribe'
import type { HttpRequest, HttpResponse, WsConn, WsMessage } from './types'

// ---------------------------------------------------------------------------
// MemoryHttpAdapter
// ---------------------------------------------------------------------------

export class MemoryHttpAdapter implements HttpAdapter {
  readonly routes: { method: string; pattern: string; handler: any }[] = []

  route(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pattern: string, handler: any): void {
    this.routes.push({ method, pattern, handler })
  }

  /** 模拟一次 HTTP 请求（接入端 / 测试调用）。 */
  async dispatch(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    query: Record<string, string> = {},
    body: any = undefined,
  ): Promise<HttpResponse> {
    for (const r of this.routes) {
      if (r.method !== method) continue
      if (match(r.pattern, path) === null) continue
      const req: HttpRequest = { method, path, query, body }
      return await (r.handler as (req: HttpRequest, t: HoneycombTransport) => Promise<HttpResponse> | HttpResponse)(
        req,
        // handler 忽略第二个参数；真实适配器注入 transport 前无需它。
        null as unknown as HoneycombTransport,
      )
    }
    return { status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: `${method} ${path}` } } }
  }
}

function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const s = path.split('/').filter(Boolean)
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]
    if (seg.startsWith('{') && seg.endsWith('}')) params[seg.slice(1, -1)] = decodeURIComponent(s[i])
    else if (seg !== s[i]) return null
  }
  return params
}

// ---------------------------------------------------------------------------
// MemoryWsAdapter
// ---------------------------------------------------------------------------

let wsSeq = 0

/** 内存 WS 连接实现。 */
export class MemoryWsConn implements WsConn {
  readonly id: string
  readonly subscriptions = new Set<string>()
  readonly sent: WsMessage[] = []

  constructor() {
    this.id = `ws_${++wsSeq}`
  }

  send(msg: WsMessage): void {
    this.sent.push(msg)
  }

  close(): void {
    // 内存版无实际 socket；subscriber 会自行清理。
  }
}

export class MemoryWsAdapter implements WsAdapter {
  readonly conns = new Map<string, MemoryWsConn>()
  private center!: SubscribeCenter
  private disposed = false

  constructor(private readonly ctx: Context) {
    this.center = new SubscribeCenter(ctx)
  }

  on(conn: WsConn): void {
    if (!(conn instanceof MemoryWsConn)) {
      // 允许外部传入的 WsConn 视图；仅记录索引。
      this.center.connect(conn)
      return
    }
    this.conns.set(conn.id, conn)
    this.center.connect(conn)
  }

  off(connId: string): void {
    const conn = this.conns.get(connId)
    if (conn) {
      this.conns.delete(connId)
      this.center.disconnect(conn)
    }
  }

  onClientMessage(conn: WsConn, msg: any): void {
    this.center.handleClientMessage(conn, msg)
  }

  push(conn: WsConn, topic: string, payload: any): void {
    conn.send({ type: 'event', topic, hiveId: null, payload })
  }

  /** 启动事件桥接（在 attach 后调用）。 */
  start(): void {
    if (this.disposed) return
    this.center.start()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.center.stop()
  }
}

// ---------------------------------------------------------------------------
// 装配入口（plugin2 形态）——内存版 transport
// ---------------------------------------------------------------------------

export interface MemoryTransportHandle {
  http: MemoryHttpAdapter
  ws: MemoryWsAdapter
  transport: HoneycombTransport
  /** 停用：注销事件桥接。 */
  dispose(): void
}

/**
 * 装配内存版 transport（docs/honeycomb-transport-api.md §5 / §7 plugin.ts）。
 *
 * 调用时机：在 service 已 provide 到 ctx 之后（即 honeycomb 插件应用之后）。
 * 这里 `services` 直接取 `ctx` 上已注入的服务（`ctx.hive/roster/ledger/courier/mandate`），
 * 与插件注入保持一致，避免重复实例化。
 */
export function createMemoryTransport(ctx: Context): MemoryTransportHandle {
  const transport = createHoneycombTransport(ctx)

  const http = new MemoryHttpAdapter()
  transport.attachHttp(http)

  const ws = new MemoryWsAdapter(ctx)
  transport.attachWs(ws)
  ws.start()

  return {
    http,
    ws,
    transport,
    dispose: () => ws.dispose(),
  }
}
