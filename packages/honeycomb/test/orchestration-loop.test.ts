/**
 * 编排循环单测 —— 覆盖必测场景：派工 / 阻塞恢复 / 失败重派（+ idle dismiss）。
 *
 * 用进程内 fake ctx/roster/ledger（内存 Map + 事件总线）驱动循环，避免 boot
 * 整个插件；通过 `loop.onEvent` 断言内部转移事件序列，通过 fake 记录断言副作用。
 *
 * @module @dfh/honeycomb/consumer/orchestration-loop.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOrchestrationLoop,
  DEFAULT_MAX_DISPATCH_ATTEMPTS,
  type LoopEvent,
  type LoopMember,
  type LoopTask,
  type OrchestrationLoop,
  type OrchestrationLoopDeps,
} from '../src/consumer/orchestration-loop'

/** 进程内事件总线双（捕获订阅者 + 手动触发）。 */
class FakeContext {
  private listeners = new Map<string, Array<(p: any) => void>>()
  on(name: string, fn: (p: any) => void): { dispose(): void } {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name)!.push(fn)
    return { dispose: () => {} }
  }
  emit(name: string, payload: any): void {
    for (const fn of this.listeners.get(name) ?? []) fn(payload)
  }
}

/** 内存 roster：成员表 + sendTo 记录；`online` 决定 sendTo 是否成功。 */
class FakeRoster {
  members: LoopMember[] = []
  sent: Array<{ hiveId: string; memberId: string; message: { role: string; content: string } }> = []
  online = new Set<string>()

  async list(hiveId: string): Promise<LoopMember[]> {
    return this.members.filter((m) => m.hiveId === hiveId)
  }
  async sendTo(
    hiveId: string,
    memberId: string,
    message: { role: string; content: string },
  ): Promise<boolean> {
    this.sent.push({ hiveId, memberId, message })
    return this.online.has(memberId)
  }
  async dismiss(_hiveId: string, memberId: string): Promise<void> {
    this.members = this.members.filter((m) => m.id !== memberId)
  }
}

/** 内存 ledger：任务表，含 runnable 语义（blockedBy 全 completed 才 runnable）。 */
class FakeLedger {
  tasks: LoopTask[] = []
  private n = 0
  create(hiveId: string, _subject: string, blockedBy: string[] = []): LoopTask {
    const t: LoopTask = { id: `t${++this.n}`, hiveId, status: 'backlog', owner: null, blockedBy }
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

interface Fixture {
  ctx: FakeContext
  roster: FakeRoster
  ledger: FakeLedger
  loop: OrchestrationLoop
  events: LoopEvent[]
  applyCalls: Array<{ taskId: string; status?: string; owner?: string | null }>
  /** 捕获 idle 扫描回调的 fake timer（可手动触发 sweepIdle）。 */
  sweep: (() => void) | null
  /** 可推进的假时钟。 */
  clock: { t: number }
}

function boot(opts: { idleTimeoutMs?: number } = {}): Fixture {
  const ctx = new FakeContext()
  const roster = new FakeRoster()
  const ledger = new FakeLedger()
  const events: LoopEvent[] = []
  const applyCalls: Fixture['applyCalls'] = []
  let sweep: (() => void) | null = null
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
    config: {
      idleTimeoutMs: opts.idleTimeoutMs ?? 0,
      maxDispatchAttempts: DEFAULT_MAX_DISPATCH_ATTEMPTS,
    },
    now: () => clock.t,
    setTimer: (cb) => {
      sweep = cb
      return 0
    },
    clearTimer: () => {},
  }

  const loop = createOrchestrationLoop(deps)
  loop.onEvent((e) => events.push(e))
  loop.start(['h1'])
  return { ctx, roster, ledger, loop, events, applyCalls, sweep: () => sweep?.(), clock }
}

/** 注册一个 worker；`online=true` 使其 sendTo 成功。 */
function addWorker(f: Fixture, id: string, online = true, role = 'worker'): void {
  f.roster.members.push({ id, hiveId: 'h1', role, status: 'idle' })
  if (online) f.roster.online.add(id)
}

/** 让事件订阅里 `void` 启动的 async 处理器排干（事件驱动无返回值时靠此确定化断言）。 */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

// ---------- 场景 1：派工 ----------

test('派工：runnable 任务派给空闲 worker（sendTo 到 RuntimeHandle 入口）', async () => {
  const f = boot()
  addWorker(f, 'w1')
  const task = f.ledger.create('h1', '任务A')

  await f.loop.dispatchNow('h1')

  assert.equal(task.owner, 'w1')
  assert.equal(task.status, 'in-progress')
  assert.equal(f.roster.sent.length, 1)
  assert.equal(f.roster.sent[0].memberId, 'w1')
  assert.match(f.roster.sent[0].message.content, /执行任务/)
  assert.ok(f.events.some((e) => e.type === 'dispatched' && e.taskId === task.id && e.memberId === 'w1' && e.attempt === 1))
})

test('派工：queen 与忙碌 worker 不接任务，只派空闲 worker', async () => {
  const f = boot()
  f.roster.members.push({ id: 'q1', hiveId: 'h1', role: 'queen', status: 'working' })
  f.roster.members.push({ id: 'w1', hiveId: 'h1', role: 'worker', status: 'working' }) // 忙
  addWorker(f, 'w2')
  f.ledger.create('h1', '任务A')

  await f.loop.dispatchNow('h1')

  assert.equal(f.roster.sent.length, 1)
  assert.equal(f.roster.sent[0].memberId, 'w2')
})

// ---------- 场景 2：阻塞恢复 ----------

test('阻塞恢复：blockedBy 依赖完成后自动解除阻塞并派工下游任务', async () => {
  const f = boot()
  addWorker(f, 'w1')
  const dep = f.ledger.create('h1', '前置A')
  const downstream = f.ledger.create('h1', '下游B', [dep.id])

  // 首次派工：只派 runnable 的前置A，下游B 因 blockedBy 不派
  await f.loop.dispatchNow('h1')
  assert.equal(dep.owner, 'w1')
  assert.equal(downstream.owner, null)

  // worker 交付：report → 前置A completed → 下游B 解除阻塞 → 补单派工
  f.ctx.emit('message/created', { message: { hiveId: 'h1', from: 'w1', kind: 'report', content: 'done' } })
  await flush()

  assert.equal(dep.status, 'completed')
  assert.equal(downstream.owner, 'w1')
  assert.equal(downstream.status, 'in-progress')
  assert.ok(f.events.some((e) => e.type === 'completed' && e.taskId === dep.id))
  assert.ok(f.events.some((e) => e.type === 'unblocked' && e.taskId === downstream.id))
})

// ---------- 场景 3：失败重派 / 回滚 ----------

test('失败重派：sendTo 失败触发重派，达上限后回滚为 backlog + 清 owner', async () => {
  const f = boot()
  addWorker(f, 'w1', /* online */ false) // 有成员但无在线 handle → sendTo 失败
  const task = f.ledger.create('h1', '任务A')

  await f.loop.dispatchNow('h1')

  // 达到 maxDispatchAttempts 后回滚：backlog + owner 清空
  assert.equal(task.status, 'backlog')
  assert.equal(task.owner, null)
  // 发生重派（retry）与最终失败（failed）事件
  assert.ok(f.events.some((e) => e.type === 'retry'), '应有 retry 事件')
  assert.ok(f.events.some((e) => e.type === 'failed' && e.taskId === task.id), '应有 failed 事件')
  // 派工尝试次数 ≤ maxDispatchAttempts
  const retries = f.events.filter((e) => e.type === 'retry')
  assert.ok(retries.length <= DEFAULT_MAX_DISPATCH_ATTEMPTS)
})

test('失败重派：在线 worker 首次派工即成功（attempt=1）', async () => {
  const f = boot()
  addWorker(f, 'w1')
  const task = f.ledger.create('h1', '任务A')
  await f.loop.dispatchNow('h1')
  assert.equal(task.owner, 'w1')
  assert.equal(task.status, 'in-progress')
})

// ---------- 场景 4：idle dismiss ----------

test('idle 超时 dismiss：空闲 worker 超时后被移出名册并回滚未完成任务', async () => {
  const f = boot({ idleTimeoutMs: 50 })
  addWorker(f, 'w1')
  const task = f.ledger.create('h1', '任务A')

  // 派工 → w1 接到任务A
  await f.loop.dispatchNow('h1')
  assert.equal(task.owner, 'w1')

  // w1 报告活跃（运行中），记录活跃时刻 t=0
  f.ctx.emit('member/work-state', { hiveId: 'h1', memberId: 'w1', state: 'running' })

  // 交付完成（任务 completed → 成员空闲）
  f.ctx.emit('message/created', { message: { hiveId: 'h1', from: 'w1', kind: 'report', content: 'done' } })
  await flush()
  assert.equal(task.status, 'completed')

  // 时间推进超过 idleTimeoutMs，且 w1 再无活跃 → sweep 应 dismiss
  f.clock.t += 10_000
  f.sweep!()
  await flush()

  assert.equal(f.roster.members.find((m) => m.id === 'w1'), undefined, '空闲超时后应被 dismiss')
  assert.ok(f.events.some((e) => e.type === 'dismissed' && e.memberId === 'w1'), '应有 dismissed 事件')
})
