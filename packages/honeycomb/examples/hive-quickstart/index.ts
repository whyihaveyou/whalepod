/**
 * Honeycomb quickstart — 一条命令跑通 hive 全流程（活文档 + 联调入口）。
 *
 * 采用「mock 驱动」方式把编排流转演出来（真实编排循环当前在 src 侧有阻塞 bug，
 * 见 README「切到真编排循环」一节）。每一步对应哪个 service / 事件：
 *   apply(boot, tmp persistenceDir)          → 插件装配
 *   → ctx.hive.create                        → hive/created、member/status（queen 孵化）
 *   → ctx.roster.hatch                       → member/registered、member/hatched、member/status(idle)
 *   → ctx.ledger.create                      → task/created
 *   → 派工：ledger.update(in-progress+owner) → task/updated
 *   → ctx.courier.send(directive)            → message/created（王 → 工）
 *   → mock worker 经 courier 回 report        → message/created（工 → 王）
 *   → 完成：ledger.update(completed)          → task/updated
 *
 * 只新增 examples/；不改任何 src/ 业务逻辑。
 *
 * 运行：`npm run example`（= tsx examples/hive-quickstart/index.ts）
 */

/* eslint-disable no-console */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context, apply } from '../../src/index'
import type { MemberRuntime } from '../../src/runtime/registry'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const ctx = new Context()
  const persistenceDir = await mkdtemp(join(tmpdir(), 'dfh-quickstart-'))
  await apply(ctx, { persistenceDir })

  // 收集关键事件流（活文档输出）
  const stream: string[] = []
  ;(['hive/created', 'member/status', 'member/hatched', 'task/created', 'task/updated', 'message/created'] as const).forEach((n) =>
    ctx.on(n, (p) => void stream.push(`${n} ${JSON.stringify(p)}`)),
  )

  // ---------- mock worker 运行时：收到派工 → 干活 → 经 courier 回 report ----------
  let queenId = ''
  const mock: MemberRuntime = {
    id: 'mock',
    async hatch(_c, input) {
      const { hiveId, id } = input.member
      return {
        sessionId: `sess_${id}`,
        async send(message) {
          console.log(`  📬 [worker:${id}] 收到派工 →「${message.content}」，干完，经 courier 回 report…`)
          await ctx.courier.send(hiveId, { from: id, to: queenId, kind: 'report', content: `完成：${message.content}` })
        },
        async *events() {},
        async close() {},
        async kill() {},
      }
    },
  }
  ctx.roster.registerRuntime(mock) // 孵化前注册 mock 后端

  // ---------- ① 建 hive（queen） ----------
  const hive = await ctx.hive.create({
    name: 'quickstart',
    workspace: '/tmp/quickstart',
    workspaceMode: 'shared',
    queen: { name: 'queen', role: 'queen', backend: 'mock' },
  })
  queenId = hive.queenId
  console.log(`✔ ① hive 建成 ${hive.id} (queen=${queenId})`)

  // ---------- ② roster：孵化一个 worker（hatch 内部 = 注册+孵化二合一） ----------
  const worker = await ctx.roster.hatch(hive.id, { name: 'worker', role: 'worker', backend: 'mock' })
  console.log(`✔ ② worker 就绪 ${worker.id} (status=${worker.status})`)

  // ---------- ③ ledger：建任务 ----------
  const task = await ctx.ledger.create(hive.id, { subject: '构建并分发 .dmg 安装包', owner: null })
  console.log(`✔ ③ 任务入账 ${task.id} → status=${task.status}`)

  // ---------- ④ 派工：指派 + 发 directive（经 roster.sendTo 路由到 worker 的运行时句柄） ----------
  await ctx.ledger.update(task.id, { status: 'in-progress', owner: worker.id })
  await ctx.courier.send(hive.id, { from: queenId, to: worker.id, kind: 'directive', content: '打包吧' }) // 持久到 worker 收件箱
  const delivered = await ctx.roster.sendTo(hive.id, worker.id, { role: 'queen', content: '打包吧' }) // 路由进 mock 句柄 → worker 干活并 report
  console.log(`✔ ④ 派工：task 置 in-progress + 归属 worker；directive 已送达 handle（sendTo=${delivered}）`)

  await sleep(5) // 让 mock worker 的 report 事件落定

  // ---------- ⑤ 完成：worker 已 report，标记 completed ----------
  await ctx.ledger.update(task.id, { status: 'completed' })
  const fresh = await ctx.ledger.get(task.id)
  console.log(`✔ ⑤ 交付：task → status=${fresh?.status} owner=${fresh?.owner ?? '—'}`)

  // ---------- ⑥ 终态速览 ----------
  const roster = await ctx.roster.list(hive.id)
  console.log(`✔ ⑥ 名册: ${roster.map((m) => `${m.name}(${m.role}/${m.status})`).join(', ')}`)

  const queenInbox = await ctx.courier.inbox(hive.id, queenId, { unreadOnly: false })
  const reportCount = queenInbox.filter((m) => m.kind === 'report').length
  console.log(`✔ 女王收件箱: ${queenInbox.length} 条（其中 ${reportCount} 条 worker report）`)

  // ---------- ⑦ 事件流 + 落盘 ----------
  console.log(`\n—— 关键事件流（${stream.length} 条，截前 12）——`)
  for (const line of stream.slice(0, 12)) console.log('  ' + line)

  console.log(`\n持久化事实日志: ${join(persistenceDir, hive.id, 'facts.ndjson')}`)

  // 重启重放验证：同一目录重建 store → 恢复快照
  const { FactStore } = await import('../../src/persistence/store')
  const { JsonlFactBackend } = await import('../../src/persistence/jsonl')
  const restored = new FactStore(new JsonlFactBackend({ dir: persistenceDir }))
  await restored.load()
  console.log(`重启重放: hive=${restored.hive(hive.id)?.name} task=${restored.task(task.id)?.status} member=${restored.member(worker.id)?.name}`)
}

void main().catch((error) => {
  console.error('quickstart 失败：', error)
  process.exitCode = 1
})
