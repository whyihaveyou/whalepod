import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, apply, createNodeTransportServer } from '../src/index'
import { createHoneycombClient } from '../src/transport/client'
import type { NodeTransportServerHandle } from '../src/index'

let ctx: Context
let server: NodeTransportServerHandle
let client: ReturnType<typeof createHoneycombClient>
let httpUrl: string

before(async () => {
  ctx = new Context()
  const pDir = join(tmpdir(), `dfh-repro-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await apply(ctx, { persistenceDir: pDir })
  server = await createNodeTransportServer(ctx, { host: '127.0.0.1', port: 0 })
  httpUrl = `http://${server.host}:${server.port}`
  client = createHoneycombClient({ httpUrl, wsUrl: `ws://${server.host}:${server.port}/ws` })
  await client.connect()
})

after(async () => {
  await client.close().catch(() => {})
  await server.close().catch(() => {})
})

test('repro task', async () => {
  console.error('R1 hive.create')
  const hive = await client.hive.create({ name: 'live-task', workspace: '/tmp/live' })
  const hiveId = hive.id
  console.error('R2 register')
  const w = await client.member.register(hiveId, { name: 'tw', role: 'worker' as any, backend: 'native' })
  const ownerId = w.id
  console.error('R3 task.create 1')
  const t1 = await client.task.create(hiveId, { subject: 'root' })
  console.error('R4 task.create 2')
  const t2 = await client.task.create(hiveId, { subject: 'child' })
  console.error('R5 get')
  const getT = await client.task.get(hiveId, t1.id)
  assert.equal(getT.id, t1.id)
  console.error('R6 list')
  const listT = await client.task.list(hiveId, { status: 'pending' as any })
  assert.ok(listT.some((x: { id: string }) => x.id === t1.id))
  console.error('R7 update')
  const upd = await client.task.update(hiveId, t1.id, { description: 'desc' })
  assert.equal(typeof upd.id, 'string')
  console.error('R8 setOwner')
  assert.equal(await client.task.setOwner(hiveId, t1.id, ownerId), true)
  console.error('R9 addDep')
  await client.task.addDependency(hiveId, t2.id, t1.id)
  console.error('R10 removeDep')
  assert.equal(await client.task.removeDependency(hiveId, t2.id, t1.id), true)
  console.error('R11 DONE')
})
