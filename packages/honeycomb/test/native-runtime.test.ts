/**
 * native-runtime 单测：真实 DSH 会话驱动的成员运行时。
 *
 * 用 fake ctx（事件总线）+ fake agents 注册表（core/agent 形状）模拟 harness：
 * - hatch → ctx.agents.create 起会话；
 * - send → agent.followup(带完成约定的指令)；
 * - session 事件（turn/assistant/tool）经 'session/event' 泵回流；
 * - turn/end completed + 完成标记 → courier report（完成回写）；
 * - turn/end 非 completed → 成员 blocked + 事件失败态（失败转移交给看门狗）；
 * - close/kill → dispose/cancel 清理。
 *
 * @module @whalepod/honeycomb/runtime/native-runtime.test
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  buildNativeDirective,
  createNativeRuntime,
  extractReportText,
  NATIVE_DONE_MARKER,
  type DshAgentsRegistry,
  type DshAgent,
  type DshCreateAgentOptions,
  type DshSessionEvent,
  type DshUserMessage,
} from '../src/runtime/native-runtime'
import type { RuntimeHandle, RuntimeHatchInput } from '../src/runtime/registry'
import type { Member } from '../src/types'

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function makeMember(over: Partial<Member> = {}): Member {
  return {
    id: 'w1',
    hiveId: 'h1',
    name: 'native-worker-1',
    role: 'worker',
    backend: 'native',
    model: 'deepseek-chat',
    status: 'idle',
    queueSize: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

interface Emitted {
  name: string
  payload: unknown
}

class FakeCtx {
  listeners = new Set<(...args: unknown[]) => void>()
  emitted: Emitted[] = []

  on(_name: string, fn: (...args: unknown[]) => void): unknown {
    this.listeners.add(fn)
    return fn
  }

  off(_name: string, fn: (...args: unknown[]) => void): void {
    this.listeners.delete(fn)
  }

  emit(name: string, ...args: unknown[]): void {
    // 记录 emit（供断言 message/created、member/work-state）
    this.emitted.push({ name, payload: args.length === 1 ? args[0] : args })
    for (const fn of this.listeners) fn(...args)
  }
}

/** 真实 courier.send 的收缩版：补全 Message 字段后 emit 'message/created'
 * （真实服务还会 persist + waterfall，测试只关心事件落点与字段）。 */
function makeFakeCourier(ctx: FakeCtx) {
  return {
    async send(hiveId: string, message: Record<string, unknown>) {
      const persisted = {
        id: `msg_${ctx.emitted.length}`,
        hiveId,
        ...message,
        attachments: message.attachments ?? [],
        read: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      }
      ctx.emit('message/created', { message: persisted })
      return persisted
    },
    async deliver(): Promise<string> {
      return 'msg_fake'
    },
    async inbox() {
      return []
    },
  }
}

class FakeAgent implements DshAgent {
  status: 'idle' | 'running' = 'idle'
  disposed = false
  canceled: string | undefined
  cancelCalls = 0
  followups: DshUserMessage[] = []
  readonly session: { id: string; events: unknown[] }

  constructor(readonly id: string) {
    this.session = { id, events: [] }
  }

  followup(message: DshUserMessage): void {
    this.followups.push(message)
    this.status = 'running'
  }

  async whenIdle(): Promise<void> {
    this.status = 'idle'
  }

  cancel(cause?: string): void {
    this.cancelCalls++
    this.canceled = cause
    this.status = 'idle'
  }
}

function makeFakeRegistry() {
  const created: DshCreateAgentOptions[] = []
  const agents: FakeAgent[] = []
  const disposeCalls: string[] = []
  const registry: DshAgentsRegistry = {
    async create(options: DshCreateAgentOptions) {
      created.push(options)
      const agent = new FakeAgent(options.sessionId)
      agents.push(agent)
      return {
        agent,
        dispose: async () => {
          disposeCalls.push(agent.id)
          agent.disposed = true
        },
      }
    },
    list: () => agents,
    get: (sessionId: string) => agents.find((a) => a.id === sessionId),
  }
  return { registry, created, agents, disposeCalls }
}

async function setup() {
  const ctx = new FakeCtx()
  const rt = createNativeRuntime()
  const member = makeMember()
  const hatchInput: RuntimeHatchInput = { member, cwd: process.cwd(), env: process.env as Record<string, string> }
  const { registry, created, agents, disposeCalls } = makeFakeRegistry()
  ;(ctx as unknown as { agents: DshAgentsRegistry }).agents = registry
  // 挂上 courier 假服务（native-runtime 完成回写走 ctx.courier.send → emit message/created）
  ;(ctx as unknown as { courier: unknown }).courier = makeFakeCourier(ctx)

  const handle = await rt.hatch(ctx as never, hatchInput)
  const sessionId = handle.sessionId
  const fire = (event: DshSessionEvent) => {
    ;(ctx as FakeCtx).emit('session/event', { id: sessionId }, event)
  }
  const collect = async (h: RuntimeHandle) => {
    const events: unknown[] = []
    for await (const e of h.events()) {
      events.push(e)
      if (e.type === 'done' || e.type === 'error') break
    }
    return events
  }
  return { ctx, handle, sessionId, member, fire, collect, created, agents, disposeCalls }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('hatch：用真实 AgentRegistry 形状起会话（sessionId/meta/agentOptions）', async () => {
  const { created, sessionId, member } = await setup()
  assert.equal(created.length, 1)
  assert.ok(sessionId.startsWith('session_'))
  assert.equal(created[0].sessionId, sessionId)
  assert.deepEqual(created[0].meta, { honeycomb: { memberId: 'w1', hiveId: 'h1' } })
  // member.model → agentOptions.model
  assert.deepEqual(created[0].agentOptions, { model: 'deepseek-chat' })
  void member
})

test('hatch 守卫：ctx.agents 不是 AgentRegistry 时明确报错', async () => {
  const ctx = new FakeCtx()
  ;(ctx as unknown as { agents: unknown }).agents = { spawn: async () => ({}) }
  const rt = createNativeRuntime()
  await assert.rejects(
    () => rt.hatch(ctx as never, { member: makeMember(), cwd: '.', env: {} }),
    /ctx\.agents 不是 DSH AgentRegistry/,
  )
})

test('send：followup 携带带完成约定的指令', async () => {
  const { handle, agents } = await setup()
  await handle.send({ role: 'queen', content: '执行任务 t1: 测试' })
  assert.equal(agents[0].followups.length, 1)
  const text = agents[0].followups[0].content[0].text
  assert.ok(text.includes('执行任务 t1: 测试'))
  assert.ok(text.includes(NATIVE_DONE_MARKER))
  assert.equal(agents[0].followups[0].role, 'user')
  assert.equal(agents[0].followups[0].source?.plugin, '@whalepod/honeycomb')
})

test('完成回写：turn/end completed + 完成标记 → courier report（kind=report）', async () => {
  const { handle, fire, collect, ctx, member, sessionId } = await setup()
  await handle.send({ role: 'queen', content: '执行任务 tA' })

  const evPromise = collect(handle)
  fire({ type: 'turn/start', data: { turn: 1 } })
  fire({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成！' }] } } })
  fire({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: `${NATIVE_DONE_MARKER} 已生成报告 doc.md` }] } },
  })
  fire({ type: 'turn/end', data: { turn: 1, reason: 'completed' } })

  const events = await evPromise
  assert.ok(events.some((e) => (e as { type: string }).type === 'done'))

  const report = ctx.emitted.find((e) => e.name === 'message/created')
  assert.ok(report, '应 emit message/created')
  const msg = (report.payload as { message: Record<string, unknown> }).message
  assert.equal(msg.kind, 'report')
  assert.equal(msg.from, member.id)
  assert.equal(msg.hiveId, 'h1')
  assert.equal(msg.content, '已生成报告 doc.md') // 标记后的尾文本即报告
  assert.deepEqual(msg.attachments, [`session://${sessionId}`])
  void handle
})

test('无标记：turn/end completed 但收尾无完成标记 → 不发报告', async () => {
  const { handle, fire, ctx } = await setup()
  await handle.send({ role: 'queen', content: '执行任务 tB' })
  // 无标记路径不产生 done/error 终态（看门狗兜底），用有界 reader 收流
  const events: unknown[] = []
  const reader = (async () => {
    for await (const e of handle.events()) {
      events.push(e)
      if (events.length >= 4) break
    }
  })()
  fire({ type: 'turn/start', data: { turn: 1 } })
  fire({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '还在调研中……' }] } } })
  fire({ type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  await reader
  assert.ok(events.some((e) => (e as { type: string }).type === 'stream'))
  assert.ok(!ctx.emitted.some((e) => e.name === 'message/created'), '不应发 report')
  await handle.close()
})

test('失败转移：turn/end 非 completed → 成员 blocked + error 事件，不发 report', async () => {
  const { handle, fire, collect, ctx, member } = await setup()
  await handle.send({ role: 'queen', content: '执行任务 tC' })
  const evPromise = collect(handle)
  fire({ type: 'turn/start', data: { turn: 1 } })
  fire({ type: 'turn/end', data: { turn: 1, reason: 'error' } })

  const events = await evPromise
  assert.ok(events.some((e) => (e as { type: string }).type === 'error'))
  assert.ok(!ctx.emitted.some((e) => e.name === 'message/created'))
  const wstate = ctx.emitted.find((e) => e.name === 'member/work-state')
  assert.ok(wstate)
  const w = wstate.payload as Record<string, unknown>
  assert.equal(w.memberId, member.id)
  assert.equal(w.state, 'blocked')
  assert.ok(String(w.blockedReason).includes('turn/end=error'))
})

test('事件映射：turn/start/tool/approval 回流为 RuntimeEvent 流', async () => {
  const { handle, fire } = await setup()
  await handle.send({ role: 'queen', content: '任务 tD' })
  const events: unknown[] = []
  const reader = (async () => {
    for await (const e of handle.events()) {
      events.push(e)
      if (events.length >= 4) break
    }
  })()
  fire({ type: 'turn/start', data: { turn: 2 } })
  fire({ type: 'tool/call', data: { toolCall: { name: 'read_file' } } })
  fire({ type: 'approval/requested', data: { kind: 'shell' } })
  await reader
  const types = events.map((e) => (e as { type: string }).type)
  // send() 先回一个 sent 确认 stream，再依次是 turn/tool/approval 回流
  assert.deepEqual(types, ['stream', 'stream', 'tool-call', 'approval-request'])
  await handle.close()
})

test('kill：cancel + dispose 清理', async () => {
  const { handle, agents } = await setup()
  const agent = agents[0]
  await handle.kill()
  assert.ok(agent.canceled?.includes('killed'))
  assert.ok(agent.disposed)
  // kill 后事件流收尾（无挂起）
  for await (const _ of handle.events()) {
    assert.fail('kill 后不应再产出事件')
  }
})

test('close：解绑监听 + dispose', async () => {
  const { handle, agents, disposeCalls } = await setup()
  await handle.close()
  assert.ok(agents[0].disposed)
  assert.equal(disposeCalls.length, 1)
  await handle.close() // 幂等
  assert.equal(disposeCalls.length, 1)
})

test('cancel：在途 native 任务 → cancelled 事件 + 成员回收 idle（不误标 blocked）', async () => {
  const { handle, fire, ctx, member, agents } = await setup()
  await handle.send({ role: 'queen', content: '执行任务 tE' })
  const agent = agents[0]

  await handle.cancel()
  assert.equal(agent.cancelCalls, 1)
  assert.ok(agent.canceled?.includes('cancelled'), '应走 DSH 会话原生中断')

  // cancel-induced 终端（aborted 中断）→ cancelled 事件 + 成员 idle，而非 error + blocked
  const events: unknown[] = []
  const reader = (async () => {
    for await (const e of handle.events()) {
      events.push(e)
      if ((e as { type: string }).type === 'cancelled') break
    }
  })()
  fire({ type: 'turn/start', data: { turn: 1 } })
  fire({ type: 'turn/end', data: { turn: 1, reason: 'aborted' } })
  await reader

  const cancelled = events.find((e) => (e as { type: string }).type === 'cancelled')
  assert.ok(cancelled, '应产出 cancelled 事件')
  const payload = (cancelled as { payload?: Record<string, unknown> }).payload ?? {}
  assert.equal(payload.sessionId, handle.sessionId)

  const wstate = ctx.emitted.find((e) => e.name === 'member/work-state')
  assert.ok(wstate, '应 emit member/work-state')
  assert.equal((wstate.payload as Record<string, unknown>).state, 'idle', 'cancel-induced 中断 → idle，非 blocked')
  // 取消不产生完成回写（不发 report / message/created）
  assert.ok(!ctx.emitted.some((e) => e.name === 'message/created'))
  void member
})

test('cancel：任务已完成后再取消 → 不生效（无 cancelled、不污染后续派工）', async () => {
  const { handle, fire, ctx, agents, collect } = await setup()
  await handle.send({ role: 'queen', content: '执行任务 tF' })
  const evPromise = collect(handle)
  fire({ type: 'turn/start', data: { turn: 1 } })
  fire({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `${NATIVE_DONE_MARKER} 交付完成` }] } } })
  fire({ type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  const events = await evPromise
  assert.ok(events.some((e) => (e as { type: string }).type === 'done'))
  const agent = agents[0]
  const businessNames = ['member/work-state', 'message/created']
  const businessEmitCount = () => ctx.emitted.filter((e) => businessNames.includes(e.name)).length
  const emitsBefore = businessEmitCount()

  await handle.cancel() // 已完成任务上取消 → 语义 no-op

  // 既无 cancelled 事件（后续 aborted 终端也不产出），也无任何新 emit
  const events2: unknown[] = []
  const reader = (async () => {
    for await (const e of handle.events()) {
      events2.push(e)
      if ((e as { type: string }).type === 'tool-call') break
    }
  })()
  fire({ type: 'turn/end', data: { turn: 2, reason: 'aborted' } }) // awaitingReport 已消费 → 无产出
  fire({ type: 'tool/call', data: { toolCall: { name: 'probe' } } }) // 只用于终止有界 reader
  await reader
  assert.ok(!events2.some((e) => (e as { type: string }).type === 'cancelled'))
  assert.equal(businessEmitCount(), emitsBefore, 'cancel 已完成任务不应产生任何新业务 emit')
  assert.equal(agent.status, 'idle')

  // 新派工不受上次 cancel 污染：真失败仍按 error + blocked 处理
  await handle.send({ role: 'queen', content: '执行任务 tF2' })
  const evPromise2 = collect(handle)
  fire({ type: 'turn/start', data: { turn: 3 } })
  fire({ type: 'turn/end', data: { turn: 3, reason: 'error' } })
  const events3 = await evPromise2
  assert.ok(events3.some((e) => (e as { type: string }).type === 'error'))
  const wstate2 = ctx.emitted.filter((e) => e.name === 'member/work-state').at(-1)
  assert.ok(wstate2, '新派工失败应重新 emit member/work-state')
  assert.equal((wstate2.payload as Record<string, unknown>).state, 'blocked')
})

test('cancel：重复取消幂等（cancelInProgress 去重，只打一次底层）', async () => {
  const { handle, agents } = await setup()
  await handle.send({ role: 'queen', content: '执行任务 tG' })
  const agent = agents[0]

  await handle.cancel()
  await handle.cancel()
  await handle.cancel()
  assert.equal(agent.cancelCalls, 1, '重复 cancel 只打一次底层')
  assert.equal(agent.canceled, 'cancelled by honeycomb orchestrator')
  await handle.close()
})

test('工具函数：buildNativeDirective / extractReportText', () => {
  const d = buildNativeDirective('执行任务 t', NATIVE_DONE_MARKER)
  assert.ok(d.includes('执行任务 t'))
  assert.ok(d.includes(NATIVE_DONE_MARKER))

  assert.equal(extractReportText(`${NATIVE_DONE_MARKER} 结果A`, NATIVE_DONE_MARKER), '结果A')
  assert.equal(extractReportText('无标记文本', NATIVE_DONE_MARKER), '无标记文本')
  assert.equal(extractReportText(`${NATIVE_DONE_MARKER} `, NATIVE_DONE_MARKER), '')
})