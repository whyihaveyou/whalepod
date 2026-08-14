/**
 * Orchestration loop — queen 派工 / worker 交付闭环 的真实现 (§7–§10).
 *
 * 事件驱动（不轮询）：订阅 `task/created`、`message/created`(report)、
 * `member/work-state`、`task/updated`，驱动：
 *  - queen 派工：runnable 判定 → capability 匹配 → 最久未派工；
 *  - worker 交付闭环：report → 标记 completed → 成员回 idle → 触发下一任务；
 *  - blockedBy 依赖阻塞 / 解除后自动恢复派工；
 *  - idle 超时 dismiss（`idleTimeoutMs`）；
 *  - `maxDispatchAttempts` 失败重派 / 回滚。
 *
 * 派工端点：`ctx.roster.sendTo(hiveId, memberId, RuntimeMessage)`，底层即
 * 胶水层的 `RuntimeHandle.send(RuntimeMessage)`（store/forward）。成员状态
 * 派生事件（`member/status` / `member/work-state`）由运行时/胶水层驱动，
 * 本循环只消费并做编排决策。
 *
 * 注意：本文件只依赖 `roster`/`ledger`/`courier`/`mandate` 的稳定接口，
 * 不触碰 `src/connectors/`（agent 会话由胶水层封装在 RuntimeHandle 后面）。
 *
 * @module @dfh/honeycomb/consumer/orchestration-loop
 */

import type { Context } from '../framework'

/**
 * 编排循环配置。`idleTimeoutMs` / `maxDispatchAttempts` 在装配时可覆盖；
 * 未显式给定时用下列默认值（设计文档 §10）。
 */
export interface OrchestrationLoopConfig {
  /** 成员 idle 超时（ms）自动 dismiss；0 表示不启用自动 dismiss。 */
  idleTimeoutMs?: number
  /** 单个任务最大派工/重派次数，超过则回滚为 failed。 */
  maxDispatchAttempts?: number
}

export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000 // 15 min
export const DEFAULT_MAX_DISPATCH_ATTEMPTS = 3

/** 循环内部状态转移的可观察事件（给测试/监控用，不污染全局事件表）。 */
export type LoopEvent =
  | { type: 'dispatched'; hiveId: string; taskId: string; memberId: string; attempt: number }
  | { type: 'completed'; hiveId: string; taskId: string; memberId: string }
  | { type: 'unblocked'; hiveId: string; taskId: string }
  | { type: 'retry'; hiveId: string; taskId: string; memberId: string; attempt: number }
  | { type: 'failed'; hiveId: string; taskId: string; memberId: string }
  | { type: 'dismissed'; hiveId: string; memberId: string; reason: string; taskId?: string }

/** 任务 → 成员的 capability 匹配谓词。缺省放行（不启用 capability 门禁）。 */
export type CapabilityMatcher = (task: { requires?: string[] }, member: { capabilities?: string[] }) => boolean

/** 编排循环可见的最小模型投影（与 types 弱耦合，便于测试 stub）。 */
export interface LoopTask {
  id: string
  hiveId: string
  status: string
  owner: string | null
  blockedBy: string[]
  requires?: string[]
}
export interface LoopMember {
  id: string
  hiveId: string
  role: string
  status: string
  capabilities?: string[]
}

/** 编排循环句柄。 */
export interface OrchestrationLoop {
  /** 订阅若干 hive 的编排服务（幂等）。 */
  start(hiveIds: string[]): void
  /** 停止监听、清理计时器（销毁所有订阅与 interval）。 */
  stop(): void
  /** 立即触发一次派工扫描（用于测试 / 手动补单）。 */
  dispatchNow(hiveId: string): Promise<void>
  /** 订阅循环内部转移事件（测试/可观测）。 */
  onEvent(listener: (event: LoopEvent) => void): { dispose(): void }
}

/** 编排循环的构造依赖（纯内存服务，全部可注入 stub 以单测）。 */
export interface OrchestrationLoopDeps {
  ctx: Context
  roster: {
    list(hiveId: string): Promise<LoopMember[]>
    sendTo(
      hiveId: string,
      memberId: string,
      message: { role: string; content: string },
    ): Promise<boolean>
    dismiss(hiveId: string, memberId: string): Promise<void>
  }
  ledger: {
    list(
      hiveId: string,
      filter?: { status?: string | string[]; runnable?: boolean; limit?: number },
    ): Promise<LoopTask[]>
  }
  /** 落任务状态 / 所有权（内部由 ledger.update / setOwner 实现）。返回更新后的任务。 */
  applyTask(
    hiveId: string,
    patch: { taskId: string; status?: string; owner?: string | null },
  ): Promise<void>
  matchesCapability?: CapabilityMatcher
  config?: OrchestrationLoopConfig
  now?: () => number
  /** 后台调度器（默认 setInterval）。idle 扫描复用；可注入 fake。 */
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** 装配编排循环；订阅事件，返回可 stop 的 handle。 */
export function createOrchestrationLoop(deps: OrchestrationLoopDeps): OrchestrationLoop {
  const {
    ctx,
    roster,
    ledger,
    applyTask,
    matchesCapability = () => true,
    config = {},
    now = Date.now,
    setTimer = (cb, ms) => setInterval(cb, ms),
    clearTimer = (h) => clearInterval(h as ReturnType<typeof setInterval>),
  } = deps

  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxDispatchAttempts = config.maxDispatchAttempts ?? DEFAULT_MAX_DISPATCH_ATTEMPTS

  const listeners: Array<() => void> = [] // 订阅释放器（ctx.on 返回 `() => void`，interval 同理）
  const eventListeners: Array<(e: LoopEvent) => void> = []
  let started = false
  let timerHandle: unknown

  // 局部编排状态（纯内存，不落库 —— 这是决策缓存，事实源在 ledger/roster）。
  const attempts = new Map<string, number>() // taskId → 已派工次数
  const lastDispatchedAt = new Map<string, number>() // memberId → 上次派工时间戳
  const lastActivityAt = new Map<string, number>() // memberId → 上次活跃时间戳
  const trackedHives = new Set<string>()

  function emitLoopEvent(e: LoopEvent): void {
    for (const fn of eventListeners) fn(e)
  }

  function subscribe(): void {
    if (started) return
    started = true

    // 新任务 → 尝试派工
    listeners.push(ctx.on('task/created', (p: { task: LoopTask }) => {
      void dispatchFor(p.task.hiveId)
    }))

    // 成员工作状态变化 → 跟踪活跃；状态流转后重扫
    listeners.push(ctx.on('member/work-state', (p: { hiveId: string; memberId: string; state: string }) => {
      lastActivityAt.set(p.memberId, now())
      void dispatchFor(p.hiveId)
    }))

    // 汇报消息（worker → queen 的交付）
    listeners.push(ctx.on('message/created', (p: { message: { hiveId: string; from: string; kind: string; content: string } }) => {
      if (p.message.kind !== 'report') return
      void handleReport(p.message.hiveId, p.message.from, p.message.content)
    }))

    // 任务更新（依赖解除 / 状态变化）→ 重扫
    listeners.push(ctx.on('task/updated', (p: { task: LoopTask }) => {
      void dispatchFor(p.task.hiveId)
    }))

    // idle 超时扫描
    if (idleTimeoutMs > 0) {
      timerHandle = setTimer(() => void sweepIdle(), Math.min(idleTimeoutMs, 30_000))
      listeners.push(() => clearTimer(timerHandle))
    }
  }

  // ---------- 派工 ----------

  /** 为某 hive 扫描并派工：runnable → capability → 最久未派工。 */
  async function dispatchFor(hiveId: string): Promise<void> {
    if (!started) return
    const members = await roster.list(hiveId)
    const workers = members.filter((m) => isIdleWorker(m))
      .sort((a, b) => (lastDispatchedAt.get(a.id) ?? 0) - (lastDispatchedAt.get(b.id) ?? 0))

    for (const worker of workers) {
      const task = await pickTask(hiveId, worker)
      if (!task) continue
      await dispatchTo(hiveId, task, worker)
    }
  }

  function isIdleWorker(m: LoopMember): boolean {
    return m.role !== 'queen' && (m.status === 'idle' || m.status === 'finished')
  }

  /** 选一个可执行任务：只派「未认领（owner=null）且 runnable 的 backlog」任务。
   *  认领即 owner 置位 + in-progress，从此不再被其它派工扫描重新认领（原子认领）。
   *  顺序：最久未派工靠前。 */
  async function pickTask(hiveId: string, worker: LoopMember): Promise<LoopTask | undefined> {
    const tasks = await ledger.list(hiveId, { status: ['backlog'], runnable: true })
    const eligible = tasks
      .filter((t) => t.owner === null) // 未认领
      .filter((t) => matchesCapability(t, worker))
      .sort((a, b) => (lastDispatchedAt.get(a.id) ?? 0) - (lastDispatchedAt.get(b.id) ?? 0))
    return eligible[0]
  }

  async function dispatchTo(hiveId: string, task: LoopTask, worker: LoopMember): Promise<void> {
    const attempt = (attempts.get(task.id) ?? 0) + 1
    attempts.set(task.id, attempt)

    await applyTask(hiveId, { taskId: task.id, owner: worker.id, status: 'in-progress' })
    lastDispatchedAt.set(worker.id, now())

    const sent = await roster.sendTo(hiveId, worker.id, {
      role: 'queen',
      content: buildDirective(task, attempt),
    })

    if (!sent) {
      await failDispatch(hiveId, task, worker, attempt)
      return
    }

    emitLoopEvent({ type: 'dispatched', hiveId, taskId: task.id, memberId: worker.id, attempt })
  }

  function buildDirective(task: LoopTask, attempt: number): string {
    const marker = attempt > 1 ? ` (重派 #${attempt})` : ''
    return `执行任务 ${task.id}: ${task.id}${marker}`
  }

  // ---------- 交付闭环 ----------

  /** 处理 worker 的 report：完成其名下 in-progress 任务 → 成员回 idle → 补单。 */
  async function handleReport(hiveId: string, memberId: string, _content: string): Promise<void> {
    const owned = await ledger.list(hiveId, { status: 'in-progress' })
    const task = owned.find((t) => t.owner === memberId)
    if (!task) return

    await applyTask(hiveId, { taskId: task.id, status: 'completed' })
    attempts.delete(task.id)
    emitLoopEvent({ type: 'completed', hiveId, taskId: task.id, memberId })

    // 依赖释放 + 补单
    await releaseBlocked(hiveId, task.id)
    await dispatchFor(hiveId)
  }

  /** 依赖释放：被完成任务的 blockedBy 引用的任务，若其所有 blockers 均已 completed，
   *  则其已不再阻塞——emit `unblocked`（恢复派工由随后的 dispatchFor 完成）。 */
  async function releaseBlocked(hiveId: string, completedTaskId: string): Promise<void> {
    const completed = new Set(
      (await ledger.list(hiveId, { status: 'completed' })).map((t) => t.id),
    )
    completed.add(completedTaskId)
    const pending = await ledger.list(hiveId, { status: 'backlog' })
    for (const t of pending) {
      if (t.blockedBy.includes(completedTaskId) && t.blockedBy.every((dep) => completed.has(dep))) {
        emitLoopEvent({ type: 'unblocked', hiveId, taskId: t.id })
      }
    }
  }

  // ---------- 失败重派 / 回滚 ----------

  async function failDispatch(hiveId: string, task: LoopTask, worker: LoopMember, attempt: number): Promise<void> {
    if (attempt >= maxDispatchAttempts) {
      // 已达上限：放弃该任务，emit failed 并回滚到未派工（退回 backlog、清 owner）。
      // 注：TaskStatus 枚举无 'failed'，故回滚用 backlog + owner=null 表达"失败回滚"。
      emitLoopEvent({ type: 'failed', hiveId, taskId: task.id, memberId: worker.id })
      await applyTask(hiveId, { taskId: task.id, status: 'backlog', owner: null })
      attempts.delete(task.id)
      return
    }
    // 未达上限：回滚到未认领 backlog，允许换人/重派；计数保留由下一轮复用。
    emitLoopEvent({ type: 'retry', hiveId, taskId: task.id, memberId: worker.id, attempt })
    await applyTask(hiveId, { taskId: task.id, owner: null, status: 'backlog' })
    await dispatchFor(hiveId)
  }

  // ---------- idle 超时 dismiss ----------

  async function sweepIdle(): Promise<void> {
    if (idleTimeoutMs <= 0) return
    const nowTs = now()
    for (const hiveId of trackedHives) {
      const members = await roster.list(hiveId)
      for (const member of members) {
        if (!isIdleWorker(member)) continue
        const lastActive = lastActivityAt.get(member.id) ?? nowTs
        if (nowTs - lastActive < idleTimeoutMs) continue
        // 回收其名下未完成任务，然后在空闲超时后 dismiss
        const owned = await ledger.list(hiveId, { status: 'in-progress' })
        const task = owned.find((t) => t.owner === member.id)
        if (task) {
          attempts.delete(task.id)
          await applyTask(hiveId, { taskId: task.id, owner: null, status: 'backlog' })
          emitLoopEvent({ type: 'dismissed', hiveId, memberId: member.id, reason: 'idle-timeout', taskId: task.id })
        } else {
          emitLoopEvent({ type: 'dismissed', hiveId, memberId: member.id, reason: 'idle-timeout' })
        }
        await roster.dismiss(hiveId, member.id)
        lastActivityAt.delete(member.id)
      }
    }
  }

  // ---------- public ----------

  return {
    start(hiveIds: string[]) {
      for (const h of hiveIds) trackedHives.add(h)
      subscribe()
    },
    stop() {
      for (const l of listeners) l()
      listeners.length = 0
      timerHandle = undefined
      started = false
    },
    async dispatchNow(hiveId: string) {
      await dispatchFor(hiveId)
    },
    onEvent(listener) {
      eventListeners.push(listener)
      return {
        dispose: () => {
          const i = eventListeners.indexOf(listener)
          if (i >= 0) eventListeners.splice(i, 1)
        },
      }
    },
  }
}
