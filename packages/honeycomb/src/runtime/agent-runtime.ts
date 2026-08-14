/**
 * AgentSession 胶水层 —— 让「外部 CLI agent 会话」驱动一个 Worker 成员 (§6.3)。
 *
 * 本模块实现 {@link MemberRuntime}，把 connectors 侧的 {@link AgentAdapter} /
 * {@link AgentSession} 挂接进 honeycomb 框架：
 *
 *  - `hatch(ctx, { member, cwd, env })`：
 *      1. 依 `member.connectorId` 经 `resolveAdapter` 取得 {@link AgentAdapter}；
 *      2. 调用 `adapter.spawnSession({ cwd, env })` 拉起一个 {@link AgentSession}；
 *      3. 返回一个把该会话包装成 {@link RuntimeHandle} 的句柄。
 * - 会话侧事件归一化：把 {@link SessionEvent} 映射成 {@link RuntimeEvent}，
 *   并同步驱动成员 `member/status` / `member/work-state` 转移。
 * - 下行输入：编排循环对句柄调用 `send(RuntimeMessage)` → 转发为
 *   {@link AgentSession.send} 的 stdin 输入（即 courier 派工 ↓ 会话）。
 *
 * 约定：本胶水**只依赖 {@link AgentAdapter}/{@link AgentSession} 稳定接口**，
 * 不触碰 connectors/ 内部实现（spawnSession 正由连接器-Pro 并行回填）。
 * AgentAdapter 的解析通过构造注入的 `resolveAdapter` 完成，避免把 honeycomb
 * 的 Context 与 connectors 的 Cordis 上下文耦合在一起。
 *
 * @module @dfh/honeycomb/runtime/agent-runtime
 */

import type { Context } from '../framework'
import type { Member, MemberStatus, WorkState } from '../types'
import type {
  MemberRuntime,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeHatchInput,
  RuntimeMessage,
} from './registry.ts'
import type { AgentAdapter, AgentSession } from '../connectors/adapter.ts'
import type { SessionEvent, SpawnContext } from '../connectors/types.ts'

/**
 * 解析一个 connector id 到其 {@link AgentAdapter}。
 * 由装配方把 connectors 注册表（或一个 resolve 函数）注入进来。
 */
export type AdapterResolver = (connectorId: string) => AgentAdapter | undefined

/** {@link AgentSession} 工厂，可注入以便测试（默认走 `adapter.spawnSession`）。 */
export type SessionFactory = (
  adapter: AgentAdapter,
  spawn: SpawnContext,
) => Promise<AgentSession>

/** AgentSession 胶层的构造选项。 */
export interface AgentRuntimeOptions {
  /** connector id → AgentAdapter 解析器（必填）。 */
  resolveAdapter: AdapterResolver
  /** 会话工厂（可注入；缺省用 `adapter.spawnSession`）。 */
  createSession?: SessionFactory
}

/** 从会话事件推导出的工作状态。 */
export type DerivedWorkState = 'working' | 'finished' | 'failed' | 'idle'

/**
 * 把 {@link SessionEvent} 映射到成员工作状态的纯函数。
 *
 * 返回供调用方驱动 `member/work-state` 转移用的状态：
 *  - `stream` / `tool-call` / `approval-request` → **working**
 *  - `tool-result`             → working（工具执行结果仍在工作上下文内）
 *  - `done`（exitCode === 0）  → **finished**
 *  - `done`（exitCode !== 0）  → **failed**
 *  - `error`                   → **failed**
 *
 * @returns `null` 表示该事件不改变工作状态。
 */
export function deriveWorkState(event: SessionEvent): DerivedWorkState | null {
  switch (event.type) {
    case 'stream':
    case 'tool-call':
    case 'tool-result':
    case 'approval-request':
      return 'working'
    case 'done':
      return event.exitCode === 0 ? 'finished' : 'failed'
    case 'error':
      return 'failed'
  }
}

/** 会话派生状态 → {@link MemberStatus}（对外名册视角）。 */
export function workStateToMemberStatus(state: DerivedWorkState): MemberStatus {
  switch (state) {
    case 'working':
      return 'working'
    case 'finished':
      return 'finished'
    case 'failed':
      return 'failed'
    case 'idle':
      return 'idle'
  }
}

/**
 * 会话派生状态 → 框架原始 {@link WorkState}（底层队列状态机视角）。
 */
export function workStateToFrameworkState(state: DerivedWorkState): WorkState {
  switch (state) {
    case 'working':
      return 'running'
    case 'finished':
      return 'idle'
    case 'failed':
      return 'blocked'
    case 'idle':
      return 'idle'
  }
}

/**
 * 归一化一个 {@link SessionEvent} 为框架的 {@link RuntimeEvent}。
 */
export function normalizeSessionEvent(event: SessionEvent): RuntimeEvent {
  switch (event.type) {
    case 'stream':
      return { type: 'stream', payload: { chunk: event.chunk } }
    case 'tool-call':
      return { type: 'tool-call', payload: { id: event.id, name: event.name, arguments: event.arguments } }
    case 'tool-result':
      return { type: 'tool-result', payload: { id: event.id, content: event.content } }
    case 'approval-request':
      return { type: 'approval-request', payload: { id: event.id, prompt: event.prompt } }
    case 'done':
      return { type: 'done', payload: { exitCode: event.exitCode } }
    case 'error':
      return { type: 'error', payload: { message: event.message } }
  }
}

/**
 * 外部 CLI agent 会话的 {@link RuntimeHandle} 包装。
 */
class AgentSessionHandle implements RuntimeHandle {
  readonly sessionId: string
  private state: DerivedWorkState = 'idle'

  constructor(
    private readonly ctx: Context,
    private readonly member: Member,
    private readonly session: AgentSession,
  ) {
    this.sessionId = session.sessionId
    // 启动即拉参会话事件流，副作用是驱动成员状态转移。
    void this.pump()
  }

  /** 把 courier 下行输入转发为会话 stdin。 */
  async send(message: RuntimeMessage): Promise<void> {
    await this.session.send({ content: message.content })
  }

  /** 暴露归一化后的事件流（供编排循环路由回声）。 */
  async *events(): AsyncIterable<RuntimeEvent> {
    for await (const raw of this.session.events) {
      yield normalizeSessionEvent(raw)
    }
  }

  async close(): Promise<void> {
    await this.session.close()
  }

  async kill(): Promise<void> {
    await this.session.kill()
  }

  /** 后台抽干底部会话事件，并据此驱动成员状态。 */
  private async pump(): Promise<void> {
    try {
      for await (const event of this.session.events) {
        const derived = deriveWorkState(event)
        if (derived && derived !== this.state) {
          this.state = derived
          this.emitStatus(derived, event)
        }
        // Stream 等事件已通过 handle.events() 暴露，这里不重复转发。
      }
    } catch (err) {
      this.emitStatus('failed', { type: 'error', message: String(err) })
    }
  }

  private emitStatus(derived: DerivedWorkState, event: SessionEvent): void {
    const status = workStateToMemberStatus(derived)
    this.ctx.emit('member/status', {
      hiveId: this.member.hiveId,
      memberId: this.member.id,
      status,
      note: statusEventNote(event),
    })
    this.ctx.emit('member/work-state', {
      hiveId: this.member.hiveId,
      memberId: this.member.id,
      state: workStateToFrameworkState(derived),
      blockedReason: event.type === 'error' ? event.message : undefined,
    })
  }
}

/** 为状态转移事件生成一条可读备注。 */
function statusEventNote(event: SessionEvent): string | undefined {
  if (event.type === 'error') return `agent session error: ${event.message}`
  if (event.type === 'done') return `agent session exited with code ${event.exitCode}`
  return undefined
}

/**
 * 外部 CLI connector 成员的运行时后端。
 *
 * ```ts
 * const runtime = new AgentSessionRuntime({ resolveAdapter: reg.resolve.bind(reg) })
 * registry.register(runtime) // id = 'connector'
 * ```
 */
export class AgentSessionRuntime implements MemberRuntime {
  readonly id = 'connector'
  private readonly createSession: SessionFactory

  constructor(private readonly options: AgentRuntimeOptions) {
    this.createSession =
      options.createSession ?? ((adapter, spawn) => adapter.spawnSession(spawn))
  }

  async hatch(ctx: Context, input: RuntimeHatchInput): Promise<RuntimeHandle> {
    const { member, cwd, env } = input
    const connectorId = member.connectorId
    if (!connectorId) {
      throw new Error(`member ${member.id} has no connectorId — cannot spawn a CLI agent session`)
    }

    const adapter = this.options.resolveAdapter(connectorId)
    if (!adapter) {
      throw new Error(`no adapter resolved for connector '${connectorId}'`)
    }

    const session = await this.createSession(adapter, { cwd, env })
    return new AgentSessionHandle(ctx, member, session)
  }
}
