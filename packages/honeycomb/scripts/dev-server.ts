/**
 * honeycomb dev-server —— 前端真连接的联调入口
 *
 * 启动（本目录）：
 *   npm run dev-server            （默认 127.0.0.1:4800，WS 同端口 /ws 路径）
 *   HONEYCOMB_DEV_PORT=4900 npm run dev-server
 *
 * 前端（prototypes/team-panel）：
 *   VITE_TEAM_API=honeycomb VITE_HONEYCOMB_HIVE=<启动时打印的 hive id> npx vite dev
 *
 * 说明：
 * - boot 真 cordis Context + apply + createNodeTransportServer（与 test/transport-client-live.test.ts 同源）；
 * - 种子数据只 create 不 remove（已知 live 接缝在 remove→create 路径，避开）；
 * - persistenceDir 走 tmpdir，每次启动全新，Ctrl-C 退出即止。
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, apply, createNodeTransportServer } from '../src/index'
import { createHoneycombClient } from '../src/transport/client'

const HOST = process.env.HONEYCOMB_DEV_HOST ?? '127.0.0.1'
const PORT = Number(process.env.HONEYCOMB_DEV_PORT ?? 4800)

async function main(): Promise<void> {
  const ctx = new Context()
  const persistenceDir = join(tmpdir(), `honeycomb-dev-${Date.now()}`)
  await apply(ctx, { persistenceDir })

  const server = await createNodeTransportServer(ctx, { host: HOST, port: PORT })
  const httpUrl = `http://${server.host}:${server.port}`
  const wsUrl = `ws://${server.host}:${server.port}/ws`
  console.log(`[dev-server] transport listening: ${httpUrl} (WS: ${wsUrl})`)

  // ---- 种子数据（用 client SDK 走真实 REST 路径，顺带冒烟） ----
  const client = createHoneycombClient({ httpUrl, wsUrl })
  await client.connect()

  const hive = await client.hive.create({ name: 'whalepod-dev', workspace: '/tmp/whalepod-dev' })
  console.log(`[dev-server] hive created: ${hive.id}`)

  const queen = await client.member.register(hive.id, {
    name: 'Queen-1', role: 'queen' as never, backend: 'native',
  })
  const workers = await Promise.all([
    client.member.register(hive.id, { name: 'Worker-Alpha', role: 'worker' as never, backend: 'native' }),
    client.member.register(hive.id, { name: 'Worker-Beta', role: 'worker' as never, backend: 'native' }),
  ])
  console.log(`[dev-server] members: queen=${queen.id}, workers=${workers.map(w => w.id).join(', ')}`)

  const t1 = await client.task.create(hive.id, { subject: '搭建 transport 联调环境' })
  const t2 = await client.task.create(hive.id, { subject: '团队面板接真实数据' })
  const t3 = await client.task.create(hive.id, { subject: '鲸群品牌收束' })
  await client.task.addDependency(hive.id, t3.id, t1.id)
  console.log(`[dev-server] tasks: ${[t1.id, t2.id, t3.id].join(', ')} (t3 blockedBy t1)`)

  await client.close()

  console.log('\n================ 前端接入指引 ================')
  console.log('cd prototypes/team-panel')
  console.log(`VITE_TEAM_API=honeycomb VITE_HONEYCOMB_HIVE=${hive.id} npx vite dev`)
  console.log('（HTTP/WS 地址默认即本 server；Ctrl-C 退出 dev-server）')
  console.log('==============================================\n')

  const shutdown = async (): Promise<void> => {
    console.log('[dev-server] shutting down…')
    await server.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('[dev-server] fatal:', err)
  process.exit(1)
})
