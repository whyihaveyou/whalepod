/**
 * 真对真联调测试：真实 NodeHttpAdapter+NodeWsAdapter 服务端 × createHoneycombClient 客户端，
 * 全部走真实网络栈（node:http + ws 包服务端 × 平台 fetch + globalThis.WebSocket 客户端）。
 *
 * 覆盖（前端依赖 SDK 前的最后一道闸）：
 *  1. REST 查询/变更：经 client.hive / client.task 建 hive、列 hive、建 task（信封解包）。
 *  2. 订阅 + 等 ack：client.subscribe(hiveId) 内部 await subscribed ack，再 register on('task/created')。
 *  3. 事件推送：触发 task/created → 客户端 handler 收到 event 帧（订阅在先、触发在后的正确时序）。
 *  4. 断线重连重订：服务端强制 terminate 客户端 socket → 客户端自动重连 + 逐个补订 ack
 *     （client.connected 只在补订完成后才为 true）→ 再触发事件仍能收到，
 *     并验证断线后 REST 照常可用。
 *
 * Run: npx tsx --test test/transport-client-live.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, apply, createNodeTransportServer } from '../src/index'
import { createHoneycombClient } from '../src/transport/client'
import type { NodeTransportServerHandle } from '../src/index'
import type { HoneycombClient } from '../src/transport/client-types'

async function main(): Promise<void> {
  const ctx = new Context()
  const pDir = join(tmpdir(), `dfh-client-live-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await apply(ctx, { persistenceDir: pDir })

  const server: NodeTransportServerHandle = await createNodeTransportServer(ctx, {
    host: '127.0.0.1',
    port: 0,
  })
  const httpUrl = `http://${server.host}:${server.port}`
  const wsUrl = `ws://${server.host}:${server.port}/ws`
  assert.ok(server.port > 0, 'server bound to a real port')

  const client: HoneycombClient = createHoneycombClient({ httpUrl, wsUrl })

  try {
    // ---- 1. REST：建 hive + 列表 + 建 task（信封解包） ----------------------
    const hive = await client.hive.create({ name: 'live-panel', workspace: '/tmp/live' })
    assert.equal(typeof hive.id, 'string')
    const hiveId = hive.id

    let listed = await client.hive.list()
    assert.ok(listed.some((h: { id: string }) => h.id === hiveId), 'hive list contains created hive')

    // ---- 2. 订阅 + 等 ack --------------------------------------------------
    await client.connect()      // 真实 WS 握手
    assert.equal(client.connected, true)
    await client.subscribe(hiveId)  // 内部等待 subscribed ack（消除订阅 vs 事件竞态）

    // ---- 3. 事件推送：先挂 handler，再触发 ----------------------------------
    const created: Promise<any> = new Promise((resolve) => {
      client.on('task/created', resolve)
    })
    const task = await client.task.create(hiveId, { subject: 'live-event' })
    const ev = await created
    assert.equal(ev.task.hiveId, hiveId)
    assert.equal(ev.task.subject, 'live-event')
    assert.equal(task.id, ev.task.id)

    // ---- 4. 断线重连重订 ---------------------------------------------------
    // 服务端强制 terminate 客户端的唯一 WS 连接，触发客户端 onclose → 自动重连 + 补订。
    assert.equal(server.ws.connectionCount, 1, 'one live WS connection before kill')
    const sock = [...server.ws.wss.clients][0]
    assert.ok(sock, 'server holds the client socket')
    sock.terminate()

    // 等待客户端自动重连：connected 只在「socket OPEN 且补订全部 ack 完成」后为 true（MED-5）。
    await waitFor(() => client.connected, 5_000)

    // 重连补订完成后再触发事件，仍应收到（HIGH-1：若补订丢订阅会收不到）。
    const afterReconnect: Promise<any> = new Promise((resolve) => {
      client.on('task/created', resolve)
    })
    await client.task.create(hiveId, { subject: 'after-reconnect' })
    const ev2 = await afterReconnect
    assert.equal(ev2.task.subject, 'after-reconnect')
    assert.equal(ev2.task.hiveId, hiveId)

    // 重连后 REST 照常可用。
    listed = await client.hive.list()
    assert.ok(listed.some((h: { id: string }) => h.id === hiveId))

    // 断线/重连后订阅集合仍被缓存，第二次 forced-kill 后再重连补订也成立。
    const s2 = [...server.ws.wss.clients][0]
    assert.ok(s2, 'server holds the reconnected client socket')
    s2.terminate()
    await waitFor(() => client.connected, 5_000)

    const third: Promise<any> = new Promise((resolve) => {
      client.on('task/created', resolve)
    })
    await client.task.create(hiveId, { subject: 'after-second-reconnect' })
    const ev3 = await third
    assert.equal(ev3.task.subject, 'after-second-reconnect')

    await client.close()
    assert.equal(client.connected, false)

    console.log('✅ real client × real server transport test passed on', httpUrl)
  } finally {
    await client.close().catch(() => {})
    await server.close()
  }
}

function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
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

test('transport client live HTTP+WS+reconnect', { timeout: 30_000 }, async () => {
  await main()
})
