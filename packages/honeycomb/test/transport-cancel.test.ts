/**
 * transport cancel 通道测试（#01a00581，任务停止按钮底座，cancel-lifecycle §3.6）。
 *
 * 验收四条（含两条加锁文档化语义）：
 *  ① 在途任务取消：POST /v1/tasks/{id}/cancel → 202 + 任务快照
 *     （status=cancelled、owner 清空）；编排循环发出 task-cancelled 事实
 *     （appendFact 捕获：type/taskId/memberId/reason）、roster.cancelTask
 *     优雅通道被触发；WS 订阅端从既有事实广播链收到 task/updated（不新增
 *     消息类型）。
 *  ② 不存在任务 → 409 TASK_NOT_FOUND。
 *  ③ 重复取消幂等：第二次 202 + 最新快照，不再二次写事实、不再二次触发
 *     roster.cancelTask。
 *  ④ 终态任务（completed）→ 409 TASK_TERMINAL。
 *  ⑤（加锁）backlog 任务 → 409 TASK_NOT_RUNNING（本端点只取消在途任务）。
 *  ⑥（加锁）编排循环未挂钩 → 503 ORCHESTRATION_UNAVAILABLE（其余路径不受影响）。
 *
 * 断言遵守测试断言铁律：精确匹配 + 失败 dump 实际值。
 * 全部确定性，无网络外联（127.0.0.1 随机端口）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

import {
  Context,
  apply,
  createNodeTransportServer,
  createOrchestrationLoop,
} from '../src/index'
import type { NodeTransportServerHandle } from '../src/index'

// ---------------------------------------------------------------------------
// 夹具 — boot transport + 装配编排循环（与生产一致：loop 与 transport 同乘
// 一个 ctx；transport 通过 options.transport.orchestration 挂钩 loop）
// ---------------------------------------------------------------------------

interface Harness {
  ctx: Context
  server: NodeTransportServerHandle
  baseUrl: string
  wsUrl: string
  /** appendFact 捕获的 task-cancelled 事实。 */
  facts: Array<{ hiveId: string; fact: any }>
  /** roster.cancelTask 优雅通道调用记录。 */
  rosterCancelCalls: Array<{ hiveId: string; memberId: string }>
}

async function boot(): Promise<Harness> {
  const ctx = new Context()
  const pDir = join(tmpdir(), `dfh-cancel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await apply(ctx, { persistenceDir: pDir })

  const roster = ctx.get('roster')
  const ledger = ctx.get('ledger')
  const facts: Harness['facts'] = []
  const rosterCancelCalls: Harness['rosterCancelCalls'] = []

  const loop = createOrchestrationLoop({
    ctx,
    roster: {
      list: (hiveId: string) => roster.list(hiveId),
      sendTo: async () => true,
      dismiss: (hiveId: string, memberId: string) => roster.dismiss(hiveId, memberId),
      cancelTask: async (hiveId: string, memberId: string) => {
        rosterCancelCalls.push({ hiveId, memberId })
      },
    },
    ledger: {
      list: (hiveId: string, filter?: any) => ledger.list(hiveId, filter),
    },
    applyTask: async (_hiveId: string, patch: any) => {
      await ledger.update(patch.taskId, {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        // owner: null → undefined 归一化（与 ledger.setOwner 一致）
        ...(patch.owner !== undefined ? { owner: patch.owner ?? undefined } : {}),
      } as any)
    },
    appendFact: async (hiveId: string, fact: any) => {
      facts.push({ hiveId, fact })
    },
    config: { idleTimeoutMs: 0, maxDispatchAttempts: 3, dispatchTimeoutMs: 600_000 },
  })

  const server = await createNodeTransportServer(ctx, {
    host: '127.0.0.1',
    port: 0,
    transport: { orchestration: loop },
  })
  return {
    ctx,
    server,
    baseUrl: `http://${server.host}:${server.port}`,
    wsUrl: `ws://${server.host}:${server.port}/ws`,
    facts,
    rosterCancelCalls,
  }
}

/** 不挂钩编排循环的对照夹具（验证 503 分支）。 */
async function bootWithoutOrchestration(): Promise<Pick<Harness, 'ctx' | 'server' | 'baseUrl'>> {
  const ctx = new Context()
  const pDir = join(tmpdir(), `dfh-cancel-noloop-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await apply(ctx, { persistenceDir: pDir })
  const server = await createNodeTransportServer(ctx, { host: '127.0.0.1', port: 0 })
  return { ctx, server, baseUrl: `http://${server.host}:${server.port}` }
}

// ---- REST 便捷封装（沿用 transport-http.test.ts 的 fetch 风格） -------------

async function post(baseUrl: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

async function patch(baseUrl: string, path: string, body: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`)
  return { status: res.status, body: await res.json() }
}

async function createHive(baseUrl: string, name: string): Promise<string> {
  const { status, body } = await post(baseUrl, '/v1/hives', { name, workspace: '/tmp/x' })
  assert.equal(status, 200, `createHive 失败: ${JSON.stringify(body)}`)
  assert.equal(body.ok, true)
  return body.data.id as string
}

async function createTask(baseUrl: string, hiveId: string, subject: string): Promise<string> {
  const { status, body } = await post(baseUrl, `/v1/hives/${hiveId}/tasks`, { subject })
  assert.equal(status, 200, `createTask 失败: ${JSON.stringify(body)}`)
  assert.equal(body.ok, true)
  return body.data.id as string
}

// ---- WS 便捷封装（沿用 transport-http.test.ts 的 waitForFrame 奶型） ---------

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
}

function waitForFrame(ws: WebSocket, match: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error(`timeout waiting for ws frame (${timeoutMs}ms)`))
    }, timeoutMs)
    function onMsg(data: WebSocket.RawData): void {
      let msg: any
      try {
        msg = JSON.parse(data.toString('utf8'))
      } catch {
        return
      }
      if (msg && match(msg)) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
  })
}

// ---------------------------------------------------------------------------
// ① 在途任务取消 —— 202 + 快照 + task-cancelled 事实 + roster.cancelTask + WS
// ---------------------------------------------------------------------------

test('① POST /v1/tasks/{id}/cancel — 在途任务：202 + cancelled 快照 + 事实 + 优雅通道 + WS task/updated', async () => {
  const { ctx, server, baseUrl, wsUrl, facts, rosterCancelCalls } = await boot()
  try {
    const hiveId = await createHive(baseUrl, 'cancel-hive')
    const taskId = await createTask(baseUrl, hiveId, 'long-running gen')

    // hold 态 dispatch：直接把任务标记为 in-progress + owner=w1
    // （等价于派工已被认领但 worker 被挂住；与生产 loop 派工后的快照同形）
    await ctx.get('ledger').update(taskId, { status: 'in-progress', owner: 'w1' } as any)

    // WS：订阅 hive（先 ack 后触发，消除竞态）
    const ws = new WebSocket(wsUrl)
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'subscribe', hiveId }))
    await waitForFrame(ws, (m) => m.type === 'subscribed' && m.hiveId === hiveId)
    // 挂「cancel 带来的 task/updated」等待（订阅在先、触发在后）
    const updatedFrame = waitForFrame(
      ws,
      (m) =>
        m.type === 'event' &&
        m.topic === 'task/updated' &&
        (m.payload as any).task.id === taskId &&
        (m.payload as any).task.status === 'cancelled',
    )

    // —— 触发 cancel ——
    const { status, body } = await post(baseUrl, `/v1/tasks/${taskId}/cancel`, {
      reason: 'stop mj generation',
    })

    // 响应：202 + 统一信封 + 任务快照（status=cancelled、owner 清空）
    assert.equal(status, 202, `期望 202，实际: ${status} body: ${JSON.stringify(body)}`)
    assert.equal(body.ok, true)
    assert.equal(body.data.id, taskId)
    assert.equal(body.data.status, 'cancelled', `实际快照: ${JSON.stringify(body.data)}`)
    assert.ok(
      !body.data.owner,
      `owner 应为空（undefined/null），实际: ${JSON.stringify(body.data.owner)}`,
    )

    // 事实：恰好一条 task-cancelled，字段齐全（memberId 只进事实做审计）
    assert.equal(facts.length, 1, `实际事实数: ${facts.length} ${JSON.stringify(facts)}`)
    const f = facts[0]
    assert.equal(f.hiveId, hiveId)
    assert.equal(f.fact.type, 'task-cancelled')
    assert.equal(f.fact.taskId, taskId)
    assert.equal(f.fact.memberId, 'w1')
    assert.equal(f.fact.reason, 'stop mj generation')
    assert.equal(typeof f.fact.at, 'number')

    // 优雅通道：roster.cancelTask 恰好触发一次（成员回 idle 的运行时触发面）
    assert.equal(rosterCancelCalls.length, 1, `实际: ${JSON.stringify(rosterCancelCalls)}`)
    assert.deepEqual(rosterCancelCalls[0], { hiveId, memberId: 'w1' })

    // WS 链：task/updated 推送到位（复用事实广播链，无新消息类型）
    const frame = await updatedFrame
    assert.equal(frame.hiveId, hiveId)
    assert.equal(frame.payload.task.id, taskId)
    assert.equal(frame.payload.task.status, 'cancelled')

    // REST 回读一致性（快照已 clean）
    const got = await get(baseUrl, `/v1/hives/${hiveId}/tasks/${taskId}`)
    assert.equal(got.body.data.status, 'cancelled')
    assert.ok(!got.body.data.owner, `回读 owner 应为空，实际: ${JSON.stringify(got.body.data)}`)

    ws.close()
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// ② 任务不存在 → 409 TASK_NOT_FOUND
// ---------------------------------------------------------------------------

test('② POST /v1/tasks/{id}/cancel — 任务不存在：409 TASK_NOT_FOUND', async () => {
  const { server, baseUrl } = await boot()
  try {
    const { status, body } = await post(baseUrl, '/v1/tasks/no-such-task/cancel', {
      reason: 'whatever',
    })
    assert.equal(status, 409, `期望 409，实际: ${status} body: ${JSON.stringify(body)}`)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'TASK_NOT_FOUND', `实际错误体: ${JSON.stringify(body.error)}`)
    assert.ok(
      body.error.message.includes('no-such-task'),
      `错误消息应包含任务 id，实际: ${body.error.message}`,
    )
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// ③ 重复取消幂等 —— 第二次 202 + 最新快照；不再二次写事实 / 触发优雅通道
// ---------------------------------------------------------------------------

test('③ POST /v1/tasks/{id}/cancel — 重复取消幂等：202 + 最新快照；事实与优雅通道各恰好一次', async () => {
  const { ctx, server, baseUrl, facts, rosterCancelCalls } = await boot()
  try {
    const hiveId = await createHive(baseUrl, 'cancel-hive')
    const taskId = await createTask(baseUrl, hiveId, 'repeat cancel')
    await ctx.get('ledger').update(taskId, { status: 'in-progress', owner: 'w2' } as any)

    const first = await post(baseUrl, `/v1/tasks/${taskId}/cancel`, { reason: 'first' })
    assert.equal(first.status, 202, `第一次: ${JSON.stringify(first.body)}`)
    assert.equal(first.body.data.status, 'cancelled')

    const second = await post(baseUrl, `/v1/tasks/${taskId}/cancel`, { reason: 'second' })
    assert.equal(second.status, 202, `第二次: ${JSON.stringify(second.body)}`)
    assert.equal(second.body.ok, true)
    assert.equal(second.body.data.id, taskId)
    assert.equal(second.body.data.status, 'cancelled', `实际快照: ${JSON.stringify(second.body.data)}`)

    // 幂等核心：事实与优雅通道均恰好一次（第二次不再二次触发）
    assert.equal(facts.length, 1, `实际事实数: ${facts.length} ${JSON.stringify(facts)}`)
    assert.equal(rosterCancelCalls.length, 1, `实际: ${JSON.stringify(rosterCancelCalls)}`)
    // 第二次的 reason 绝不应落进事实（第一次作的已不可变）
    assert.equal(facts[0].fact.reason, 'first', `实际 reason: ${facts[0].fact.reason}`)
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// ④ 终态任务（completed）→ 409 TASK_TERMINAL
// ---------------------------------------------------------------------------

test('④ POST /v1/tasks/{id}/cancel — 终态任务：409 TASK_TERMINAL', async () => {
  const { server, baseUrl, facts } = await boot()
  try {
    const hiveId = await createHive(baseUrl, 'cancel-hive')
    const taskId = await createTask(baseUrl, hiveId, 'already done')
    const done = await patch(baseUrl, `/v1/hives/${hiveId}/tasks/${taskId}`, {
      status: 'completed',
    })
    assert.equal(done.status, 200, `PATCH completed 失败: ${JSON.stringify(done.body)}`)

    const { status, body } = await post(baseUrl, `/v1/tasks/${taskId}/cancel`, {
      reason: 'too late',
    })
    assert.equal(status, 409, `期望 409，实际: ${status} body: ${JSON.stringify(body)}`)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'TASK_TERMINAL', `实际错误体: ${JSON.stringify(body.error)}`)
    assert.ok(
      body.error.message.includes('completed'),
      `错误消息应包含当前状态，实际: ${body.error.message}`,
    )
    // 终态取消绝不写事实
    assert.equal(facts.length, 0, `实际事实数: ${facts.length}`)
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// ⑤ backlog 任务 → 409 TASK_NOT_RUNNING（本端点只取消在途任务；文档锁定）
// ---------------------------------------------------------------------------

test('⑤ POST /v1/tasks/{id}/cancel — backlog 任务：409 TASK_NOT_RUNNING（文档语义锁定）', async () => {
  const { server, baseUrl, facts } = await boot()
  try {
    const hiveId = await createHive(baseUrl, 'cancel-hive')
    const taskId = await createTask(baseUrl, hiveId, 'queued only')

    const { status, body } = await post(baseUrl, `/v1/tasks/${taskId}/cancel`, {})
    assert.equal(status, 409, `期望 409，实际: ${status} body: ${JSON.stringify(body)}`)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'TASK_NOT_RUNNING', `实际错误体: ${JSON.stringify(body.error)}`)
    assert.ok(
      body.error.message.includes('backlog'),
      `错误消息应包含当前状态，实际: ${body.error.message}`,
    )
    assert.equal(facts.length, 0, `backlog 取消绝不写事实，实际: ${JSON.stringify(facts)}`)
  } finally {
    await server.close()
  }
})

// ---------------------------------------------------------------------------
// ⑥ 编排循环未挂钩 → 503 ORCHESTRATION_UNAVAILABLE（其余路径不受影响）
// ---------------------------------------------------------------------------

test('⑥ POST /v1/tasks/{id}/cancel — 未挂钩编排循环：503 ORCHESTRATION_UNAVAILABLE', async () => {
  const { ctx, server, baseUrl } = await bootWithoutOrchestration()
  try {
    const hiveId = await createHive(baseUrl, 'cancel-hive')
    const taskId = await createTask(baseUrl, hiveId, 'no loop attached')
    await ctx.get('ledger').update(taskId, { status: 'in-progress', owner: 'w9' } as any)

    const { status, body } = await post(baseUrl, `/v1/tasks/${taskId}/cancel`, {})
    assert.equal(status, 503, `期望 503，实际: ${status} body: ${JSON.stringify(body)}`)
    assert.equal(body.ok, false)
    assert.equal(
      body.error.code,
      'ORCHESTRATION_UNAVAILABLE',
      `实际错误体: ${JSON.stringify(body.error)}`,
    )

    // 其余路径不受影响：404/409 探测仍正常
    const nf = await post(baseUrl, '/v1/tasks/ghost/cancel', {})
    assert.equal(nf.status, 409)
    assert.equal(nf.body.error.code, 'TASK_NOT_FOUND', `实际错误体: ${JSON.stringify(nf.body.error)}`)
  } finally {
    await server.close()
  }
})