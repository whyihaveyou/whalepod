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

test('工具函数：buildNativeDirective / extractReportText', () => {
  const d = buildNativeDirective('执行任务 t', NATIVE_DONE_MARKER)
  assert.ok(d.includes('执行任务 t'))
  assert.ok(d.includes(NATIVE_DONE_MARKER))

  assert.equal(extractReportText(`${NATIVE_DONE_MARKER} 结果A`, NATIVE_DONE_MARKER), '结果A')
  assert.equal(extractReportText('无标记文本', NATIVE_DONE_MARKER), '无标记文本')
  assert.equal(extractReportText(`${NATIVE_DONE_MARKER} `, NATIVE_DONE_MARKER), '')
})