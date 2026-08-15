/**
 * 最小「真实 cordis」honeycomb 接入插件 —— 用于 harness 可加载验证。
 *
 * 对照 honeycomb 现有 plugin.ts（自造 framework shim）：
 *   - 这里用真实 `@deepseek-ai/cordis` Context（与 harness 同源）
 *   - 通过 `inject: ['agents']` 声明依赖 harness 的 AgentRegistry
 *   - 通过 `ctx.parallel` / `ctx.on` / `ctx.logger` 使用真实服务
 *   - 定时器用 `ctx.effect(...)` 注册 —— cordis 官方 timer 插件的正统写法
 *     （disposer 由 fiber 管理，dispose 时序可靠）
 *
 * 这不是 honeycomb 完整重写，只是「能被 loader 加载并启用」的最小证明。
 */
import { Context } from '@deepseek-ai/cordis'

export const name = '@whalepod/honeycomb'
export const inject = ['agents']

export interface HoneycombConfig {
  /** 心跳上报间隔（毫秒） */
  interval?: number
}

export function apply(ctx: Context, config: HoneycombConfig = {}) {
  const { interval = 1000 } = config
  const logger = ctx.logger('honeycomb')

  // cordis 官方范式：ctx.effect 注册副作用，disposer 由 fiber 可靠地逆序执行
  ctx.effect(() => {
    const timer = setInterval(() => {
      const count = ctx.agents.list().length
      logger.info('hive heartbeat: %d live agents', count)
      // 触发业务事件（业务命名空间，避开 internal/ 前缀）
      void ctx.parallel('honeycomb/heartbeat', { liveAgents: count })
    }, interval)
    return () => clearInterval(timer)
  }, 'honeycomb:heartbeat')

  // 订阅 harness 的 agent 生命周期事件作为接入示例（用 effect 保证随插件释放）
  ctx.effect(() => {
    const off = ctx.on('agent/ready', (agent: { id: string }) => {
      logger.info('agent ready: %s', agent.id)
    })
    return () => off?.()
  }, 'honeycomb:agent-ready')
}
