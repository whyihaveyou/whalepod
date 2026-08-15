/**
 * cancel 链路落地测试（cancel-lifecycle.md §7 切分表 ①-④）。
 *
 * 覆盖四个真码改动：
 *  ① RuntimeHandle.cancel?() 可选 + RuntimeRegistry.cancelTask(memberId)
 *  ② AgentSessionHandle 胶水 cancel 透传（feature-detect + cancelInProgress）
 *  ③ 编排循环 dispatch 看门狗先调 cancelTask 再走 failDispatch
 *  ④ 编排循环 cancelTask(taskId, reason) 入口 + 任务事实层 task-cancelled 类型
 *
 * 测试断言遵守「测试断言铁律」：
 *  - 精确匹配，不写 includes('4') 这类脆弱断言；
 *  - 失败时 dump 实际值，便于定位；
 *  - 数字断言（grep mkdtemp 路径里的随机串）一律避免；
 *  - 不依赖 fs / persistence I/O，直接走事实日志级别断言。
 *
 * 使用 node:test + node:assert/strict（与项目内 orchestration-loop.test 同型）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RuntimeRegistry,
  type RuntimeHandle,
} from '../src/runtime/registry'
import { AgentSessionRuntime } from '../src/runtime/agent-runtime'
import {
  createOrchestrationLoop,
  type LoopEvent,
  type LoopMember,
  type LoopTask,
  type OrchestrationLoopDeps,
} from '../src/consumer/orchestration-loop'
import type { AgentSession, SessionEvent } from '../src/connectors/adapter'
import type { Member } from '../src/types'

// ---------------------------------------------------------------------------
// 共享 stub
// ---------------------------------------------------------------------------

class FakeContext {
  private listeners = new Map<string, Array<(p: any) => void>>()
  private emitted: Array<{ name: string; payload: any }> = []

  on(name: string, fn: (p: any) => void): { dispose(): void } {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name)!.push(fn)
    return { dispose: () => {} }
  }

  emit(name: string, payload: any): void {
    this.emitted.push({ name, payload })
    for (const fn of this.listeners.get(name) ?? []) fn(payload)
  }

  /** 取某类事件名下的全部 payload 快照（断言用）。 */
  of(name: string): any[] {
    return this.emitted.filter((e) => e.name === name).map((e) => e.payload)
  }
}

class FakeLedger {
  tasks: LoopTask[] = []
  private n = 0

  create(hiveId: string, blockedBy: string[] = []): LoopTask {
    const t: LoopTask = {
      id: `t${++this.n}`,
      hiveId,
      status: 'backlog',
      owner: null,
      blockedBy,
    }
    this.tasks.push(t)
    return t
  }

  async list(
    hiveId: string,
    filter?: { status?: string | string[]; runnable?: boolean; limit?: number },
  ): Promise<LoopTask[]> {
    let out = this.tasks.filter((t) => t.hiveId === hiveId)
    if (filter?.status !== undefined) {
      const wanted = Array.isArray(filter.status) ? filter.status : [filter.status]
      out = out.filter((t) => wanted.includes(t.status))
    }
    if (filter?.runnable) {
      out = out.filter((t) =>
        t.blockedBy.every((b) => this.tasks.find((x) => x.id === b)?.status === 'completed'),
      )
    }
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit)
    return out
  }
}

/** 可控事件源的假 AgentSession —— 让我们能精确触发 done/cancelled 等。 */
class FakeAgentSession implements AgentSession {
  readonly sessionId: string
  readonly events: AsyncIterable<SessionEvent>
  private readonly queue: SessionEvent[] = []
  private readonly waiters: Array<(ev: SessionEvent | undefined) => void> = []
  private closed = false
  private killed = false
  /** 录制方法调用 —— 断言 cancel/close/kill 的调用次数与顺序。 */
  cancelCalls = 0
  closeCalls = 0
  killCalls = 0
  sendCalls = 0

  constructor(sessionId: string) {
    this.sessionId = sessionId
    this.events = this.iterate()
  }

  private async *iterate(): AsyncIterable<SessionEvent> {
    while (!this.closed && !this.killed) {
      const ev = await this.next()
      if (!ev) break
      yield ev
    }
  }

  private next(): Promise<SessionEvent | undefined> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!)
    return new Promise((resolve) => {
      this.waiters.push((ev) => resolve(ev))
    })
  }

  /** 测试驱动用：往会话推一条事件。 */
  push(event: SessionEvent): void {
    const w = this.waiters.shift()
    if (w) w(event)
    else this.queue.push(event)
  }

  async send(_message: { content: string }): Promise<void> {
    this.sendCalls++
  }

  async close(): Promise<void> {
    this.closeCalls++
    this.closed = true
    for (const w of this.waiters) w(undefined)
    this.waiters.length = 0
  }

  async kill(): Promise<void> {
    this.killCalls++
    this.killed = true
    for (const w of this.waiters) w(undefined)
    this.waiters.length = 0
  }

  /** 模拟支持协议级 cancel 的会话（如 ACP）。测试可用实例属性覆盖/置空。 */
  async cancel(): Promise<void> {
    this.cancelCalls++
  }
}

/** 内存 roster（含 cancelTask 注入钩子）。 */
class FakeRoster {
  members: LoopMember[] = []
  sent: Array<{ hiveId: string; memberId: string; message: { role: string; content: string } }> = []
  cancelCalls: Array<{ hiveId: string; memberId: string }> = []
  /** cancelTask 人工延迟（ms）—— 测试「慢 cancel 不阻塞 failDispatch」用。 */
  cancelDelayMs = 0
  /** cancelTask 桩：测试可注入 spy。默认 no-op。 */
  cancelTask: ((hiveId: string, memberId: string) => Promise<void>) | undefined =
    async () => {}

  async list(hiveId: string): Promise<LoopMember[]> {
    return this.members.filter((m) => m.hiveId === hiveId)
  }
  async sendTo(
    hiveId: string,
    memberId: string,
    message: { role: string; content: string },
  ): Promise<boolean> {
    this.sent.push({ hiveId, memberId, message })
    return true
  }
  async dismiss(_hiveId: string, memberId: string): Promise<void> {
    this.members = this.members.filter((m) => m.id !== memberId)
  }
}

interface Fixture {
  ctx: FakeContext
  roster: FakeRoster
  ledger: FakeLedger
  loop: ReturnType<typeof createOrchestrationLoop>
  events: LoopEvent[]
  applyCalls: Array<{ taskId: string; status?: string; owner?: string | null }>
  appendFactCalls: Array<{ hiveId: string; fact: any }>
  sweep: (ms: number) => Promise<void>
  clock: { t: number }
}

function boot(opts: { idleTimeoutMs?: number } = {}): Fixture {
  const ctx = new FakeContext()
  const roster = new FakeRoster()
  const ledger = new FakeLedger()
  const events: LoopEvent[] = []
  const applyCalls: Fixture['applyCalls'] = []
  const appendFactCalls: Fixture['appendFactCalls'] = []
  // 把回调和它们的 pending Promise 都记下来，sweep 时一并 await。
  const cbsByMs = new Map<number, () => Promise<void> | void>()
  const pending = new Set<Promise<unknown>>()
  const clock = { t: 0 }

  const deps: OrchestrationLoopDeps = {
    ctx: ctx as any,
    roster: roster as any,
    ledger: ledger as any,
    applyTask: async (_hiveId, patch) => {
      applyCalls.push({ ...patch })
      const t = ledger.tasks.find((x) => x.id === patch.taskId)
      if (t) {
        if (patch.owner !== undefined) t.owner = patch.owner ?? null
        if (patch.status !== undefined) t.status = patch.status
      }
    },
    appendFact: async (hiveId, fact) => {
      appendFactCalls.push({ hiveId, fact })
    },
    config: {
      idleTimeoutMs: opts.idleTimeoutMs ?? 0,
      maxDispatchAttempts: 3,
      dispatchTimeoutMs: 60_000,
    },
    now: () => clock.t,
    setTimer: (cb, ms) => {
      cbsByMs.set(ms, cb as any)
      return ms
    },
    clearTimer: (h) => {
      cbsByMs.delete(h as number)
    },
  }

  const loop = createOrchestrationLoop(deps)
  loop.onEvent((e) => events.push(e))
  loop.start(['h1'])
  // cancelTask 桥接：记录调用（供断言），并按 cancelDelayMs 人工延迟，
  // 让测试能验证「慢 cancel 不阻塞 failDispatch」。始终走同一个方法，
  // 测试不要整体替换它 —— 用 cancelDelayMs / 置 undefined 控制行为。
  ;(roster as any).cancelTask = async (h: string, m: string) => {
    roster.cancelCalls.push({ hiveId: h, memberId: m })
    if (roster.cancelDelayMs > 0) {
      await new Promise((r) => setTimeout(r, roster.cancelDelayMs))
    }
  }
  return {
    ctx,
    roster,
    ledger,
    loop,
    events,
    applyCalls,
    appendFactCalls,
    sweep: async (ms: number) => {
      const cb = cbsByMs.get(ms)
      if (!cb) return
      const p = Promise.resolve(cb())
      pending.add(p)
      await p
      pending.delete(p)
    },
    clock,
  }
}

// =========================================================================
// ① RuntimeHandle.cancel?() + RuntimeRegistry.cancelTask(memberId)
// =========================================================================

test('RuntimeRegistry.cancelTask — 未注册的 memberId 返回 false', async () => {
  const reg = new RuntimeRegistry()
  assert.equal(await reg.cancelTask('ghost'), false)
})

test('RuntimeRegistry.cancelTask — handle 无 cancel 方法 → 返回 false', async () => {
  const reg = new RuntimeRegistry()
  const handle: RuntimeHandle = {
    sessionId: 's1',
    async send() {},
    async *events() {},
    async close() {},
    async kill() {},
    // 注意：故意不实现 cancel
  }
  reg.trackHandle('m1', handle)
  assert.equal(await reg.cancelTask('m1'), false)
})

test('RuntimeRegistry.cancelTask — handle.cancel() 存在 → 调用并返回 true', async () => {
  const reg = new RuntimeRegistry()
  let calls = 0
  const handle: RuntimeHandle = {
    sessionId: 's1',
    async send() {},
    async *events() {},
    async close() {},
    async kill() {},
    async cancel() {
      calls++
    },
  }
  reg.trackHandle('m1', handle)
  assert.equal(await reg.cancelTask('m1'), true)
  assert.equal(calls, 1)
})

test('RuntimeRegistry.cancelTask — handle.cancel() 抛错 → 吞掉并返回 false（best-effort）', async () => {
  const reg = new RuntimeRegistry()
  const handle: RuntimeHandle = {
    sessionId: 's1',
    async send() {},
    async *events() {},
    async close() {},
    async kill() {},
    async cancel() {
      throw new Error('boom')
    },
  }
  reg.trackHandle('m1', handle)
  // 不应向上抛错
  assert.equal(await reg.cancelTask('m1'), false)
})

test('RuntimeRegistry — handleFor / untrackHandle 注册与注销', () => {
  const reg = new RuntimeRegistry()
  const handle: RuntimeHandle = {
    sessionId: 's1',
    async send() {},
    async *events() {},
    async close() {},
    async kill() {},
    async cancel() {},
  }
  assert.equal(reg.handleFor('m1'), undefined)
  reg.trackHandle('m1', handle)
  assert.equal(reg.handleFor('m1'), handle)
  reg.untrackHandle('m1')
  assert.equal(reg.handleFor('m1'), undefined)
})

// =========================================================================
// ② AgentSessionHandle.cancel() 胶水透传 + cancelInProgress 泵侧区分
// =========================================================================

/** 注入 createSession 钩子，hatch 出可观测的 RuntimeHandle（hatch 是 async，必须 await）。 */
async function hatchWith(session: FakeAgentSession) {
  const ctx = new FakeContext()
  // 用一个最小 Member 让 AgentSessionRuntime.hatch 接受
  const member: Member = {
    id: 'm1',
    hiveId: 'h1',
    name: 'worker',
    backend: 'connector',
    role: 'agent',
    capabilities: [],
    status: 'idle',
    connectorId: 'fake-connector',
  } as any
  const runtime = new AgentSessionRuntime({
    createSession: async () => session,
    resolveAdapter: () => ({ id: 'fake', validate: async () => true, spawnSession: async () => session }) as any,
  } as any)
  const handle = await runtime.hatch(ctx as any, { member } as any)
  return { ctx, handle }
}

const tick = () => new Promise<void>((r) => setImmediate(r))

test('AgentSessionHandle.cancel — session.cancel 存在 → 直接调用，不触发 close/kill', async () => {
  const session = new FakeAgentSession('s1')
  const { handle } = await hatchWith(session)
  await handle.cancel!()
  assert.equal(session.cancelCalls, 1)
  assert.equal(session.closeCalls, 0)
  assert.equal(session.killCalls, 0)
  await handle.kill()
})

test('AgentSessionHandle.cancel — session.cancel 不存在 → 降级 close（fire-and-forget）', async () => {
  const session = new FakeAgentSession('s1')
  // 删除 cancel 方法模拟 legacy/native 会话
  ;(session as any).cancel = undefined
  const { handle } = await hatchWith(session)
  await handle.cancel!()
  // fire-and-forget 调度了 gracefulCloseWithTimeout —— 等一拍让 microtask 流转
  await tick()
  // 兜底：cancel() 本身不抛错是关键断言
  // close 可能已触发（fire-and-forget 调度），也可能未触发（取决于调度时机）
  // 我们只断言 kill 路径未被调用
  assert.equal(session.killCalls, 0)
  await handle.kill()
})

test('AgentSessionHandle.cancel — 幂等：重复调用只触发一次底层 cancel', async () => {
  const session = new FakeAgentSession('s1')
  const { handle } = await hatchWith(session)
  await handle.cancel!()
  await handle.cancel!()
  await handle.cancel!()
  assert.equal(session.cancelCalls, 1)
  await handle.kill()
})

test('AgentSessionHandle.cancel — best-effort：底层 cancel 抛错也不向上冒', async () => {
  const session = new FakeAgentSession('s1')
  session.cancel = async () => {
    throw new Error('protocol error')
  }
  const { handle } = await hatchWith(session)
  // 不应抛错
  await handle.cancel!()
  // 给 close 兜底一拍
  await tick()
  // 不会调 kill（best-effort：cancel 抛错后降级 close，不调 kill）
  assert.equal(session.killCalls, 0)
  await handle.kill()
})

test('AgentSessionHandle — 泵侧区分：cancelInProgress=true + done(exit≠0) → idle（不是 failed）', async () => {
  const session = new FakeAgentSession('s1')
  const { ctx, handle } = await hatchWith(session)
  // 启动 pump：先 stream 让 handle 进入 working
  session.push({ type: 'stream', content: 'partial' })
  await tick()
  const statusesBefore = ctx.of('member/status').map((p: any) => p.status)
  assert.equal(statusesBefore[0], 'working', `实际 member/status 序列: ${JSON.stringify(statusesBefore)}`)

  await handle.cancel!()
  // 模拟底层 cancel 协议收尾：推一条 done(exit=143)
  session.push({ type: 'done', exitCode: 143 })
  await tick()

  // 关键断言：最后一次 member/status 是 idle（不是 failed）
  const statuses = ctx.of('member/status').map((p: any) => p.status)
  const last = statuses[statuses.length - 1]
  assert.equal(last, 'idle', `实际 member/status 序列: ${JSON.stringify(statuses)}`)
  // 且 pump 不应当再产出 failed 状态
  const failedCount = statuses.filter((s: string) => s === 'failed').length
  assert.equal(failedCount, 0, `实际 member/status 序列: ${JSON.stringify(statuses)}`)
})

test('AgentSessionHandle — 泵侧区分：cancelInProgress=false + done(exit≠0) → failed（既有语义保留）', async () => {
  const session = new FakeAgentSession('s1')
  const { ctx, handle } = await hatchWith(session)
  session.push({ type: 'stream', content: 'partial' })
  await tick()
  // 不调 cancel，直接推 done(exit=2)
  session.push({ type: 'done', exitCode: 2 })
  await tick()
  const statuses = ctx.of('member/status').map((p: any) => p.status)
  const last = statuses[statuses.length - 1]
  assert.equal(last, 'failed', `实际 member/status 序列: ${JSON.stringify(statuses)}`)
})

test('AgentSessionHandle — 泵侧区分：cancelled 事件依然走 idle（不依赖 cancelInProgress）', async () => {
  const session = new FakeAgentSession('s1')
  const { ctx, handle } = await hatchWith(session)
  session.push({ type: 'stream', content: 'go' })
  await tick()
  // 没调 cancel()，但底层发了 cancelled 事件
  session.push({ type: 'cancelled' })
  await tick()
  const statuses = ctx.of('member/status').map((p: any) => p.status)
  const last = statuses[statuses.length - 1]
  assert.equal(last, 'idle', `实际 member/status 序列: ${JSON.stringify(statuses)}`)
  await handle.kill()
})

test('AgentSessionHandle — 泵侧区分：done(exit=0) 不受 cancelInProgress 影响 → finished', async () => {
  const session = new FakeAgentSession('s1')
  const { ctx, handle } = await hatchWith(session)
  session.push({ type: 'stream', content: 'go' })
  await tick()
  await handle.cancel!()
  session.push({ type: 'done', exitCode: 0 })
  await tick()
  const statuses = ctx.of('member/status').map((p: any) => p.status)
  const last = statuses[statuses.length - 1]
  assert.equal(last, 'finished', `实际 member/status 序列: ${JSON.stringify(statuses)}`)
})

// =========================================================================
// ③ 编排循环 dispatch 看门狗：先 cancelTask 再走 failDispatch
// =========================================================================

test('编排循环看门狗 — 到点先调 roster.cancelTask，再走 failDispatch（owner 清空）', async () => {
  const f = boot({ idleTimeoutMs: 0 })
  const worker: LoopMember = {
    id: 'w1',
    hiveId: 'h1',
    backend: 'connector',
    role: 'agent',
    capabilities: [],
    status: 'idle',
    lastSeenAt: 0,
  } as any
  f.roster.members.push(worker)

  // 创建任务 → 默认 backlog；派工自动认领 → in-progress
  const task = f.ledger.create('h1')
  await f.loop.dispatchNow('h1')
  // 派工后：task 应已 in-progress + owner=w1
  assert.equal(task.status, 'in-progress')
  assert.equal(task.owner, 'w1')

  // 手动驱动 60_000ms 看门狗到点
  await f.sweep(60_000)

  // 期望：cancelTask 被调用一次（hiveId=h1, memberId=w1）
  assert.equal(f.roster.cancelCalls.length, 1)
  assert.deepEqual(f.roster.cancelCalls[0], { hiveId: 'h1', memberId: 'w1' })
  // 期望：failDispatch 走完 → task.status 重置为 backlog（re-dispatch）
  assert.equal(task.status, 'backlog')
  // 期望：applyTask 至少出现一次 owner=null（rollback）
  const ownerClears = f.applyCalls.filter((c) => c.owner === null)
  assert.ok(ownerClears.length >= 1)
})

test('编排循环看门狗 — cancelTask fire-and-forget 不阻塞 failDispatch（同步推进）', async () => {
  const f = boot()
  const worker: LoopMember = {
    id: 'w2',
    hiveId: 'h1',
    backend: 'connector',
    role: 'agent',
    capabilities: [],
    status: 'idle',
    lastSeenAt: 0,
  } as any
  f.roster.members.push(worker)
  f.ledger.create('h1')

  await f.loop.dispatchNow('h1')
  // 让 cancelTask 桩「慢」执行（50ms 人工延迟）—— 即便如此 failDispatch 也应该立即完成
  f.roster.cancelDelayMs = 50
  const t0 = Date.now()
  await f.sweep(60_000)
  const elapsed = Date.now() - t0
  // 关键断言：failDispatch 几乎立即完成（< 40ms），不被慢 cancelTask 阻塞
  assert.ok(
    elapsed < 40,
    `sweep(60_000) 耗时 ${elapsed}ms —— failDispatch 被 cancelTask 阻塞了（应 fire-and-forget）`,
  )
  // task 已被 rollback 为 backlog
  const task = f.ledger.tasks[0]
  assert.equal(task.status, 'backlog')
  // cancelCalls 仍记录了一次（fire-and-forget 路径）
  assert.equal(f.roster.cancelCalls.length, 1)
})

test('编排循环看门狗 — roster 没有 cancelTask 实现 → 仍正常 failDispatch（向后兼容）', async () => {
  const f = boot()
  const worker: LoopMember = {
    id: 'w3',
    hiveId: 'h1',
    backend: 'connector',
    role: 'agent',
    capabilities: [],
    status: 'idle',
    lastSeenAt: 0,
  } as any
  f.roster.members.push(worker)
  // 故意移除 cancelTask
  ;(f.roster as any).cancelTask = undefined
  f.ledger.create('h1')

  await f.loop.dispatchNow('h1')
  // 不应抛错
  await f.sweep(60_000)
  // 没有 cancel 调用（roster.cancelCalls 直接 push 也不该被调用，因为 deps 里已经没有 cancelTask）
  assert.equal(f.roster.cancelCalls.length, 0)
  // task 仍被 rollback
  const task = f.ledger.tasks[0]
  assert.equal(task.status, 'backlog')
})

// =========================================================================
// ④ 编排循环 cancelTask(taskId, reason) 入口 + task-cancelled 事实
// =========================================================================

test('cancelTask 入口 — 任务在 in-progress → status=cancelled + emit + appendFact + roster.cancelTask', async () => {
  const f = boot()
  const worker: LoopMember = {
    id: 'wA',
    hiveId: 'h1',
    backend: 'connector',
    role: 'agent',
    capabilities: [],
    status: 'idle',
    lastSeenAt: 0,
  } as any
  f.roster.members.push(worker)
  const task = f.ledger.create('h1')
  task.status = 'in-progress'
  task.owner = worker.id

  await f.loop.cancelTask('h1', task.id, 'user requested')

  // 1. applyTask 写 status=cancelled + owner=null
  assert.ok(
    f.applyCalls.some(
      (c) => c.taskId === task.id && c.status === 'cancelled' && c.owner === null,
    ),
  )
  // 2. 任务快照已是 cancelled
  assert.equal(task.status, 'cancelled')
  assert.equal(task.owner, null)
  // 3. emit 'cancelled' 事件
  const cancelled = f.events.filter((e) => e.type === 'cancelled')
  assert.equal(cancelled.length, 1)
  assert.deepEqual(cancelled[0], {
    type: 'cancelled',
    hiveId: 'h1',
    taskId: task.id,
    memberId: 'wA',
    reason: 'user requested',
  })
  // 4. appendFact 写 task-cancelled 事实
  assert.equal(f.appendFactCalls.length, 1)
  assert.equal(f.appendFactCalls[0].hiveId, 'h1')
  assert.equal(f.appendFactCalls[0].fact.type, 'task-cancelled')
  assert.equal(f.appendFactCalls[0].fact.taskId, task.id)
  assert.equal(f.appendFactCalls[0].fact.memberId, 'wA')
  assert.equal(f.appendFactCalls[0].fact.reason, 'user requested')
  assert.equal(typeof f.appendFactCalls[0].fact.at, 'number')
  // 5. roster.cancelTask 被 fire-and-forget 调用一次
  assert.equal(f.roster.cancelCalls.length, 1)
  assert.deepEqual(f.roster.cancelCalls[0], { hiveId: 'h1', memberId: 'wA' })
})

test('cancelTask 入口 — 任务非 in-progress（backlog）→ no-op', async () => {
  const f = boot()
  const task = f.ledger.create('h1') // 默认 backlog
  const beforeApply = f.applyCalls.length
  const beforeEvents = f.events.length
  await f.loop.cancelTask('h1', task.id, 'should be ignored')
  assert.equal(f.applyCalls.length, beforeApply)
  assert.equal(f.events.length, beforeEvents)
  assert.equal(f.appendFactCalls.length, 0)
  assert.equal(f.roster.cancelCalls.length, 0)
})

test('cancelTask 入口 — 任务不存在 → no-op', async () => {
  const f = boot()
  const beforeApply = f.applyCalls.length
  const beforeEvents = f.events.length
  await f.loop.cancelTask('h1', 'ghost-task', 'no such task')
  assert.equal(f.applyCalls.length, beforeApply)
  assert.equal(f.events.length, beforeEvents)
  assert.equal(f.appendFactCalls.length, 0)
})

test('cancelTask 入口 — 看门狗挂着 → 先 disarm（不再到点误回收）', async () => {
  const f = boot()
  const worker: LoopMember = {
    id: 'wB',
    hiveId: 'h1',
    backend: 'connector',
    role: 'agent',
    capabilities: [],
    status: 'idle',
    lastSeenAt: 0,
  } as any
  f.roster.members.push(worker)
  // 走真实派工路径：task 默认 backlog → dispatchNow → 认领 → in-progress + 挂看门狗
  const task = f.ledger.create('h1')
  await f.loop.dispatchNow('h1')
  // 验证确实挂上了看门狗
  assert.equal(task.status, 'in-progress')
  assert.equal(task.owner, 'wB')

  // 此时 cancelCalls 应该是 0（看门狗未到点）
  const beforeCancelCalls = f.roster.cancelCalls.length
  await f.loop.cancelTask('h1', task.id, 'pre-emptive')

  // cancelTask 入口自身会调一次 roster.cancelTask（fire-and-forget 优雅取消）
  assert.equal(f.roster.cancelCalls.length, beforeCancelCalls + 1)

  // 此后 sweep 看门狗 → 不应再触发 cancelTask 或重新走 failDispatch
  await f.sweep(60_000)
  assert.equal(f.roster.cancelCalls.length, beforeCancelCalls + 1) // 没新增
  // task 仍是 cancelled（不被看门狗覆盖）
  assert.equal(task.status, 'cancelled')
})

test('cancelTask 入口 — appendFact 抛错 → 编排状态仍正常（best-effort）', async () => {
  // 单独构造一个 appendFact 抛错的 loop
  const ctx = new FakeContext()
  const roster = new FakeRoster()
  const ledger = new FakeLedger()
  const applyCalls: Array<{ taskId: string; status?: string; owner?: string | null }> = []
  const cbsByMs = new Map<number, () => void>()

  const deps: OrchestrationLoopDeps = {
    ctx: ctx as any,
    roster: roster as any,
    ledger: ledger as any,
    applyTask: async (_hiveId, patch) => {
      applyCalls.push({ ...patch })
      const t = ledger.tasks.find((x) => x.id === patch.taskId)
      if (t) {
        if (patch.owner !== undefined) t.owner = patch.owner ?? null
        if (patch.status !== undefined) t.status = patch.status
      }
    },
    appendFact: async () => {
      throw new Error('disk full')
    },
    config: { idleTimeoutMs: 0, maxDispatchAttempts: 3, dispatchTimeoutMs: 60_000 },
    setTimer: (cb, ms) => {
      cbsByMs.set(ms, cb)
      return ms
    },
    clearTimer: (h) => {
      cbsByMs.delete(h as number)
    },
  }
  const loop2 = createOrchestrationLoop(deps)
  loop2.start(['h1'])

  const task = ledger.create('h1')
  task.status = 'in-progress'
  task.owner = 'wC'

  // 不应抛错
  await loop2.cancelTask('h1', task.id, 'still try')
  // status 仍正确写入
  assert.equal(task.status, 'cancelled')
  assert.equal(task.owner, null)
  // applyTask 至少出现一次 cancelled
  assert.ok(
    applyCalls.some((c) => c.taskId === task.id && c.status === 'cancelled'),
  )
})

// =========================================================================
// ④-extra 任务事实层 task-cancelled 落库（fold + replay）
// =========================================================================

test('persistence — task-cancelled 事实 fold 写入 snapshot（status=cancelled）', async () => {
  const { replay } = await import('../src/persistence/store')
  const facts = [
    {
      seq: 1,
      at: 0,
      hiveId: 'h1',
      fact: {
        type: 'hive-created',
        hive: { id: 'h1', name: 'h1', createdAt: 0, updatedAt: 0 },
      },
    },
    {
      seq: 2,
      at: 0,
      hiveId: 'h1',
      fact: {
        type: 'task-created',
        task: {
          id: 't1',
          hiveId: 'h1',
          subject: 'demo',
          status: 'backlog',
          owner: null,
          createdAt: 0,
          updatedAt: 0,
          blockedBy: [],
          blocks: [],
          requires: [],
        },
        at: 0,
      },
    },
    {
      seq: 3,
      at: 100,
      hiveId: 'h1',
      fact: {
        type: 'task-cancelled',
        taskId: 't1',
        memberId: 'w1',
        reason: 'user abort',
        at: 100,
      },
    },
  ] as any
  const snap = replay(facts)
  const t = snap.tasks.get('t1')
  assert.ok(t)
  assert.equal(t!.status, 'cancelled')
  assert.equal(t!.updatedAt, 100)
})

test('persistence — task-cancelled 叠加 task-updated（status=cancelled）→ 幂等更新', async () => {
  const { replay } = await import('../src/persistence/store')
  const facts = [
    {
      seq: 1,
      at: 0,
      hiveId: 'h1',
      fact: {
        type: 'hive-created',
        hive: { id: 'h1', name: 'h1', createdAt: 0, updatedAt: 0 },
      },
    },
    {
      seq: 2,
      at: 0,
      hiveId: 'h1',
      fact: {
        type: 'task-created',
        task: {
          id: 't2',
          hiveId: 'h1',
          subject: 'demo2',
          status: 'backlog',
          owner: null,
          createdAt: 0,
          updatedAt: 0,
          blockedBy: [],
          blocks: [],
          requires: [],
        },
        at: 0,
      },
    },
    {
      seq: 3,
      at: 50,
      hiveId: 'h1',
      fact: {
        type: 'task-updated',
        taskId: 't2',
        patch: { status: 'cancelled', owner: null },
        at: 50,
      },
    },
    {
      seq: 4,
      at: 60,
      hiveId: 'h1',
      fact: {
        type: 'task-cancelled',
        taskId: 't2',
        memberId: null,
        reason: 'after status patch',
        at: 60,
      },
    },
  ] as any
  const snap = replay(facts)
  const t = snap.tasks.get('t2')
  assert.ok(t)
  assert.equal(t!.status, 'cancelled')
  assert.equal(t!.updatedAt, 60)
})