/**
 * cancel ⑦ E2E · ACP 路径（docs/cancel-e2e-plan.md §2.1）。
 *
 * 真 transport server + 真 jsonl 持久化 + 真编排循环 + 真实 roster/RuntimeRegistry 装配
 * + 真 AgentSessionRuntime 句柄 + 真 ACP mock 子进程（acp-mock-agent.mjs，本地 node）。
 *
 * A5 决定性证据：mock 的 stopReason=cancelled **只在收到我方 session/cancel 通知后**发出
 * （fixture 无自取消 env 时永远跑满 4 chunk → end_turn）；因此成员终态
 * 「idle（cancelled 派生）而非 finished（done(0) 派生）」即证明协议级取消真实到达。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootE2ECancel, waitFor, digTask } from './helpers/e2e-cancel-boot'

test('E2E-A ACP 全链路：REST cancel → 协议级取消 → A1-A7 锚点', { timeout: 60_000 }, async () => {
  // 4 chunk × 80ms ≈ 320ms 在途窗口（无 image delay），REST cancel 有充足确定性窗口。
  const boot = await bootE2ECancel({ acpFixtureEnv: { ACP_MOCK_DELAY_MS: '80' }, dispatchTimeoutMs: 400 })
  try {
    const hatched = await boot.post(`/v1/hives/${boot.hiveId}/members/hatch`, {
      name: 'w-acp',
      role: 'worker',
      backend: 'connector',
      connectorId: 'fixture-acp',
    })
    assert.equal(hatched.status, 200, `hatch: ${JSON.stringify(hatched.body)}`)
    const memberId = (hatched.body.data as { id: string }).id

    const ws = await boot.wsFacts()
    const created = await boot.post(`/v1/hives/${boot.hiveId}/tasks`, {
      subject: 'e2e-a-chain',
      prompt: 'please stream four chunks',
    })
    assert.equal(created.status, 200, `create task: ${JSON.stringify(created.body)}`)
    const taskId = (created.body.data as { id: string }).id

    // A2 派工 latch（WS 帧层）+ prompt 在途 latch（泵观察帧）。
    await ws.next('task/updated', (d) => digTask(d).id === taskId && digTask(d).status === 'in-progress', 6000)
    await waitFor(
      () => boot.memberStatuses.some((s) => s.memberId === memberId && s.status === 'working'),
      6000,
      `member '${memberId}' working via real ACP stream; statuses: ${JSON.stringify(boot.memberStatuses)}`,
    )

    // A1 REST 取消闭环。
    const res = await boot.post(`/v1/tasks/${taskId}/cancel`, { reason: 'e2e-a' })
    assert.equal(res.status, 202, `cancel status: ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal((res.body.data as { status?: string }).status, 'cancelled', `cancel data.status: ${JSON.stringify(res.body.data)}`)

    // A3 + J：cancel 之后到达的首个 task/updated 帧必须已是 cancelled（applyTask 先于 appendFact 的序列锁）。
    const frame = await ws.next(
      'task/updated',
      (d) => digTask(d).id === taskId && digTask(d).status === 'cancelled',
      6000,
    )
    assert.equal(digTask(frame.data).status, 'cancelled')
    assert.equal(typeof digTask(frame.data).updatedAt, 'number', `frame updatedAt: ${JSON.stringify(frame.data)}`)

    // A3 事实源：jsonl 恰好一行 task-cancelled，memberId 在场可审计。
    await waitFor(() => boot.countFact('task-cancelled') === 1, 6000, `single task-cancelled row; rows: ${JSON.stringify(boot.factPayloads('task-cancelled'))}`)
    assert.equal(boot.countFact('task-cancelled'), 1, `rows: ${JSON.stringify(boot.factRows())}`)
    // 现行真链事实载荷为 {type, taskId, reason, at}（memberId 不随事实落盘）——断言现链本体。
    const [row] = boot.factPayloads('task-cancelled')
    assert.equal(row.taskId, taskId, `row: ${JSON.stringify(row)}`)
    assert.equal(row.reason, 'e2e-a', `row: ${JSON.stringify(row)}`)

    // A5 成员终态：cancelled 派生 idle；**never failed、never finished**——
    // finished(done(0)) 出现即 cancel 未到达 mock，failed 出现即 143 误标。
    await waitFor(
      () => boot.memberStatuses.some((s) => s.memberId === memberId && s.status === 'idle' && boot.memberStatuses.indexOf(s) > boot.memberStatuses.findIndex((x) => x.memberId === memberId && x.status === 'working')),
      6000,
      `member back to idle after cancel; statuses: ${JSON.stringify(boot.memberStatuses)}`,
    )
    const seq = boot.memberStatuses.filter((s) => s.memberId === memberId).map((s) => s.status)
    assert.ok(seq.includes('working'), `expected working phase: ${JSON.stringify(seq)}`)
    assert.ok(!seq.includes('failed'), `member must never be failed: ${JSON.stringify(seq)}`)
    assert.ok(!seq.includes('finished'), `cancelled-derive must not end finished: ${JSON.stringify(seq)}`)

    // A3' 广播链：member/status idle 帧同样经 WS 涌出（subscribe 转发既有事件）。
    await ws.next('member/status', (d) => (d as { memberId?: string; status?: string }).memberId === memberId && (d as { status?: string }).status === 'idle', 6000)

    // A6 REST 回读幂等：cancelled + owner 清空（fold 不复活回归锁）。
    const reread = await boot.get(`/v1/hives/${boot.hiveId}/tasks/${taskId}`)
    assert.equal(reread.status, 200, `reread: ${JSON.stringify(reread.body)}`)
    assert.equal((reread.body.data as { status?: string }).status, 'cancelled')
    assert.equal((reread.body.data as { owner?: unknown }).owner, undefined, `owner must be cleared: ${JSON.stringify(reread.body.data)}`)

    // A7 看门狗清零：2.5× dispatchTimeoutMs 静默窗内无二发 cancel、无状态复活。
    await new Promise((r) => setTimeout(r, 400 * 2.5))
    assert.equal(boot.countFact('task-cancelled'), 1, `fact rows after quiet window: ${JSON.stringify(boot.factPayloads('task-cancelled'))}`)
    const after = await boot.get(`/v1/hives/${boot.hiveId}/tasks/${taskId}`)
    assert.equal((after.body.data as { status?: string }).status, 'cancelled', `after quiet window: ${JSON.stringify(after.body.data)}`)
    ws.close()
  } finally {
    await boot.close()
  }
})

test('E2E-G cancel × prompt 完成撞车：ACP 自取消锚点下状态收敛、单一事实行', { timeout: 60_000 }, async () => {
  // mock 自锚点：1 chunk 后自发 stopReason=cancelled（fixture 路径，非我方通知）；
  // REST cancel 与其撞车——无论谁先抵达，断言不变式必须确定成立（方案 §4）。
  const boot = await bootE2ECancel({ acpFixtureEnv: { ACP_MOCK_DELAY_MS: '25', ACP_MOCK_CANCEL_AFTER: '1' }, dispatchTimeoutMs: 400 })
  try {
    const hatched = await boot.post(`/v1/hives/${boot.hiveId}/members/hatch`, {
      name: 'w-acp-race',
      role: 'worker',
      backend: 'connector',
      connectorId: 'fixture-acp',
    })
    assert.equal(hatched.status, 200, `hatch: ${JSON.stringify(hatched.body)}`)
    const memberId = (hatched.body.data as { id: string }).id

    const created = await boot.post(`/v1/hives/${boot.hiveId}/tasks`, {
      subject: 'e2e-g-race',
      prompt: 'race me',
    })
    assert.equal(created.status, 200, `create task: ${JSON.stringify(created.body)}`)
    const taskId = (created.body.data as { id: string }).id

    await waitFor(
      () => boot.memberStatuses.some((s) => s.memberId === memberId && s.status === 'working'),
      6000,
      `member working; statuses: ${JSON.stringify(boot.memberStatuses)}`,
    )
    const res = await boot.post(`/v1/tasks/${taskId}/cancel`, { reason: 'e2e-g' })
    // 任一顺序下任务此刻必仍在 in-progress（任务终态只经 report；cancelled 事件不动任务）→ 202。
    assert.equal(res.status, 202, `cancel status: ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal((res.body.data as { status?: string }).status, 'cancelled')

    // 竞态不变式（方案 §4）：任一顺序恰好一行 task-cancelled；成员终态 idle；永不 failed/finished。
    await waitFor(() => boot.countFact('task-cancelled') === 1, 6000, `single task-cancelled row; rows: ${JSON.stringify(boot.factRows())}`)
    assert.equal(boot.countFact('task-cancelled'), 1, `rows: ${JSON.stringify(boot.factRows())}`)
    await waitFor(
      () => boot.memberStatuses.some((s) => s.memberId === memberId && s.status === 'idle' && boot.memberStatuses.indexOf(s) > boot.memberStatuses.findIndex((x) => x.memberId === memberId && x.status === 'working')),
      6000,
      `member idle after race; statuses: ${JSON.stringify(boot.memberStatuses)}`,
    )
    const seq = boot.memberStatuses.filter((s) => s.memberId === memberId).map((s) => s.status)
    assert.ok(!seq.includes('failed'), `member must never be failed: ${JSON.stringify(seq)}`)
    assert.ok(!seq.includes('finished'), `member must never be finished: ${JSON.stringify(seq)}`)
    const reread = await boot.get(`/v1/hives/${boot.hiveId}/tasks/${taskId}`)
    assert.equal((reread.body.data as { status?: string }).status, 'cancelled', `reread: ${JSON.stringify(reread.body.data)}`)
  } finally {
    await boot.close()
  }
})
