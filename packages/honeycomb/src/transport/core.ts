/**
 * core — 共享 transport 装配核心（内存版与 Node 网络版共用）.
 *
 * 统一：从 ctx 解析已 provide 的 5 个服务 → 构造 `HoneycombTransport` → 注册全部
 * REST 路由。内存版（memory.ts）与真实网络版（server.ts）都用本函数，避免三份
 * 重复的 service 解析 / 路由注册代码。
 *
 * @module @whalepod/honeycomb/transport
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
    // 注意：non-strict get（strict=false）——cordis 的 strict get 要求提供方 fiber
    // 处于 active（state 2），而 cordis-plugin-loader 在 dsh 运行时的 entry fiber
    // 启动阶段（state 1）就调用 apply；此时 strict get 恒 undefined（实测
    // fiberState=1），transport 会以 services=undefined 启动、路由全部 500。
    // 这些服务由同一 entry fiber 同步 provide，non-strict 读取是安全的。
    hive: ctx.get('hive', false),
    ledger: ctx.get('ledger', false),
    courier: ctx.get('courier', false),
    mandate: ctx.get('mandate', false),
    roster: ctx.get('roster', false),
    // cancel 通道门面（可选）：装配方把 createOrchestrationLoop 句柄从
    // options.orchestration 传进来；缺省时 POST /tasks/{id}/cancel 对在途
    // 任务返回 503 ORCHESTRATION_UNAVAILABLE，其余路径不受影响。
    orchestration: options.orchestration,
  }
  const transport = new HoneycombTransport(ctx, services as any, options)
  registerAllRoutes(transport)
  return transport
}
