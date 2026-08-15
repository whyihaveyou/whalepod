/**
 * plugin — transport 装配入口（docs/honeycomb-transport-api.md §7）.
 *
 * 用法：在 honeycomb 主插件（plugin.ts）应用、5 个 service 提供到 ctx 之后，
 * 再调用 `createMemoryTransport(ctx)`（内存版，见 memory.ts），得到
 * `{ http, ws, transport }` 句柄：
 *
 * - bridge 层用 `handle.http.dispatch(...)` 处理来自前端进程的请求；
 * - `handle.ws` 挂接真实 WS 连接并驱动事件推送。
 *
 * 本文件作为 transport 的对外装配命名空间，也导出端口类型供真实网络适配器实现。
 *
 * @module @whalepod/honeycomb/transport
 */

export { HoneycombTransport } from './port'
export type {
  TransportServices,
  TransportOptions,
  TransportAuth,
} from './port'
export {
  registerAllRoutes,
  registerHiveRoutes,
  registerRosterRoutes,
  registerLedgerRoutes,
  registerCourierRoutes,
  registerMandateRoutes,
} from './router'
export { SubscribeCenter, PUSHED_TOPICS } from './subscribe'
export { createMemoryTransport, MemoryHttpAdapter, MemoryWsAdapter, MemoryWsConn } from './memory'
export type { MemoryTransportHandle } from './memory'
export { NodeHttpAdapter } from './http'
export type { NodeHttpServerOptions } from './http'
export { NodeWsAdapter, RealWsConn } from './ws'
export type { NodeWsServerOptions } from './ws'
export { createNodeTransportServer } from './server'
export type { NodeTransportServerOptions, NodeTransportServerHandle } from './server'
