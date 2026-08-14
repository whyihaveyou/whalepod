import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, apply, createNodeTransportServer } from '../src/index'
import { createHoneycombClient } from '../src/transport/client'
import type { NodeTransportServerHandle } from '../src/index'

let ctx: Context
let server: NodeTransportServerHandle
let client: ReturnType<typeof createHoneycombClient>
let httpUrl: string

const log = (...a: unknown[]) => console.error('[live-repro]', ...a)

async function main(): Promise<void> {
  ctx = new Context()
  await apply(ctx, { persistenceDir: join(tmpdir(), `dfh-repro2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`) })
  server = await createNodeTransportServer(ctx, { host: '127.0.0.1', port: 0 })
  httpUrl = `http://${server.host}:${server.port}`
  client = createHoneycombClient({ httpUrl, wsUrl: `ws://${server.host}:${server.port}/ws` })
  await client.connect()
  log('connected')

  // === hive test ===
  log('H1 hive.create')
  const hive = await client.hive.create({ name: 'live-hive', workspace: '/tmp/live' })
  const hiveId = hive.id
  log('H2 hive.list')
  const list = await client.hive.list()
  log('H3 hive.get', typeof hiveId)
  await client.hive.get(hiveId)
  log('H4 hive.rename')
  assertTrue(await client.hive.rename(hiveId, 'renamed-hive'))
  log('H5 hive.remove')
  assertTrue(await client.hive.remove(hiveId))
  log('HIVE TEST DONE')

  // === member test ===
  log('M1 hive.create (member hive)')
  const h2 = await client.hive.create({ name: 'live-member', workspace: '/tmp/live' })
  const h2id = h2.id
  log('M2 register')
  const w1 = await client.member.register(h2id, { name: 'mw', role: 'worker' as any, backend: 'native' })
  log('M3 register queen')
  const q1 = await client.member.register(h2id, { name: 'mq', role: 'queen' as any, backend: 'native' })
  log('M4 list members')
  await client.member.list(h2id)
  log('M5 hatch')
  ;(ctx as any).agents = { spawn: async () => ({}) }
  const hatched = await client.member.hatch(h2id, { name: 'hatch-m', role: 'worker' as any, backend: 'native' })
  log('M6 dismiss', typeof hatched.id)
  assertTrue(await client.member.dismiss(h2id, hatched.id))
  log('M7 remove w1')
  assertTrue(await client.member.remove(h2id, w1.id))
  log('M8 listAfter')
  const after = await client.member.list(h2id)
  log('MEMBER TEST DONE', after.length)

  // === task test ===
  log('T1 hive.create (task hive)')
  const h3 = await client.hive.create({ name: 'live-task', workspace: '/tmp/live' })
  const hiveId2 = h3.id
  log('T2 register')
  const w2 = await client.member.register(hiveId2, { name: 'tw', role: 'worker' as any, backend: 'native' })
  log('T3 task.create 1')
  const t1 = await client.task.create(hiveId2, { subject: 'root' })
  log('T4 task.create 2')
  const t2 = await client.task.create(hiveId2, { subject: 'child' })
  log('T5 task.get')
  const getT = await client.task.get(hiveId2, t1.id)
  log('T6 task.list')
  const listT = await client.task.list(hiveId2, { status: 'pending' as any })
  log('TASK TEST DONE', listT.length)
}

function assertTrue(v: unknown): boolean {
  if (v !== true) throw new Error('expected true, got ' + JSON.stringify(v))
  return true
}

main()
  .then(() => {
    log('ALL DONE')
    process.exit(0)
  })
  .catch((error) => {
    log('FAIL:', error)
    process.exit(1)
  })
