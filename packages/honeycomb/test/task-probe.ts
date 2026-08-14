import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, apply, createNodeTransportServer } from '../src/index'
import { createHoneycombClient } from '../src/transport/client'

const guard = (label: string, p: Promise<unknown>, ms = 6000): Promise<unknown> => {
  return Promise.race([
    p.then((v) => ({ ok: true as const, v })),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ])
}

async function main(): Promise<void> {
  const ctx = new Context()
  await apply(ctx, { persistenceDir: join(tmpdir(), `dfh-taskprobe-${Date.now()}`) })
  const server = await createNodeTransportServer(ctx, { host: '127.0.0.1', port: 0 })
  const httpUrl = `http://${server.host}:${server.port}`
  const client = createHoneycombClient({ httpUrl, wsUrl: `ws://${server.host}:${server.port}/ws` })
  await client.connect()

  console.log('T1 hive.create')
  const hive = (await guard('hive.create', client.hive.create({ name: 'tp', workspace: '/tmp' }))) as {
    ok: true
    v: { id: string }
  }
  const hiveId = hive.v.id
  console.log('T2 member.register')
  const w = (await guard(
    'member.register',
    client.member.register(hiveId, { name: 'tw', role: 'worker' as any, backend: 'native' }),
  )) as { ok: true; v: { id: string } }
  console.log('T3 task.create #1')
  const t1 = (await guard('task.create1', client.task.create(hiveId, { subject: 'root' }))) as {
    ok: true
    v: { id: string }
  }
  console.log('T4 task.create #2')
  const t2 = (await guard('task.create2', client.task.create(hiveId, { subject: 'child' }))) as {
    ok: true
    v: { id: string }
  }
  console.log('T5 task.get')
  await guard('task.get', client.task.get(hiveId, t1.v.id))
  console.log('T6 task.list')
  await guard('task.list', client.task.list(hiveId, { status: 'pending' as any }))
  console.log('T7 task.update')
  await guard('task.update', client.task.update(hiveId, t1.v.id, { description: 'desc' }))
  console.log('T8 task.setOwner')
  await guard('task.setOwner', client.task.setOwner(hiveId, t1.v.id, w.v.id))
  console.log('T9 task.addDependency')
  await guard('task.addDependency', client.task.addDependency(hiveId, t2.v.id, t1.v.id))
  console.log('T10 task.removeDependency')
  await guard('task.removeDependency', client.task.removeDependency(hiveId, t2.v.id, t1.v.id))
  console.log('PROBE PASS')
  await client.close().catch(() => {})
  await server.close().catch(() => {})
  await ctx.fiber.dispose()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('PROBE FAIL:', error)
    process.exit(1)
  })
