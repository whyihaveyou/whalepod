/**
 * cancel ⑦ E2E · stdio 降级路径（docs/cancel-e2e-plan.md §2.2）。
 *
 * 真实降级串行链：会话无 cancel → AgentSessionHandle.cancel → gracefulCloseWithTimeout
 * → close() → done(exitCode 143) → cancelInProgress 区分 → idle 不误标 failed。
 * stdio 协议本身无 cancelled 事件——断言序列里严禁出现 cancelled 事件断言（方案 §2.2）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootE2ECancel, waitFor, digTask, ScriptedNoCancelSession, scriptedNoCancelAdapter } from './helpers/e2e-cancel-boot'

test('E2E-stdio 降级全链路：REST cancel → close+优雅窗 → done(143) 不误标 failed', { timeout: 60_000 }, async () => {
  const session = new ScriptedNoCancelSession()
  const boot = await bootE2ECancel({ extraAdapters: [scriptedNoCancelAdapter(session)], dispatchTimeoutMs: 400 })
  try {
    const hatched = await boot.post(`/v1/hives/${boot.hiveId}/members/hatch`, {
      name: 'w-stdio',
      role: 'worker',
      backend: 'connector',
      connectorId: 'fixture-stdio',
    })
    assert.equal(hatched.status, 200, `hatch: ${JSON.stringify(hatched.body)}`)
    const memberId = (hatched.body.data as { id: string }).id

    const ws = await boot.wsFacts()
    const created = await boot.post(`/v1/hives/${boot.hiveId}/tasks`, {
      subject: 'e2e-stdio-chain',
      prompt: 'stdio in-flight task',
    })
    assert.equal(created.status, 200, `create task: ${JSON.stringify(created.body)}`)
    const taskId = (created.body.data as { id: string }).id

    // 派工 latch：WS 帧 + 真实 send 到达脚本会话（装配层观察点）。
    await ws.next('task/updated', (d) => digTask(d).id === taskId && digTask(d).status === 'in-progress', 6000)
    await waitFor(() => session.sendCount === 1, 4000, `scripted session send reached; sendCount=${session.sendCount}`)

    // REST cancel → 降级 close 链。
    const res = await boot.post(`/v1/tasks/${taskId}/cancel`, { reason: 'e2e-stdio' })
    assert.equal(res.status, 202, `cancel status: ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal((res.body.data as { status?: string }).status, 'cancelled')

    // 降级链落点三闸（胶水近场断言 + 序列闸）：
    // ① 胶水 cancel 真实跑过——cancelInProgress 标志置位 + 会话 close() 被调（装配观察点）；
    // ② 143 改写闸——若改写失败，状态 idle→failed 属跳变必发帧：序列永不含 failed/finished 即改写成立；
    //    （状态已为 idle 时 idle→idle 被泵 dedup 不重复发帧，故不锚「第二个 idle 帧」）。
    await waitFor(
      () => (boot.runtimes.handleFor(memberId) as { isCancelInProgress?: () => boolean } | undefined)?.isCancelInProgress?.() === true,
      4000,
      `glue cancel flag not set; handle=${JSON.stringify(!!boot.runtimes.handleFor(memberId))}`,
    )
    await waitFor(() => session.closedCount >= 1, 6000, `session close() not reached; closedCount=${session.closedCount}`)
    const seq = boot.memberStatuses.filter((s) => s.memberId === memberId).map((s) => s.status)
    assert.ok(seq.includes('idle'), `member idle baseline: ${JSON.stringify(seq)}`)
    assert.ok(!seq.includes('failed'), `done(143) must never surface as failed: ${JSON.stringify(seq)}`)
    assert.ok(!seq.includes('finished'), `done(143) must never surface as finished: ${JSON.stringify(seq)}`)

    // 事实层：单一 task-cancelled 行 + REST 回读幂等。
    await waitFor(() => boot.countFact('task-cancelled') === 1, 6000, `single task-cancelled row; rows: ${JSON.stringify(boot.factRows())}`)
    assert.equal(boot.countFact('task-cancelled'), 1)
    const reread = await boot.get(`/v1/hives/${boot.hiveId}/tasks/${taskId}`)
    assert.equal((reread.body.data as { status?: string }).status, 'cancelled', `reread: ${JSON.stringify(reread.body.data)}`)
    assert.equal((reread.body.data as { owner?: unknown }).owner, undefined, `owner cleared: ${JSON.stringify(reread.body.data)}`)

    // WS 广播链首帧时序（同 A/J）。
    const frame = await ws.next('task/updated', (d) => digTask(d).id === taskId && digTask(d).status === 'cancelled', 6000)
    assert.equal(digTask(frame.data).status, 'cancelled')
    ws.close()
  } finally {
    await boot.close()
  }
})
