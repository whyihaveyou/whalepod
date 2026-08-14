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
  console.log('connected')

  const hive = await client.hive.create({ name: 'live-ws', workspace: '/tmp/live' })
  const hiveId = hive.id

  // case 6: subscribe + ack + event + unsubscribe
  console.log('subscribing...')
  await client.subscribe(hiveId)
  console.log('subscribed (ack)')
  const createdP = new Promise((r) => client.on('task/created', r))
  await client.task.create(hiveId, { subject: 'ws-event' })
  const ev = await createdP
  console.log('event received', ev.task.subject)
  console.log('unsubscribing...')
  await client.unsubscribe(hiveId)
  console.log('unsubscribed (ack)')

  // case 7: reconnect double-kill
  console.log('reconnect: resubscribing for kill test')
  await client.subscribe(hiveId)
  console.log('kill #1... connectionCount=', server.ws.connectionCount)
  const sock = [...server.ws.wss.clients][0]
  sock.terminate()
  console.log('waiting reconnect...')
  const t0 = Date.now()
  while (!client.connected) {
    if (Date.now() - t0 > 8000) { console.error('RECONNECT TIMEOUT'); process.exit(3) }
    await new Promise((r) => setTimeout(r, 20))
  }
  console.log('reconnected after', Date.now() - t0, 'ms')
  const p2 = new Promise((r) => client.on('task/created', r))
  await client.task.create(hiveId, { subject: 'reconn-1' })
  const ev2 = await p2
  console.log('post-reconnect event', ev2.task.subject)
  console.log('kill #2...')
  const sock2 = [...server.ws.wss.clients][0]
  sock2.terminate()
  const t1 = Date.now()
  while (!client.connected) {
    if (Date.now() - t1 > 8000) { console.error('RECONNECT2 TIMEOUT'); process.exit(4) }
    await new Promise((r) => setTimeout(r, 20))
  }
  console.log('reconnected2 after', Date.now() - t1, 'ms')
  const p3 = new Promise((r) => client.on('task/created', r))
  await client.task.create(hiveId, { subject: 'reconn-2' })
  const ev3 = await p3
  console.log('post-reconnect2 event', ev3.task.subject)

  await client.close()
  await server.close()
  console.log('DONE-ALL')
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e); process.exit(1) })
setTimeout(() => { console.error('>>> WATCHDOG hang'); process.exit(2) }, 20000).unref()
