/**
 * 运行入口：用 Context 手动挂载插件，演示最小闭环。
 *
 * 真实 dsh 中无需手写这份 —— loader 读取 cordis.yml 自动挂载。
 * 这里手动挂载是为了「最小可运行」地展示 API。
 */
import { Context } from '@deepseek-ai/cordis'
import {
  greetingName,
  greetingApply,
  name as counterName,
  inject as counterInject,
  apply as counterApply,
} from './plugin.js'

async function main() {
  const ctx = new Context()

  // 监听插件触发的事件（演示 Events 总线）
  ctx.on('minimal-counter/tick', (n: number) => {
    if (n >= 3) {
      console.log('reached 3 ticks, shutting down...')
      void shutdown()
    }
  })

  // 1) 挂载服务提供者（等价 cordis.yml 里靠前的一条 entry）
  ctx.plugin({ name: greetingName, apply: greetingApply })

  // 2) 挂载消费者插件（等价 cordis.yml 里靠后的一条 entry）
  //    name/inject 由模块导出，模拟 loader 的注入行为
  ctx.plugin(
    { name: counterName, inject: counterInject, apply: counterApply },
    { name: 'Cordis', interval: 500 },
  )

  console.log('minimal-counter started (interval 500ms), waiting for 3 ticks...')

  let disposed = false
  async function shutdown() {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose() // 生命周期：逆序执行所有 disposer
    console.log('context disposed. bye.')
    process.exit(0)
  }

  // 兜底：5 秒后强制退出
  setTimeout(() => void shutdown(), 5000)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
