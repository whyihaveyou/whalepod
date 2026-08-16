/**
 * cancel ⑦ E2E · native 路径（docs/cancel-e2e-plan.md §2.3，⑤ 525fd46 已落地）。
 *
 * 与其他 E2E 唯一差异：后端 runtime = native（真实 createNativeRuntime 句柄），
 * 协议观察点（D2）= ctx.agents 模拟注册表里 fake agent 的 cancel(cause) 副作用计数——
 * DSH agent 原生能力，不降级。turn 终局按 native 惯例脚本化（turn/end aborted）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootE2ECancel, waitFor, digTask } from './helpers/e2e-cancel-boot'

interface FakeAgent {
  readonly id: string
  readonly followups: unknown[]
  cancelCalls: number
  readonly canceled: string[]
}

function makeFakeAgentsRegistry(): {
  registry: unknown
  agents: FakeAgent[]
  created: Array<{ sessionId: string }>
} {
  const agents: FakeAgent[] = []
  const created: Array<{ sessionId: string }> = []
  const registry = {
    // 现行真链：native-runtime 以单参 {sessionId, meta, agentOptions} 调用 create，
    // sessionId 由 runtime 内部 makeId('session') 生成（native-runtime L215-223）。
    async create(options: { sessionId?: string }) {
      const id = options?.sessionId ?? `session_${agents.length}`
      created.push({ sessionId: id })
      const agent: FakeAgent & Record<string, unknown> = {
        id,
        followups: [],
        cancelCalls: 0,
        canceled: [],
        async followup(_session: unknown, message: unknown) {
          agent.followups.push(message)
        },
        // native handle.cancel 以 cause-only 单参调用（native-runtime L405），
        // ⑤ 单测桩为 (turn, cause) 双参——桩按被调方宽容签名记录首个非空参。
        async cancel(turnOrCause: unknown, cause?: string | null) {
          agent.cancelCalls += 1
          agent.canceled.push(String(cause ?? turnOrCause))
        },
        async whenIdle() {},
      }
      agents.push(agent)
      return { agent, async dispose() {} }
    },
    async get(id: string) {
      return agents.find((a) => a.id === id)
    },
    async list() {
      return created.map((c) => ({ id: c.sessionId }))
    },
  }
  return { registry, agents, created }
}

test('E2E-native 全链路：REST cancel → fake agent cancel 副作用（D2）→ 脚本化 aborted → idle', { timeout: 60_000 }, async () => {
  const { registry, agents, created } = makeFakeAgentsRegistry()
  const boot = await bootE2ECancel({ nativeAgentsRegistry: registry, dispatchTimeoutMs: 400 })
  try {
    const hatched = await boot.post(`/v1/hives/${boot.hiveId}/members/hatch`, {
      name: 'w-native',
      role: 'worker',
      backend: 'native',
    })
    assert.equal(hatched.status, 200, `hatch: ${JSON.stringify(hatched.body)}`)
    const memberId = (hatched.body.data as { id: string }).id

    const ws = await boot.wsFacts()
    const createdTask = await boot.post(`/v1/hives/${boot.hiveId}/tasks`, {
      subject: 'e2e-native-chain',
      prompt: 'native in-flight task',
    })
    assert.equal(createdTask.status, 200, `create task: ${JSON.stringify(createdTask.body)}`)
    const taskId = (createdTask.body.data as { id: string }).id

    // 派工在途 latch：WS 帧 + 真实 followup 到达 fake agent（native send → followup）。
    await ws.next('task/updated', (d) => digTask(d).id === taskId && digTask(d).status === 'in-progress', 6000)
    // 真实装配会随 hive 种子孵化 queen 成员（同走 native 后端）——定位「收到 followup 的那个 agent」，
    // 它不依赖创建顺序（❗不能钉 agents[0]，种子成员先于测试成员孵化）。
    const workerAgent = await waitFor(
      () => agents.find((a) => a.followups.length === 1),
      6000,
      `worker fake agent followup received; agents: ${JSON.stringify(agents.map((a) => a.followups.length))}`,
    )

    // REST cancel（A1 同构）→ D2 协议落点断言。
    const res = await boot.post(`/v1/tasks/${taskId}/cancel`, { reason: 'e2e-native' })
    assert.equal(res.status, 202, `cancel status: ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal((res.body.data as { status?: string }).status, 'cancelled')
    await waitFor(() => workerAgent.cancelCalls === 1, 4000, `agent.cancel spy; cancelCalls=${workerAgent.cancelCalls}`)
    assert.deepEqual(workerAgent.canceled, ['cancelled by honeycomb orchestrator'], `cancel causes: ${JSON.stringify(workerAgent.canceled)}`)

    // 幂等重复 cancel：不再触发第二次 agent.cancel，不落第二行事实。
    const again = await boot.post(`/v1/tasks/${taskId}/cancel`)
    assert.equal(again.status, 202, `repeat cancel: ${again.status} ${JSON.stringify(again.body)}`)
    assert.equal((again.body.data as { status?: string }).status, 'cancelled')
    assert.equal(workerAgent.cancelCalls, 1, `idempotent: cancelCalls must stay 1, got ${workerAgent.cancelCalls}`)
    assert.equal(boot.countFact('task-cancelled'), 1, `rows: ${JSON.stringify(boot.factPayloads('task-cancelled'))}`)

    // 脚本化 turn 终局（native 现行协议：turn 为 number、reason 平铺——见 native.ts L253/L283）。
    // fake agent 的 id 即注册时的 sessionId——直接指向 worker 会话（fire 驱动法同 ⑤ 测试）。
    const workerSessionId = workerAgent.id
    void created
    const fire = (event: { type: string; data?: unknown }): void => {
      boot.ctx.emit('session/event', { id: workerSessionId }, event as never)
    }
    fire({ type: 'turn/start', data: { turn: 1 } })
    fire({ type: 'turn/end', data: { turn: 1, reason: 'aborted' } })

    await waitFor(
      () => boot.memberWorkStates.some((s) => s.memberId === memberId && s.state === 'idle'),
      4000,
      `member/work-state idle; workStates: ${JSON.stringify(boot.memberWorkStates)}`,
    )
    const seq = boot.memberWorkStates.filter((s) => s.memberId === memberId).map((s) => s.state)
    assert.ok(!seq.includes('blocked'), `member must never be blocked: ${JSON.stringify(seq)}`)

    // 回读 + 事实行审计。
    const reread = await boot.get(`/v1/hives/${boot.hiveId}/tasks/${taskId}`)
    assert.equal((reread.body.data as { status?: string }).status, 'cancelled', `reread: ${JSON.stringify(reread.body.data)}`)
    assert.equal((reread.body.data as { owner?: unknown }).owner, undefined, `owner cleared: ${JSON.stringify(reread.body.data)}`)
    const [row] = boot.factPayloads('task-cancelled')
    assert.equal(row.taskId, taskId, `row: ${JSON.stringify(row)}`)
    assert.equal(row.reason, 'e2e-native', `row: ${JSON.stringify(row)}`)
    ws.close()
  } finally {
    await boot.close()
  }
})
