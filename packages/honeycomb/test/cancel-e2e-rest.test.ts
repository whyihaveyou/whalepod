/**
 * cancel ⑦ E2E · REST 语义矩阵（docs/cancel-e2e-plan.md 场景 B/C/D/F）。
 *
 * 在真实 REST+持久化+编排装配下复核 ⑥ 冻结的传输语义：
 * B 幂等重复 cancel（第二发不落第二行事实）/ C 不存在 409 / D 终态 409 / F 未运行 409。
 * E（503 无 orchestration）按方案 §6 不单设——transport-cancel 既有用例已锁。
 * 与 transport-cancel.test.ts 的分工（方案 §5）：此处端到端 jsonl 落盘行数是断言主体，
 * transport-cancel 的 spy/deriveState 序列此不重复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootE2ECancel, waitFor } from './helpers/e2e-cancel-boot'

test('E2E-REST 语义矩阵：B 幂等 / C 不存在 / D 终态 / F 未运行', { timeout: 60_000 }, async () => {
  const boot = await bootE2ECancel({ dispatchTimeoutMs: 400 })
  try {
    const createTask = async (subject: string) => {
      const res = await boot.post(`/v1/hives/${boot.hiveId}/tasks`, { subject, prompt: `${subject} prompt` })
      assert.equal(res.status, 200, `create ${subject}: ${JSON.stringify(res.body)}`)
      return (res.body.data as { id: string }).id
    }
    const patchStatus = async (taskId: string, status: string) => {
      const res = await boot.patch(`/v1/hives/${boot.hiveId}/tasks/${taskId}`, { status })
      assert.equal(res.status, 200, `patch ${taskId}→${status}: ${res.status} ${JSON.stringify(res.body)}`)
      return res
    }

    // B 幂等：in-progress 任务取消两次——第二次返回同状态最新快照，不落第二事实行。
    const t1 = await createTask('e2e-b-idempotent')
    await patchStatus(t1, 'in-progress')
    const first = await boot.post(`/v1/tasks/${t1}/cancel`, { reason: 'e2e-b' })
    assert.equal(first.status, 202, `first cancel: ${first.status} ${JSON.stringify(first.body)}`)
    assert.equal((first.body.data as { status?: string }).status, 'cancelled')
    await waitFor(() => boot.countFact('task-cancelled') === 1, 6000, `first fact landed; rows: ${JSON.stringify(boot.factRows())}`)
    const second = await boot.post(`/v1/tasks/${t1}/cancel`, { reason: 'e2e-b-repeat' })
    assert.equal(second.status, 202, `repeat cancel must be idempotent 202: ${second.status} ${JSON.stringify(second.body)}`)
    assert.equal((second.body.data as { status?: string }).status, 'cancelled', `repeat snapshot: ${JSON.stringify(second.body.data)}`)
    // 幂等时序断言：等一拍窗口确认第二发确实没有落行（若会落，append 与 202 同帧完成）。
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(boot.countFact('task-cancelled'), 1, `repeat cancel must not append a second row: ${JSON.stringify(boot.factPayloads('task-cancelled'))}`)

    // C 不存在：409 TASK_NOT_FOUND。
    const missing = await boot.post('/v1/tasks/task-does-not-exist/cancel')
    assert.equal(missing.status, 409, `missing: ${missing.status} ${JSON.stringify(missing.body)}`)
    assert.equal(((missing.body.error as Record<string, unknown> | undefined)?.code), 'TASK_NOT_FOUND', `missing code: ${JSON.stringify(missing.body)}`)

    // D 终态：completed → 409 TASK_TERMINAL。
    const t2 = await createTask('e2e-d-terminal')
    await patchStatus(t2, 'in-progress')
    await patchStatus(t2, 'completed')
    const terminal = await boot.post(`/v1/tasks/${t2}/cancel`)
    assert.equal(terminal.status, 409, `terminal: ${terminal.status} ${JSON.stringify(terminal.body)}`)
    assert.equal(((terminal.body.error as Record<string, unknown> | undefined)?.code), 'TASK_TERMINAL', `terminal code: ${JSON.stringify(terminal.body)}`)

    // F 未运行：backlog → 409 TASK_NOT_RUNNING。
    const t3 = await createTask('e2e-f-backlog')
    const notRunning = await boot.post(`/v1/tasks/${t3}/cancel`)
    assert.equal(notRunning.status, 409, `not-running: ${notRunning.status} ${JSON.stringify(notRunning.body)}`)
    assert.equal(((notRunning.body.error as Record<string, unknown> | undefined)?.code), 'TASK_NOT_RUNNING', `not-running code: ${JSON.stringify(notRunning.body)}`)

    // 全程只应有 B 的一行 task-cancelled。
    assert.equal(boot.countFact('task-cancelled'), 1, `rows: ${JSON.stringify(boot.factPayloads('task-cancelled'))}`)
  } finally {
    await boot.close()
  }
})
