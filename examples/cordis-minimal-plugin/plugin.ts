/**
 * 最小可运行 Cordis 插件示例 —— 覆盖 service / events / lifecycle / config / persistence
 *
 * 两个插件演示「谁提供服务、谁消费服务」的典型 DI 模式：
 *   1. greeting-provider —— 注册 GreetingService 服务
 *   2. minimal-counter  —— 通过 inject 声明依赖、消费服务
 *
 * 五个主题对应位置：
 *   - Service + DI   : GreetingService（super(ctx,'greeting')）+ counter 的 inject + ctx.get
 *   - Events         : ctx.parallel('minimal-counter/tick', n) + ctx.on(...)
 *   - Lifecycle      : apply 返回 disposer + ctx.fiber.dispose()
 *   - Config         : apply(ctx, config) 读取 { name, interval }
 *   - Persistence    : 真实 dsh 里用 loader 的 entry.update() 写回 yml（见 README）
 */
import { Context, Service } from '@deepseek-ai/cordis'

// ========== 1. Service 定义 ==========
// 继承 Service 并 super(ctx, '服务名')，即注册为可被 ctx.get('greeting') 注入的服务
class GreetingService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeting')
  }

  greet(who: string) {
    return `hello, ${who}`
  }
}

// ========== 插件 A：服务提供者 ==========
export const greetingName = 'greeting-provider'
export function greetingApply(ctx: Context) {
  // 实例化即注册（Service 构造器内部调用 ctx.reflect.provide）
  new GreetingService(ctx)
}

// ========== 插件 B：服务消费者（计数器） ==========
export interface Config {
  /** 打招呼的人名 */
  name?: string
  /** 计数器上报间隔（毫秒） */
  interval?: number
}

export const name = 'minimal-counter'
// 依赖注入：声明需要 greeting 服务，loader 会在 apply 前确保它可用
export const inject = ['greeting']

export function apply(ctx: Context, config: Config = {}) {
  const { name: who = 'world', interval = 1000 } = config

  // 取注入的服务（懒创建；已由 greeting-provider 注册）
  const greeting = ctx.get<GreetingService>('greeting')
  // 惯用写法是 ctx.logger('minimal-counter').info(...)，但 bare cordis 默认无
  // 日志 exporter（真实 dsh 会注入），示例用 console.log 保证肉眼可见
  const log = (msg: string) => console.log('[minimal-counter]', msg)

  let n = 0
  const timer = setInterval(() => {
    n++
    log(`${greeting.greet(who)} #${n}`)

    // 触发自定义异步事件（不 await，交给监听方并行处理）
    void ctx.parallel('minimal-counter/tick', n)
  }, interval)

  // 返回 disposer：插件卸载时自动清理定时器
  return () => clearInterval(timer)
}
