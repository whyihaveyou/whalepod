/**
 * @dfh/honeycomb — transport 模块（团队面板前端传输层）.
 *
 * 统一入口。导出端口接口、REST 路由注册、WS 订阅中心、内存版适配器，
 * 以及真实网络版（node:http + ws）适配器与监听服务。
 * 详见 docs/honeycomb-transport-api.md。
 *
 * @module @dfh/honeycomb/transport
 */

export * from './types'
export * from './port'
export * from './core'
export * from './router'
export * from './subscribe'
export * from './memory'
export * from './http'
export * from './ws'
export * from './server'
export * from './plugin'
export * from './client-types'
export * from './client'
