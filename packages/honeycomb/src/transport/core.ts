/**
 * core — 共享 transport 装配核心（内存版与 Node 网络版共用）.
 *
 * 统一：从 ctx 解析已 provide 的 5 个服务 → 构造 `HoneycombTransport` → 注册全部
 * REST 路由。内存版（memory.ts）与真实网络版（server.ts）都用本函数，避免三份
 * 重复的 service 解析 / 路由注册代码。
 *
 * @module @dfh/honeycomb/transport
 */

import type { Context } from '@deepseek-ai/cordis'
import { HoneycombTransport } from './port'
import type { TransportOptions } from './port'
import { registerAllRoutes } from './router'

/** 构建一个已注册全部 REST 路由的 transport（不启动任何网络栈）。 */
export function createHoneycombTransport(
  ctx: Context,
  options: TransportOptions = {},
): HoneycombTransport {
  const services = {
    hive: ctx.get('hive'),
    ledger: ctx.get('ledger'),
    courier: ctx.get('courier'),
    mandate: ctx.get('mandate'),
    roster: ctx.get('roster'),
  }
  const transport = new HoneycombTransport(ctx, services as any, options)
  registerAllRoutes(transport)
  return transport
}
