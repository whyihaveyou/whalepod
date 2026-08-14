/**
 * ws — 真实 WebSocket 适配器（基于 `ws` 包）.
 *
 * 把 `WsAdapter` 端口接到真实的 WebSocket：用 `ws` 包的 `WebSocketServer`，挂载
 * 到与 HTTP 适配器共享的 `node:http` 服务器（`{ server }` 自动处理 upgrade）。
 *
 * 技术选型（任务：零/少依赖二选一并说明理由）——选「ws 最小依赖」：
 * - Node 核心只提供**客户端** `WebSocket`（`globalThis.WebSocket`），**没有**服务端
 *   WebSocket 能力；要做服务端握手/升级/帧解析必须用第三方。
 * - `ws` 是事实标准、零配置、无传递依赖、体积小（~复数 KB），且 `WebSocketServer({ server })`
 *   直接复用 node:http 的 `upgrade` 事件，与我们的 `NodeHttpAdapter` 天然契合。
 * - 备选的「Node 22 自带能力」不存在于核心服务端；故采用 `ws`。
 *
 * 职责：新连接 → 包装成 `WsConn` → 注册进 `SubscribeCenter`；客户端指令
 * （subscribe/unsubscribe/hello）→ `SubscribeCenter.handleClientMessage`；
 * 事件桥接由 `SubscribeCenter.start()` 完成（推送按 hiveId 过滤）。
 *
 * @module @dfh/honeycomb/transport
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import type { Context } from '../framework'
import { SubscribeCenter } from './subscribe'
import type { WsConn, WsClientMessage, WsMessage } from './types'

let wsConnSeq = 0

/** 真实 socket 的 WsConn 实现：send = socket.send（JSON），close = socket.close。 */
export class RealWsConn implements WsConn {
  readonly id: string
  readonly subscriptions = new Set<string>()
  private closed = false

  constructor(private readonly socket: WebSocket) {
    this.id = `ws_${++wsConnSeq}`
    socket.once('close', () => {
      this.closed = true
    })
  }

  send(msg: WsMessage): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type: 'event', topic: msg.topic, hiveId: null, payload: msg.payload }))
  }

  close(): void {
    if (!this.closed) this.socket.close()
  }
}

export interface NodeWsServerOptions {
  /** WS 挂载路径，默认 `/ws`（其余路径的连接不被升级为 WS）。 */
  path?: string
}

/** 真实 WebSocket 服务器：包装每个连接并桥接事件。 */
export class NodeWsAdapter {
  readonly wss: WebSocketServer
  private readonly center: SubscribeCenter
  private readonly path: string
  private _started = false

  constructor(ctx: Context, httpServer: HttpServer, options: NodeWsServerOptions = {}) {
    this.path = options.path ?? '/ws'
    this.center = new SubscribeCenter(ctx)
    this.wss = new WebSocketServer({ server: httpServer as any, path: this.path })

    this.wss.on('connection', (socket) => {
      const conn = new RealWsConn(socket)
      this.center.connect(conn)

      socket.on('message', (data) => {
        let msg: WsClientMessage
        try {
          msg = JSON.parse(data.toString('utf8')) as WsClientMessage
        } catch {
          return
        }
        this.center.handleClientMessage(conn, msg)
      })

      socket.on('close', () => this.center.disconnect(conn))
      socket.on('error', () => this.center.disconnect(conn))
    })
  }

  /** 启动事件桥接（在服务 listen 后调用）。 */
  start(): void {
    if (this._started) return
    this._started = true
    this.center.start()
  }

  /** 当前连接数。 */
  get connectionCount(): number {
    return this.wss.clients.size
  }

  /** 关闭 WS 服务（关闭所有连接与服务器）。 */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this._started = false
      this.center.stop()
      for (const client of this.wss.clients) client.terminate()
      this.wss.close(() => resolve())
    })
  }
}
