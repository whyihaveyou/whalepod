/**
 * transport-client.test.ts
 *
 * 端到端验证 createHoneycombClient()：通过 fake fetch / fake WebSocket 桥接到
 * 内存传输（createMemoryTransport），覆盖：
 *
 *   1. REST 方法映射 + {ok,data} 信封解包 + JSON query 参数单次编码
 *   2. 错误解包 → HoneycombTransportError（code/status）+ 网络层错误
 *   3. WS connect / subscribe / on(event) / unsubscribe / close
 *   4. 断线自动重连（指数退避）+ 缓存订阅自动补订
 *
 * 运行：npx tsx --test test/transport-client.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context, apply } from '../src/index'
import type { MemberRuntime, RuntimeHandle } from '../src/index'
import {
  createMemoryTransport,
  MemoryWsConn,
  createHoneycombClient,
  HoneycombTransportError,
} from '../src/transport'
import type { MemoryTransportHandle, WsMessage, WsClientMessage } from '../src/transport'

const HTTP_URL = 'http://127.0.0.1:8787'
const WS_URL = 'ws://127.0.0.1:8787/ws'

const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await tick(5)
  }
}

function fakeRuntime(): MemberRuntime {
  return {
    id: 'native',
    async hatch(): Promise<RuntimeHandle> {
      const sessionId = `fake-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
      return {
        sessionId,
        async send() {},
        async *events() {},
        async close() {},
        async kill() {},
      }
    },
  }
}

// ---- fake WS 实例对外可观测面 ----
interface FakeWsInstance {
  url: string
  sent: string[]
  opened: Promise<void>
  /** 服务端回帧延迟（ms），用于验证"补订 ack 未到不算就绪"。 */
  ackDelayMs: number
  forceClose(): void
}

type FakeWsCtor = (new (url: string) => FakeWsInstance) & { instances: FakeWsInstance[] }

interface Fixture {
  client: ReturnType<typeof createHoneycombClient>
  lastUrl: { current: string | null }
  fakeWs: FakeWsCtor
  dispose(): Promise<void>
}

async function setup(options?: { reconnect?: { baseMs: number; maxMs: number } }): Promise<Fixture> {
  const ctx = new Context()
  const pDir = join(tmpdir(), `dfh-client-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await apply(ctx, { persistenceDir: pDir })
  ctx.roster.registerRuntime(fakeRuntime())
  const t: MemoryTransportHandle = createMemoryTransport(ctx)

  const lastUrl = { current: null as string | null }

  // fetch → t.http.dispatch：解析 URL（path + query）、读取 JSON body，返回信封。
  const fakeFetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    lastUrl.current = url
    const method = ((init?.method as string) ?? 'GET').toUpperCase()
    const u = new URL(url)
    const query: Record<string, string> = {}
    u.searchParams.forEach((value, key) => {
      query[key] = value
    })
    const body = init?.body != null ? JSON.parse(String(init.body)) : undefined
    const res = await t.http.dispatch(method as any, u.pathname, query, body)
    return { status: res.status, json: async () => res.body } as unknown as Response
  }) as typeof globalThis.fetch

  // WebSocket → MemoryWsConn：客户端出站帧经 t.ws.onClientMessage 交给 SubscribeCenter；
  // 服务端回帧（ack / event）延迟一拍投递，模拟真实网络往返（避免同步 ack 竞态）。
  class ClientBridgeConn extends MemoryWsConn {
    onFrame: (msg: WsMessage) => void = () => {}
    override send(msg: WsMessage): void {
      super.send(msg)
      this.onFrame(msg)
    }
  }

  class FakeWebSocket {
    static instances: FakeWebSocket[] = []

    readyState = 0 // CONNECTING
    onopen: (() => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    sent: string[] = []
    opened: Promise<void>
    ackDelayMs = 0
    private resolveOpened!: () => void
    readonly conn: ClientBridgeConn

    constructor(readonly url: string) {
      this.conn = new ClientBridgeConn()
      this.conn.onFrame = (frame) => {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), this.ackDelayMs)
      }
      t.ws.on(this.conn)
      FakeWebSocket.instances.push(this)
      this.opened = new Promise<void>((resolve) => {
        this.resolveOpened = resolve
      })
      setTimeout(() => this.open(), 0)
    }

    private open(): void {
      this.readyState = 1 // OPEN
      this.onopen?.()
      this.resolveOpened()
    }

    send(data: string): void {
      this.sent.push(data)
      t.ws.onClientMessage(this.conn, JSON.parse(data) as WsClientMessage)
    }

    close(): void {
      this.readyState = 3 // CLOSED
    }

    /** 仅测试用：模拟服务端断开该 socket（注销 + 触发 onclose）。 */
    forceClose(): void {
      this.readyState = 3
      t.ws.off(this.conn.id)
      this.onclose?.()
    }
  }

  const client = createHoneycombClient({
    httpUrl: HTTP_URL,
    wsUrl: WS_URL,
    fetch: fakeFetch,
    WebSocket: FakeWebSocket as unknown as typeof globalThis.WebSocket,
    reconnect: options?.reconnect ?? { baseMs: 500, maxMs: 30_000 },
    ackTimeoutMs: 2_000,
  })

  return {
    client,
    lastUrl,
    fakeWs: FakeWebSocket as unknown as FakeWsCtor,
    dispose: async () => t.dispose(),
  }
}

const frames = (ws: FakeWsInstance): Array<Record<string, any>> => ws.sent.map((s) => JSON.parse(s))

// ---------------------------------------------------------------------------
// 1. REST：方法映射 + 信封解包 + JSON query 单次编码
// ---------------------------------------------------------------------------
test('REST: 方法映射 + 信封解包 + JSON query 单次编码', async () => {
  const fx = await setup()
  try {
    const c = fx.client

    // -- hive --
    const hive = await c.hive.create({ name: 'A', workspace: '/tmp/a' })
    assert.ok(hive.id)
    assert.equal((await c.hive.get(hive.id)).id, hive.id)
    assert.ok((await c.hive.list()).some((h) => h.id === hive.id))
    assert.equal(await c.hive.rename(hive.id, 'B'), true)
    assert.equal((await c.hive.get(hive.id)).name, 'B')
    assert.equal(await c.hive.setMode(hive.id, 'isolated'), true)
    assert.equal(await c.hive.setSessionMode(hive.id, 'single'), true)

    // -- member --
    const worker = await c.member.hatch(hive.id, { name: 'w1', backend: 'native' })
    assert.equal(worker.status, 'idle')
    const members = await c.member.list(hive.id)
    assert.equal(members.length, 2)
    const queen = members.find((m) => m.role === 'queen')
    assert.ok(queen, '孵化 hive 应自带 queen')
    assert.equal((await c.member.get(hive.id, worker.id)).id, worker.id)
    assert.equal((await c.member.state(hive.id, worker.id)).memberId, worker.id)
    const registered = await c.member.register(hive.id, { name: 'w2', backend: 'native' })
    assert.equal(registered.status, 'idle')
    assert.equal(await c.member.rename(hive.id, worker.id, 'w1-renamed'), true)

    // -- task --
    const blocker = await c.task.create(hive.id, { subject: 'blocker' })
    const dependent = await c.task.create(hive.id, { subject: 'dependent', blockedBy: [blocker.id] })
    assert.deepEqual(dependent.blockedBy, [blocker.id])
    assert.equal((await c.task.get(hive.id, blocker.id)).id, blocker.id)
    // filter 是 JSON query：客户端单次编码（URLSearchParams 一次编码，服务端一次解码）
    await c.task.list(hive.id, { runnable: true })
    assert.equal(new URL(fx.lastUrl.current!).searchParams.get('filter'), JSON.stringify({ runnable: true }))
    assert.ok((await c.task.list(hive.id, { runnable: true })).some((x) => x.id === blocker.id))
    assert.ok(!(await c.task.list(hive.id, { runnable: true })).some((x) => x.id === dependent.id))
    const updated = await c.task.update(hive.id, blocker.id, { status: 'completed' })
    assert.equal(updated.status, 'completed')
    assert.equal(await c.task.setOwner(hive.id, blocker.id, queen.id), true)
    assert.equal(await c.task.addDependency(hive.id, dependent.id, [blocker.id]), true)
    assert.equal(await c.task.removeDependency(hive.id, dependent.id, [blocker.id]), true)

    // -- message --
    const msg = await c.message.send(hive.id, { from: queen.id, to: worker.id, kind: 'directive', content: 'do it' })
    assert.ok(msg.id)
    assert.ok((await c.message.inbox(hive.id, worker.id)).some((m) => m.id === msg.id))
    assert.equal(await c.message.markRead(hive.id, msg.id), true)
    const deliveredId = await c.message.deliver(hive.id, { from: 'user', to: worker.id, kind: 'note', content: 'hi' })
    assert.ok(deliveredId)
    assert.equal(await c.message.broadcast(hive.id, 'system', 'all hands'), undefined)
    const feed = await c.message.feed(hive.id, undefined, 10)
    assert.ok(Array.isArray(feed.items))

    // -- mandate --
    assert.equal(await c.mandate.can(worker.id, 'ledger.create'), false)
    assert.ok(Array.isArray(await c.mandate.grants(worker.id)))

    // -- 收尾（变更类方法） --
    assert.equal(await c.member.dismiss(hive.id, worker.id), true)
    assert.equal(await c.member.remove(hive.id, registered.id), true)
    assert.equal(await c.hive.remove(hive.id), true)
  } finally {
    await fx.dispose()
  }
})

// ---------------------------------------------------------------------------
// 2. REST：错误解包（code/status）+ 网络层错误
// ---------------------------------------------------------------------------
test('REST: 错误解包为 HoneycombTransportError（code/status）', async () => {
  const fx = await setup()
  try {
    const c = fx.client

    await assert.rejects(c.hive.get('hive_nope'), (err) => {
      assert.ok(err instanceof HoneycombTransportError)
      assert.equal((err as HoneycombTransportError).code, 'NOT_FOUND')
      assert.equal((err as HoneycombTransportError).status, 404)
      return true
    })

    const hive = await c.hive.create({ name: 'A', workspace: '/tmp/a' })
    const worker = await c.member.hatch(hive.id, { name: 'w1', backend: 'native' })

    await assert.rejects(c.mandate.assert(worker.id, 'ledger.create'), (err) => {
      const e = err as HoneycombTransportError
      assert.equal(e.code, 'FORBIDDEN')
      assert.equal(e.status, 403)
      return true
    })

    await assert.rejects(c.task.create(hive.id, {} as never), (err) => {
      const e = err as HoneycombTransportError
      assert.equal(e.code, 'BAD_REQUEST')
      return true
    })
  } finally {
    await fx.dispose()
  }
})

test('REST: 网络层失败 → NETWORK_ERROR', async () => {
  const client = createHoneycombClient({
    httpUrl: HTTP_URL,
    wsUrl: WS_URL,
    fetch: (async () => {
      throw new Error('boom')
    }) as unknown as typeof globalThis.fetch,
  })
  await assert.rejects(client.hive.list(), (err) => {
    assert.ok(err instanceof HoneycombTransportError)
    assert.equal((err as HoneycombTransportError).code, 'NETWORK_ERROR')
    return true
  })
})

// ---------------------------------------------------------------------------
// 3. WS：connect / subscribe / on(event) / unsubscribe / close
// ---------------------------------------------------------------------------
test('WS: connect/subscribe/on/事件推送/unsubscribe/close', async () => {
  const fx = await setup()
  try {
    const c = fx.client
    const hive = await c.hive.create({ name: 'A', workspace: '/tmp/a' })
    const queen = (await c.member.list(hive.id)).find((m) => m.role === 'queen')!
    const worker = await c.member.hatch(hive.id, { name: 'w1', backend: 'native' })

    const received: any[] = []
    c.on('message/created', (p) => received.push(p))

    assert.equal(c.connected, false)
    await c.connect()
    assert.equal(c.connected, true)
    assert.equal(fx.fakeWs.instances.length, 1)
    const ws0 = fx.fakeWs.instances[0]
    assert.ok(frames(ws0).some((f) => f.type === 'hello'), 'connect() 应发送 hello 帧')

    await c.subscribe(hive.id)
    assert.ok(
      frames(ws0).some((f) => f.type === 'subscribe' && f.hiveId === hive.id),
      'subscribe() 应发送 subscribe 帧且收到 ack',
    )

    // 服务端事件经 WS 推送 → 客户端 handler 收到 payload
    await c.message.send(hive.id, { from: queen.id, to: worker.id, kind: 'note', content: 'ping' })
    await waitFor(() => received.length >= 1)
    assert.equal(received[0].message.hiveId, hive.id)

    await c.unsubscribe(hive.id)
    assert.ok(frames(ws0).some((f) => f.type === 'unsubscribe' && f.hiveId === hive.id))

    // 取消订阅后不再收到推送
    const before = received.length
    await c.message.send(hive.id, { from: queen.id, to: worker.id, kind: 'note', content: 'ignored' })
    await tick(30)
    assert.equal(received.length, before, '取消订阅后不应再收到事件推送')

    await c.close()
    assert.equal(c.connected, false)
  } finally {
    await fx.dispose()
  }
})

// ---------------------------------------------------------------------------
// 4. WS：断线自动重连（退避）+ 缓存订阅补订
// ---------------------------------------------------------------------------
test('WS: 断线自动重连（指数退避）+ 缓存订阅补订', async () => {
  const fx = await setup({ reconnect: { baseMs: 20, maxMs: 200 } })
  try {
    const c = fx.client
    const hive = await c.hive.create({ name: 'A', workspace: '/tmp/a' })
    const queen = (await c.member.list(hive.id)).find((m) => m.role === 'queen')!
    const worker = await c.member.hatch(hive.id, { name: 'w1', backend: 'native' })

    const received: any[] = []
    c.on('message/created', (p) => received.push(p))

    await c.connect()
    await c.subscribe(hive.id)
    const ws0 = fx.fakeWs.instances[0]

    // 服务端强制断开 → 客户端进入重连（退避 20ms）
    ws0.forceClose()
    assert.equal(c.connected, false)

    await waitFor(() => fx.fakeWs.instances.length >= 2 && c.connected)
    const ws1 = fx.fakeWs.instances[1]
    await ws1.opened
    const frames1 = frames(ws1)
    assert.ok(frames1.some((f) => f.type === 'hello'), '重连后应重新发送 hello 帧')
    assert.ok(
      frames1.some((f) => f.type === 'subscribe' && f.hiveId === hive.id),
      '重连后应补订缓存的 hive 订阅',
    )

    // 新连接上仍能收到事件推送
    await c.message.send(hive.id, { from: queen.id, to: worker.id, kind: 'note', content: 're-ping' })
    await waitFor(() => received.length >= 1)
    assert.equal(received[received.length - 1].message.hiveId, hive.id)

    await c.close()
    assert.equal(c.connected, false)
    assert.equal(fx.fakeWs.instances.length, 2, 'close() 后不应再触发重连')
  } finally {
    await fx.dispose()
  }
})

// ---------------------------------------------------------------------------
// 5. WS：连接失败时 connect() 必须 reject（HIGH-2，不无限挂起）
// ---------------------------------------------------------------------------
test('WS: connect() 失败时 reject WS_UNAVAILABLE（不无限挂起）', async () => {
  // 模拟"服务端不可达"：socket 构造后立即关闭且从未 open
  class RefusingWs {
    readyState = 0 // CONNECTING
    onopen: (() => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    constructor(_url: string) {
      setTimeout(() => {
        this.readyState = 3
        this.onclose?.()
      }, 10)
    }
    send(_data: string): void {}
    close(): void {
      this.readyState = 3
    }
  }

  const client = createHoneycombClient({
    httpUrl: HTTP_URL,
    wsUrl: WS_URL,
    fetch: (async () => {
      throw new Error('never')
    }) as unknown as typeof globalThis.fetch,
    WebSocket: RefusingWs as unknown as typeof globalThis.WebSocket,
    reconnect: { baseMs: 10_000, maxMs: 30_000 }, // 拉长退避，测试期内不会重连干扰
  })

  await assert.rejects(client.connect(), (err) => {
    assert.ok(err instanceof HoneycombTransportError)
    assert.equal((err as HoneycombTransportError).code, 'WS_UNAVAILABLE')
    return true
  })

  await client.close() // 清掉后台退避定时器，避免测试进程挂起
})

// ---------------------------------------------------------------------------
// 6. WS：重连补订等 ack 后才就绪（HIGH-1/MED-5）
// ---------------------------------------------------------------------------
test('WS: 重连补订等 ack 后才置就绪（HIGH-1/MED-5）', async () => {
  const fx = await setup({ reconnect: { baseMs: 20, maxMs: 200 } })
  try {
    const c = fx.client
    const hive = await c.hive.create({ name: 'A', workspace: '/tmp/a' })
    await c.connect()
    await c.subscribe(hive.id)
    const ws0 = fx.fakeWs.instances[0]

    // 强制断开 → 重连
    ws0.forceClose()
    await waitFor(() => fx.fakeWs.instances.length >= 2)
    const ws1 = fx.fakeWs.instances[1]
    // 拉长新连接的服务端回帧延迟：在 ack 到达前，客户端不应被视为就绪
    ws1.ackDelayMs = 60
    await ws1.opened

    // 补订帧已发出但 ack 未到 → connected 仍为 false（就绪=open+补订 ack 完成）
    assert.equal(c.connected, false, '补订 ack 未到不应视为就绪')
    await waitFor(() => c.connected)
    assert.ok(
      frames(ws1).some((f) => f.type === 'subscribe' && f.hiveId === hive.id),
      '重连补订帧应已发出',
    )

    await c.close()
  } finally {
    await fx.dispose()
  }
})
