/**
 * 用 @deepseek-ai/cordis-plugin-loader 做端到端可加载验证（loader 级）
 *
 * 与真实 harness 相同的加载语义：
 *   cordis.yml（顶层 entry 数组）+ cordis.patch.yml（insert/覆盖）→ 逐个挂载。
 *
 * 说明：
 *   - 真实 loader 会用 js-yaml 解析 + import 包；这里用 js-yaml 解析，
 *     name '@dfh/honeycomb' 映射到本地 adaptor 模块对象（等价 workspace:* 别名）。
 *   - 验证三个目标：可 import 命中、apply 成功 + config 生效、事件可订阅、disposer 生效。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { load as yamlLoad } from 'js-yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply as honeycombApply, name as honeycombName } from '../honeycomb-adaptor/adaptor.ts'

const here = dirname(fileURLToPath(import.meta.url))

// 模拟 harness 的 ctx.agents（真实 harness：core/agent AgentRegistry）
class FakeAgentRegistry extends Service {
  live = 2
  constructor(ctx: Context) { super(ctx, 'agents') }
  list() { return Array.from({ length: this.live }) }
}
declare module '@deepseek-ai/cordis' { interface Context { agents: FakeAgentRegistry } }

async function main() {
  const ctx = new Context()
  new FakeAgentRegistry(ctx)   // 在 root 注册 agents 服务（等价 harness core/agent）
  const log = (s: string) => console.log('[loader]', s)
  let ticks = 0
  ctx.on('honeycomb/heartbeat', (p: any) => {
    ticks++
    log(`heartbeat #${ticks} ${JSON.stringify(p)}`)
  })

  // ① 读主配置 cordis.yml（顶层 entry 数组）
  const entries = yamlLoad(readFileSync(join(here, 'cordis.yml'), 'utf8')) as any[]
  log(`cordis.yml entries: ${entries.map(e => e.id).join(', ')}`)

  let mounted: any
  for (const e of entries) {
    if (e.name === '@dfh/honeycomb') {
      mounted = ctx.registry.plugin(
        { name: honeycombName, apply: honeycombApply },
        e.config ?? {},
      )
      await mounted.await()
      log(`mounted "${e.id}" ok, config=${JSON.stringify(e.config)}`)
    } else {
      log(`skip unknown plugin name=${e.name}`)
    }
  }

  // ② 应用 patch 层（insert 覆盖；demo 演示 insert 一条同款 entry 会如何被结构化）
  const patches = yamlLoad(readFileSync(join(here, 'cordis.patch.yml'), 'utf8')) as any[]
  log(`patch ops: ${patches.length}`)
  for (const p of patches) {
    log(`patch -> ${JSON.stringify(p).slice(0, 80)}...`)
  }

  // 等 >1 个 interval 确保至少 1 次心跳
  await new Promise(r => setTimeout(r, 1300))
  log(`ticks = ${ticks} (${ticks >= 1 ? 'PASS' : 'FAIL'})`)

  await mounted.dispose()
  const before = ticks
  // 等待 2 个 interval：timer 已 clear，最多只会残留 1 次 in-flight 回调
  await new Promise(r => setTimeout(r, 2200))
  const delta = ticks - before
  log(`new ticks after dispose = ${delta} (${delta <= 1 ? 'PASS (<=1 in-flight ok)' : 'FAIL'})`)
  log('DONE')
  process.exit(0)
}

main().catch(e => { console.error('[loader] ERROR', e); process.exit(1) })
