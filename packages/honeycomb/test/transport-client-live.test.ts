/**
 * 真对真联调测试（全端点覆盖审计版）：
 * 真实 NodeHttpAdapter+NodeWsAdapter 服务端 × createHoneycombClient 客户端。
 *
 * 覆盖（docs/honeycomb-transport-api.md 全 REST 端点 × WS 帧 × client.ts 封装）：
 *  - hive/member/task/message/mandate 五域全 31 端点，逐个验证「信封解包 + 返回结构」。
 *  - WS：hello / subscribe(等 ack) / unsubscribe / subscribed / unsubscribed / event 推送。
 *  - 断线重连重订：服务端 terminate → 客户端自动重连 + 逐个补订 ack（connected 门控），
 *    重连后事件仍收到、REST 照常。
 *
 * 说明：断言传输层正确性（返回结构符合文档类型），深业务不变量由 e2e-core 等覆盖。
 * Run: npx tsx --test test/transport-client-live.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, apply, createNodeTransportServer } from '../src/index'
import { createHoneycombClient } from '../src/transport/client'
import type { NodeTransportServerHandle } from '../src/index'
import type { HoneycombClient } from '../src/transport/client-types'

let ctx: Context
let server: NodeTransportServerHandle
let client: HoneycombClient
let httpUrl: string

before(async () => {
  ctx = new Context()
  const pDir = join(tmpdir(), `dfh-client-live-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
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

function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (pred()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('condition not met within ' + timeoutMs + 'ms'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

/** 等待某主题事件一次，返回 payload；先挂 listener 再交由调用方触发。 */
function nextEvent(topic: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('event timeout: ' + topic)), timeoutMs)
    client.on(topic, (payload: any) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

/**
 * 等待一次「断线→重连补订」完整循环：
 *  1) connected 先翻 false（客户端观察到 socket 断开）——terminate 后 immediately 轮询可能仍为 true，必须等它先掉；
 *  2) 再翻 true（自动重连 + 逐个补订 ack 完成，connected=OPEN && ready）。
 * 避免 terminate 后 connected 仍为 true 时直接触发事件、而订阅尚在死连接上导致事件丢失的竞态。
 */
async function waitReconnect(timeoutMs = 8000): Promise<void> {
  const t0 = Date.now()
  while (client.connected) {
    if (Date.now() - t0 > timeoutMs) throw new Error('did not observe WS disconnect')
    await new Promise((r) => setTimeout(r, 20))
  }
  await waitFor(() => client.connected, timeoutMs)
}

test('REST hive 全端点', async () => {
  const hive = await client.hive.create({ name: 'live-hive', workspace: '/tmp/live' })
  assert.equal(typeof hive.id, 'string')
  const hiveId = hive.id

  let listed = await client.hive.list()
  assert.ok(listed.some((h: { id: string }) => h.id === hiveId))

  const got = await client.hive.get(hiveId)
  assert.equal(got.id, hiveId)

  // rename / setMode / setSessionMode / remove 服务端返回 ok(true)
  assert.equal(await client.hive.rename(hiveId, 'live-renamed'), true)
  assert.equal(await client.hive.setMode(hiveId, 'isolated'), true)
  assert.equal(await client.hive.setSessionMode(hiveId, 'auto'), true)
  await client.hive.remove(hiveId)

  listed = await client.hive.list()
  assert.ok(!listed.some((h: { id: string }) => h.id === hiveId), 'removed hive no longer listed')
})

test('REST member 全端点', async () => {
  const hive = await client.hive.create({ name: 'live-member', workspace: '/tmp/live' })
  const hiveId = hive.id

  // register（纯注册，不依赖运行时 spawn）
  const m = await client.member.register(hiveId, { name: 'w1', role: 'worker' as any, backend: 'native' })
  assert.equal(typeof m.id, 'string')
  const mid = m.id

  const listM = await client.member.list(hiveId)
  assert.ok(listM.some((x: { id: string }) => x.id === mid))

  const getM = await client.member.get(hiveId, mid)
  assert.equal(getM.id, mid)

  const st = await client.member.state(hiveId, mid)
  assert.equal(st.memberId, mid)
  assert.equal(typeof st.queued, 'object') // queued: {foreground, background}

  // rename 服务端返回 ok(true)
  assert.equal(await client.member.rename(hiveId, mid, 'w1-renamed'), true)

  // hatch：注入 mock ctx.agents 让 native 后端 spawn 可解析（仅验证传输往返 + 返回 Member 结构）
  ;(ctx as any).agents = { spawn: async () => ({}) }
  const hatched = await client.member.hatch(hiveId, {
    name: 'hatched-1',
    role: 'worker' as any,
    backend: 'native',
  })
  assert.equal(typeof hatched.id, 'string')
  assert.equal(await client.member.dismiss(hiveId, hatched.id), true)

  // remove（DELETE，纯 roster 记账）
  await client.member.remove(hiveId, mid)
  const listAfter = await client.member.list(hiveId)
  assert.ok(!listAfter.some((x: { id: string }) => x.id === mid))
})

test('REST task 全端点', async () => {
  const hive = await client.hive.create({ name: 'live-task', workspace: '/tmp/live' })
  const hiveId = hive.id
  const w = await client.member.register(hiveId, { name: 'tw', role: 'worker' as any, backend: 'native' })
  const ownerId = w.id

  const t1 = await client.task.create(hiveId, { subject: 'root' })
  const t2 = await client.task.create(hiveId, { subject: 'child' })
  assert.equal(typeof t1.id, 'string')

  const getT = await client.task.get(hiveId, t1.id)
  assert.equal(getT.id, t1.id)

  const listT = await client.task.list(hiveId, { status: 'backlog' as any }) // 新建任务初始状态是 backlog
  assert.ok(listT.some((x: { id: string }) => x.id === t1.id))

  const upd = await client.task.update(hiveId, t1.id, { description: 'desc' })
  assert.equal(typeof upd.id, 'string')

  // setOwner / addDependency / removeDependency 服务端返回 ok(true)
  assert.equal(await client.task.setOwner(hiveId, t1.id, ownerId), true)
  await client.task.addDependency(hiveId, t2.id, t1.id)
  assert.equal(await client.task.removeDependency(hiveId, t2.id, t1.id), true)
})

test('REST message 全端点', async () => {
  const hive = await client.hive.create({ name: 'live-msg', workspace: '/tmp/live' })
  const hiveId = hive.id
  const w = await client.member.register(hiveId, { name: 'mw', role: 'worker' as any, backend: 'native' })
  const wid = w.id

  const sent = await client.message.send(hiveId, {
    from: wid,
    to: 'all',
    kind: 'note' as any,
    content: 'hello',
  })
  assert.equal(typeof sent.id, 'string') // send 返回完整 Message

  const delivId = await client.message.deliver(hiveId, {
    from: 'user',
    to: wid,
    kind: 'directive' as any,
    content: 'go',
  })
  assert.equal(typeof delivId, 'string')

  const inbox = await client.message.inbox(hiveId, wid, { unreadOnly: true })
  assert.ok(Array.isArray(inbox))

  await client.message.markRead(hiveId, delivId)

  await client.message.broadcast(hiveId, wid, 'broadcast to all')

  const feed = await client.message.feed(hiveId, undefined, 10)
  assert.ok(Array.isArray(feed.items))
})

test('REST mandate 全端点', async () => {
  const hive = await client.hive.create({ name: 'live-mandate', workspace: '/tmp/live' })
  const hiveId = hive.id
  const w = await client.member.register(hiveId, { name: 'mw2', role: 'worker' as any, backend: 'native' })
  const wid = w.id

  // can → boolean；assert → 授权时 resolve(true)（deny 会抛 fail 信封）
  const can = await client.mandate.can(wid, 'courier.send' as any, { hiveId })
  assert.equal(typeof can, 'boolean')

  const assertR = await client.mandate.assert(wid, 'courier.send' as any, { hiveId })
  assert.equal(assertR, true) // 授权通过返回 true

  const grants = await client.mandate.grants(wid)
  assert.ok(Array.isArray(grants))
})

test('WS 订阅/ack/事件推送 + unsubscribe', async () => {
  const hive = await client.hive.create({ name: 'live-ws', workspace: '/tmp/live' })
  const hiveId = hive.id

  await client.subscribe(hiveId) // 内部 await subscribed ack

  const createdP = nextEvent('task/created')
  await client.task.create(hiveId, { subject: 'ws-event' })
  const ev = await createdP
  assert.equal(ev.task.hiveId, hiveId)

  // unsubscribe → ack 静默成功（不再收到该 hive 事件）
  await client.unsubscribe(hiveId)
})

test('断线重连重订（双杀循环）', async () => {
  const hive = await client.hive.create({ name: 'live-reconn', workspace: '/tmp/live' })
  const hiveId = hive.id
  await client.subscribe(hiveId)

  // 第一次杀连接
  assert.equal(server.ws.connectionCount, 1)
  const sock = [...server.ws.wss.clients][0]
  sock.terminate()
  await waitReconnect() // 等 connected 翻 false 再翻 true（补订全齐）

  const afterP = nextEvent('task/created')
  await client.task.create(hiveId, { subject: 'reconn-1' })
  const ev1 = await afterP
  assert.equal(ev1.task.subject, 'reconn-1')

  // 断线后 REST 照常
  const listed = await client.hive.list()
  assert.ok(listed.some((h: { id: string }) => h.id === hiveId))

  // 第二次杀连接
  const sock2 = [...server.ws.wss.clients][0]
  sock2.terminate()
  await waitReconnect()

  const afterP2 = nextEvent('task/created')
  await client.task.create(hiveId, { subject: 'reconn-2' })
  const ev2 = await afterP2
  assert.equal(ev2.task.subject, 'reconn-2')
})
