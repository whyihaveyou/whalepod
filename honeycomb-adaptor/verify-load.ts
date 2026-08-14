/**
 * 本机可加载验证（不侵入 harness monorepo）
 *
 * 用与 harness 同源的 @deepseek-ai/cordis 构造一个 Context，模拟 harness 的
 * ctx.agents（AgentRegistry 桩），然后加载 honeycomb-adaptor 插件：
 *   - 证明真实 cordis 能 plugin() 该插件
 *   - 证明 inject=['agents'] 被解析
 *   - 证明 heartbeat 心跳事件触发
 *   - 证明删除插件时 disposer 生效
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { apply as honeycombApply, name as honeycombName, inject as honeycombInject } from '../honeycomb-adaptor/adaptor.ts'

// ---- 模拟 harness 的 ctx.agents：AgentRegistry 桩（真实 harness 是 core/agent） ----
// 注意：Service 子类必须显式 constructor 调 super(ctx, name)，否则不注册！
class FakeAgentRegistry extends Service {
  live = 2
  constructor(ctx: Context) { super(ctx, 'agents') }
  list() { return Array.from({ length: this.live }) }
}
declare module '@deepseek-ai/cordis' {
  interface Context { agents: FakeAgentRegistry }
}

async function main() {
  const ctx = new Context()
  // 注册 harness-style 服务 —— 直接在 root 上 new（不在插件 apply 里，避免层级问题）
  new FakeAgentRegistry(ctx)

  // 订阅插件心跳事件，验证事件总线
  let ticks = 0
  const off = ctx.on('honeycomb/heartbeat', (payload: { liveAgents: number }) => {
    ticks++
    console.log('[verify] honeycomb/heartbeat', JSON.stringify(payload))
  })

  // 挂载被验证的 honeycomb 插件（loader 内部就是 ctx.registry.plugin）
  const fiber = ctx.registry.plugin(
    { name: honeycombName, inject: honeycombInject, apply: honeycombApply },
    { interval: 300 },
  )
  await fiber.await()
  console.log('[verify] plugin mounted:', honeycombName)

  // 等几拍心跳
  await new Promise((r) => setTimeout(r, 1100))
  console.log(`[verify] ticks received = ${ticks} (${ticks >= 2 ? 'PASS' : 'FAIL'})`)

  // 卸载 —— disposer 应清理定时器（之后 ping 不再出现）
  await fiber.dispose()
  const before = ticks
  await new Promise((r) => setTimeout(r, 700))
  console.log(`[verify] no ticks after dispose = ${ticks === before ? 'PASS' : 'FAIL'}`)

  off()
  console.log('[verify] DONE')
  process.exit(0)
}

main().catch((e) => { console.error('[verify] ERROR', e); process.exit(1) })
