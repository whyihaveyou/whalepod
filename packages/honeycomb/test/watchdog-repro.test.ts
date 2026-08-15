/**
 * 派工看门狗 — 由 bug repro 演化而来的回归测试套件
 *
 * 历史：本文件最初作为「缺派工超时看门狗」的复现脚本落地；修复后被
 * 翻转成回归测试，断言看门狗正确触发 `retry` / `failed`，并保证
 * 任务不会再被悬空。
 *
 * 修复要点（见 `src/consumer/orchestration-loop.ts`）：
 *   - `OrchestrationLoopConfig.dispatchTimeoutMs`：派工后挂 per-task 定时器
 *   - `armDispatchWatchdog` / `disarmDispatchWatchdog`：在 dispatchTo / handleReport /
 *     failDispatch / sweepIdle / stop 五处对称撤防
 *   - 到点路由到 `failDispatch` → 与 sendTo=false 共享重派/回滚路径
 *
 * 现象（已被修复）：sendTo 成功后 runtime 永不回 report → 任务永远卡
 * 在 in-progress。现在：到点视同 sendTo 失败，会按 maxDispatchAttempts
 * 走完 retry → failed 链。
 *
 * 运行：`pnpm tsx --test test/watchdog-repro.test.ts`
 *
 * @module @dfh/honeycomb/consumer/watchdog
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createOrchestrationLoop,
  type LoopEvent,
  type LoopMember,
  type LoopTask,
  type OrchestrationLoop,
  type OrchestrationLoopDeps,
} from '../src/consumer/orchestration-loop'

// ---------- 与 orchestration-loop.test.ts 同构的 fake 层 ----------

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
  clock: { t: number }
  /** 按 ms 触发对应定时器回调（区分 idle sweep 与 dispatch watchdog）。 */
  fireByMs: (ms: number) => void
  sendCount: () => number
}

function boot(opts: {
  idleTimeoutMs?: number
  dispatchTimeoutMs?: number
  maxDispatchAttempts?: number
} = {}): Fixture {
  const ctx = new FakeContext()
  const roster = new FakeRoster()
  const ledger = new FakeLedger()
  const events: LoopEvent[] = []
  const clock = { t: 0 }
  // 源里会按 ms 设置两种定时器：idleTimeoutMs 与 dispatchTimeoutMs
  const cbsByMs = new Map<number, () => void>()

  const deps: OrchestrationLoopDeps = {
    ctx: ctx as any,
    roster: roster as any,
    ledger: ledger as any,
    applyTask: async (_hiveId, patch) => {
      const t = ledger.tasks.find((x) => x.id === patch.taskId)
      if (t) {
        if (patch.owner !== undefined) t.owner = patch.owner ?? null
        if (patch.status !== undefined) t.status = patch.status
      }
    },
    config: {
      idleTimeoutMs: opts.idleTimeoutMs ?? 0,
      maxDispatchAttempts: opts.maxDispatchAttempts ?? 3,
      dispatchTimeoutMs: opts.dispatchTimeoutMs ?? 1_000,
    },
    now: () => clock.t,
    setTimer: (cb, ms) => {
      cbsByMs.set(ms, cb)
      return ms
    },
    clearTimer: (h) => {
      cbsByMs.delete(h as number)
    },
  }

  const loop = createOrchestrationLoop(deps)
  loop.onEvent((e) => events.push(e))
  loop.start(['h1'])
  return {
    ctx,
    roster,
    ledger,
    loop,
    events,
    clock,
    fireByMs: (ms) => cbsByMs.get(ms)?.(),
    sendCount: () => roster.sent.length,
  }
}

function addWorker(f: Fixture, id: string, online = true): void {
  f.roster.members.push({ id, hiveId: 'h1', role: 'worker', status: 'idle' })
  if (online) f.roster.online.add(id)
}

/** worker 回报告。注意 hiveId 必须在 message 内部（与消息体契约一致）。 */
function emitReport(f: Fixture, fromId: string, content = 'done'): void {
  f.ctx.emit('message/created', {
    message: { hiveId: 'h1', kind: 'report', from: fromId, content },
  })
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

// =====================================================================
// 回归用例 1：runtime 永不复命 → 看门狗按 maxDispatchAttempts 走完 retry→failed
// =====================================================================

test('【回归】sendTo 成功但 runtime 永不回 report → 看门狗按 maxDispatchAttempts 走完 retry→failed', async () => {
  const f = boot({ dispatchTimeoutMs: 1_000, maxDispatchAttempts: 3 })
  addWorker(f, 'w1', true)
  const task = f.ledger.create('h1', '静默任务')

  await f.loop.dispatchNow('h1')
  assert.equal(task.status, 'in-progress')
  assert.equal(f.sendCount(), 1)

  // 第 1 次超时：retry
  f.clock.t += 1_500
  f.fireByMs(1_000)
  await flush()
  assert.equal(task.status, 'in-progress', '第 1 次超时后任务被回滚又重派，仍在 in-progress')
  assert.equal(task.owner, 'w1')
  assert.equal(f.sendCount(), 2, '应自动重派')
  assert.equal(f.events.filter((e) => e.type === 'retry').length, 1)
  assert.equal(f.events.filter((e) => e.type === 'failed').length, 0)

  // 第 2 次超时：retry
  f.clock.t += 1_500
  f.fireByMs(1_000)
  await flush()
  assert.equal(task.status, 'in-progress')
  assert.equal(f.sendCount(), 3)
  assert.equal(f.events.filter((e) => e.type === 'retry').length, 2)
  assert.equal(f.events.filter((e) => e.type === 'failed').length, 0)

  // 第 3 次超时：达到 maxDispatchAttempts → failed，回滚到 backlog+null
  f.clock.t += 1_500
  f.fireByMs(1_000)
  await flush()
  assert.equal(task.status, 'backlog', '最终回滚到 backlog')
  assert.equal(task.owner, null, 'owner 被清空')
  assert.equal(f.events.filter((e) => e.type === 'retry').length, 2, '不再 retry')
  assert.equal(f.events.filter((e) => e.type === 'failed').length, 1, '最终 failed')
})

// =====================================================================
// 回归用例 2：worker 中途回 report → watchdog 被撤销，任务正常 completed
// =====================================================================

test('【回归】worker 中途回 report → watchdog 被撤销，任务正常 completed', async () => {
  const f = boot({ dispatchTimeoutMs: 1_000 })
  addWorker(f, 'w1', true)
  const task = f.ledger.create('h1', '会慢慢来的任务')

  await f.loop.dispatchNow('h1')
  assert.equal(task.status, 'in-progress')
  assert.equal(f.sendCount(), 1)

  // 推进 500ms（不到超时），worker 回 report
  f.clock.t += 500
  emitReport(f, 'w1')
  await flush()

  assert.equal(task.status, 'completed', '任务正常 completed')
  assert.equal(
    f.events.filter((e) => e.type === 'retry' || e.type === 'failed').length,
    0,
    '看门狗被 report 撤销，无重试/失败',
  )

  // 即使再推进到原本该超时的时刻，也不应触发 watchdog（已经被撤销）
  f.clock.t += 2_000
  f.fireByMs(1_000) // no-op：dispatchWatchdogs map 不再持有句柄
  await flush()
  assert.equal(task.status, 'completed', '任务保持 completed')
})

// =====================================================================
// 回归用例 3：idle dismiss 撤销 watchdog（worker idle 超时被踢 → 任务回滚 + watchdog 不再 fire）
// =====================================================================

test('【回归】idle 超时 dismiss 同时撤销 watchdog', async () => {
  const f = boot({ idleTimeoutMs: 500, dispatchTimeoutMs: 5_000, maxDispatchAttempts: 3 })
  addWorker(f, 'w1', true)
  const task = f.ledger.create('h1', 'idle worker 任务')

  await f.loop.dispatchNow('h1')
  // worker 报告一次工作状态 → lastActivityAt = 0
  f.ctx.emit('member/work-state', { hiveId: 'h1', memberId: 'w1', state: 'running' })
  await flush()

  // 推进超过 idleTimeoutMs（dispatchTimeoutMs=5s 还没到）
  f.clock.t += 800
  f.fireByMs(500) // 触发 idle sweep
  await flush()

  assert.equal(task.status, 'backlog', 'idle sweep 把任务回滚到 backlog')
  assert.equal(task.owner, null, 'owner 被清空')
  assert.equal(f.roster.members.find((m) => m.id === 'w1'), undefined, 'w1 被 dismiss')
  assert.equal(
    f.events.filter((e) => e.type === 'dismissed').length,
    1,
    '发出 dismissed 事件',
  )

  // 继续推进到原本该 dispatch 超时的时刻 —— 此时 watchdog 已被 disarm，fireByMs(5_000) 是 no-op
  f.clock.t += 5_000
  f.fireByMs(5_000)
  await flush()
  assert.equal(task.status, 'backlog', '任务未被 watchdog 二次回收')
  assert.equal(
    f.events.filter((e) => e.type === 'failed').length,
    0,
    'idle dismiss 已清掉 watchdog，不会再触发 failed',
  )
})

// =====================================================================
// 回归用例 4：watchdog fire 与 report 几乎同时 → 守卫避免双重回收
// =====================================================================

test('【回归】watchdog 到点与 report 几乎同时 → 守卫避免双重回收', async () => {
  const f = boot({ dispatchTimeoutMs: 1_000 })
  addWorker(f, 'w1', true)
  const task = f.ledger.create('h1', '恰好完成的报告')

  await f.loop.dispatchNow('h1')
  // 推进到刚过超时 — 此时 worker 实际上已完成并发了 report（在 watchdog fire 之前）
  f.clock.t += 1_100
  emitReport(f, 'w1')
  await flush()
  assert.equal(task.status, 'completed', 'report 先到 → 任务 completed')

  // 此时再触发 watchdog：disarmDispatchWatchdog 已在 handleReport 内清空 maps，
  // onDispatchTimeout 内：current = ledger.list('in-progress').find(id===task && owner===worker)
  //   此时 task.status='completed'，不在 in-progress 列表中 → current=undefined → return
  f.fireByMs(1_000)
  await flush()
  assert.equal(task.status, 'completed', '二次 watchdog fire 被守卫拒绝，任务保持 completed')
  assert.equal(
    f.events.filter((e) => e.type === 'retry' || e.type === 'failed').length,
    0,
    '不会因为 watchdog 而误触发重派/失败',
  )
})