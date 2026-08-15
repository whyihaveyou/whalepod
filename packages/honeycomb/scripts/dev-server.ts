/**
 * dev-server：一行起前端联调服务。
 *
 * 真 cordis Context + apply(honeycomb) + createNodeTransportServer：
 *   - HTTP REST → http://127.0.0.1:4800
 *   - WS  事件   → ws://127.0.0.1:4800/ws   （HTTP+WS 同端口，WS 走 /ws 升级）
 * boot 写法照抄 test/transport-client-live.test.ts 的 before 块。
 *
 * 种子数据（照 examples/hive-quickstart 的 mock 驱动方式）：
 *   hive 'hive-dev' + queen/worker（mock MemberRuntime）
 *   + 2~3 个 tasks + 若干 messages（directive/report）。
 *
 * Run: npm run dev-server   （= npx tsx scripts/dev-server.ts）
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, apply, createNodeTransportServer } from '../src/index'
import type { MemberRuntime } from '../src/runtime/registry'

const HTTP_PORT = 4800
const HOST = '127.0.0.1'
/** 联调用的固定 hive 名称（hive id 由 honeycomb 自动生成，见下方 seed 日志） */
const HIVE_NAME = 'hive-dev'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const ctx = new Context()
  const persistenceDir = await mkdtemp(join(tmpdir(), 'dfh-dev-server-'))
  await apply(ctx, { persistenceDir })

  // native 后端 spawn 需要 ctx.agents 可解析（照 live test line 125）
  ;(ctx as any).agents = { spawn: async () => ({}) }

  // ---------- seed：mock 运行时 ----------
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
  ctx.roster.registerRuntime(mock)

  // ---------- seed：建 hive（queen） ----------
  const hive = await ctx.hive.create({
    name: HIVE_NAME,
    workspace: '/tmp/hive-dev',
    workspaceMode: 'shared',
    queen: { name: 'queen', role: 'queen', backend: 'mock' },
  })
  queenId = hive.queenId
  console.log(`[dev-server] seed hive ${hive.id} (queen=${queenId})`)

  // ---------- seed：孵化 worker ----------
  const worker = await ctx.roster.hatch(hive.id, { name: 'worker', role: 'worker', backend: 'mock' })
  console.log(`[dev-server] seed worker ${worker.id} (status=${worker.status})`)

  // ---------- seed：2~3 条任务 + 消息 ----------
  const task1 = await ctx.ledger.create(hive.id, { subject: '构建并分发 .dmg 安装包' })
  const task2 = await ctx.ledger.create(hive.id, { subject: '接入真实 honeycomb transport 到前端' })
  const task3 = await ctx.ledger.create(hive.id, { subject: '整理联调文档与启动指引' })
  console.log(`[dev-server] seed tasks: ${task1.id}, ${task2.id}, ${task3.id}`)

  await ctx.ledger.update(task1.id, { status: 'in-progress', owner: worker.id })
  await ctx.courier.send(hive.id, { from: queenId, to: worker.id, kind: 'directive', content: '先把 dmg 打包脚本跑起来' })
  await ctx.courier.send(hive.id, { from: queenId, to: worker.id, kind: 'directive', content: 'transport 端口确认 4800 后接前端' })
  await ctx.roster.sendTo(hive.id, worker.id, { role: 'queen', content: '先把 dmg 打包脚本跑起来' })
  console.log(`[dev-server] seed messages (directive/report)…`)
  await sleep(5) // 让 mock worker 的 report 事件落定

  // ---------- 起 transport ----------
  const server = await createNodeTransportServer(ctx, { host: HOST, port: HTTP_PORT })
  const { host, port } = server

  console.log('')
  console.log(`[dev-server] honeycomb transport up on ${host}:${port}`)
  console.log(`[dev-server]   REST -> http://${host}:${port}`)
  console.log(`[dev-server]   WS   -> ws://${host}:${port}/ws`)
  console.log(`[dev-server]   seed hive -> name=${hive.name}  id=${hive.id}`)
  console.log('')
  console.log('  --- 前端连接指引 ---')
  console.log(`  VITE_TEAM_API=honeycomb VITE_HONEYCOMB_HIVE=${hive.id} npx vite dev`)
  console.log('  (hive id 由 honeycomb 自动生成，非 name；必须用上面的真实 id 订阅)')
  console.log('  (缺省走 mock：VITE_TEAM_API 不设即可)')
  console.log('')

  const shutdown = async (): Promise<void> => {
    console.log('[dev-server] shutting down...')
    await server.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((err) => {
  console.error('[dev-server] fatal:', err)
  process.exit(1)
})
