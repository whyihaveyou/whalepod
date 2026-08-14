/**
 * server — 真实网络 transport 装配（HTTP + WebSocket 一体的监听服务）.
 *
 * 把 `createHoneycombTransport`（共享路由核心）+ `NodeHttpAdapter`（node:http）+
 * `NodeWsAdapter`（ws）组合成一个可 `listen()` 的真实服务。前端（实现-Pro-3）
 * 经 REST `fetch` + WS `new WebSocket(...)` 连接即用。
 *
 * 用法：
 * ```ts
 * const server = await createNodeTransportServer(ctx, { host: '127.0.0.1', port: 0 })
 * console.log('listening on', server.host, server.port)
 * // ...应用生命周期结束时
 * await server.close()
 * ```
 *
 * @module @dfh/honeycomb/transport
 */

import { NodeHttpAdapter } from './http'
import { NodeWsAdapter } from './ws'
import { createHoneycombTransport } from './core'
import type { HoneycombTransport } from './port'

export interface NodeTransportServerOptions {
  /** 监听地址；默认 127.0.0.1。 */
  host?: string
  /** 端口；0 = 随机可用端口（默认 0，避免占用冲突；接入端可在 config 指定固定端口）。 */
  port?: number
  /** WS 挂载路径；默认 `/ws`。 */
  wsPath?: string
}

export interface NodeTransportServerHandle {
  transport: HoneycombTransport
  http: NodeHttpAdapter
  ws: NodeWsAdapter
  /** 解析后的真实监听地址与端口。 */
  readonly host: string
  readonly port: number
  /** 停止监听并回收 socket / WS 连接。 */
  close(): Promise<void>
}

/** 启动真实 HTTP+WS transport 服务（不启用鉴权时的便捷入口）。 */
export async function createNodeTransportServer(
  ctx: import('../framework').Context,
  options: NodeTransportServerOptions = {},
): Promise<NodeTransportServerHandle> {
  const transport = createHoneycombTransport(ctx)

  const host = options.host ?? '127.0.0.1'
  const http = new NodeHttpAdapter(transport, { host, port: options.port ?? 0 })
  await http.listen()
  const port = http.actualPort

  const ws = new NodeWsAdapter(ctx, http.server, { path: options.wsPath })
  ws.start()

  return {
    transport,
    http,
    ws,
    host,
    port,
    close: async () => {
      await ws.close()
      await http.close()
    },
  }
}
