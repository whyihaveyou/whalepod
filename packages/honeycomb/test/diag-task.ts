import { Context, apply, createNodeTransportServer } from '../src/index'
import { createHoneycombClient } from '../src/transport/client'

async function main() {
  const ctx = new Context()
  await apply(ctx, { persistenceDir: './tmp-diag-' + Date.now() })
  const server = await createNodeTransportServer(ctx, { host: '127.0.0.1', port: 0 })
  const httpUrl = `http://${server.host}:${server.port}`
  const wsUrl = `ws://${server.host}:${server.port}/ws`
  const client = createHoneycombClient({ httpUrl, wsUrl })
  await client.connect()
  console.log('boot+connect OK')

  // ---- task test ----
  console.log('T ask create hive')
  const hive = await client.hive.create({ name: 'live-task', workspace: '/tmp/live' })
  const hiveId = hive.id
  console.log('T hive', hiveId)
  const w = await client.member.register(hiveId, { name: 'tw', role: 'worker' as any, backend: 'native' })
  console.log('T register', w.id)
  console.log('T creating t1...')
  const t1 = await client.task.create(hiveId, { subject: 'root' })
  console.log('T t1', t1.id)
  const t2 = await client.task.create(hiveId, { subject: 'child' })
  console.log('T t2', t2.id)
  const getT = await client.task.get(hiveId, t1.id)
  console.log('T getT', getT.id)
  const listT = await client.task.list(hiveId, { status: 'pending' as any })
  console.log('T listT len', listT.length)
  console.log('T update...')
  const upd = await client.task.update(hiveId, t1.id, { description: 'desc' })
  console.log('T update', typeof upd.id)
  console.log('T setOwner...')
  const owned = await client.task.setOwner(hiveId, t1.id, w.id)
  console.log('T setOwner', owned)
  console.log('T addDep...')
  await client.task.addDependency(hiveId, t2.id, t1.id)
  console.log('T addDep done')
  const rmdep = await client.task.removeDependency(hiveId, t2.id, t1.id)
  console.log('T rmdep', rmdep)

  await client.close()
  await server.close()
  console.log('DONE-ALL')
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e); process.exit(1) })
setTimeout(() => { console.error('>>> WATCHDOG hang'); process.exit(2) }, 20000).unref()
