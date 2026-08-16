/**
 * 原生成员运行时（§6.2）：真实 DSH 会话 → honeycomb member。
 *
 * `agent-runtime`（connector）走的是「外部 CLI / ACI 包装」路径：spawn 子进程、
 * 解析其 stdout 事件。本模块是**编队原生路径**：honeycomb 作为插件跑在真实 dsh
 * harness 进程内，`ctx.agents` 就是 harness 装配的 core/agent AgentRegistry——
 * 这里的 `hatch` 会创建一个**同进程的真实 DSH 智能体会话**（有独立 session log、
 * 独立 inbox、由 agent-loop 驱动），指令经 `agent.followup()` 入队，会话事件
 * 经 `session/event` 全局事件回流，完成标记经 courier report 回写看板。
 *
 * 与 agent-runtime 的对照（详见 docs/native-runtime.md）：
 *
 * | 契约点        | agent-runtime（外部 ACI）     | native-runtime（DSH 原生）        |
 * |---------------|------------------------------|-----------------------------------|
 * | spawn         | spawn 外部 CLI 进程          | `ctx.agents.create()` 起真会话     |
 * | 指令          | stdin 写入                   | `agent.followup(UserMessage)`     |
 * | 事件回流      | 子进程 stdout → SessionEvent | `ctx.on('session/event')` 过滤     |
 * | 终端事件      | done(exitCode)               | turn/end{reason}                  |
 * | 完成回写      | （provider 待接线）          | marker 检测 → courier report      |
 *
 * 完成约定：dispatch 指令追加 NATIVE_DONE_MARKER；agent 收尾回答若以该标记结尾，
 * 运行时把标记后的文本作为报告落 courier（kind='report'），编排循环据此把任务
 * 置为 completed，实现「完成回写」；turn/end 非 completed（error/aborted/blocked/
 * max-tokens/interrupted）→ 事件层发 failed 派生态 + 成员 work-state=blocked，
 * 不回 report——剩余由编排循环看门狗走 retry→failed 完成「失败转移」。
 *
 * 依赖注入：DSH agent 机制以**结构契约**描述（{@link DshAgentsRegistry} 等），
 * 不 import harness 包；真实运行时由 dsh harness 在 `ctx.agents` 上装配同名形状。
 *
 * @module @whalepod/honeycomb/runtime/native-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Member } from '../types'
import { makeId } from '../util'
import type {
  MemberRuntime,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeHatchInput,
  RuntimeMessage,
} from './registry'

// ---------------------------------------------------------------------------
// DSH agent 机制：honeycomb 侧的结构契约
// （真实形状 = dsh harness 的 core/agent AgentRegistry + core/session 会话事件）
// ---------------------------------------------------------------------------

export interface DshAgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
}

export interface DshCreateAgentOptions {
  /** 会话 id：agent registry 与 session log 共享的单一体面。 */
  sessionId: string
  /** 创建时落进会话的元数据（面板/复盘可见）。 */
  meta?: Record<string, unknown>
  agentOptions?: DshAgentOptions
  /** 预置初始消息（本运行时不用，保留契约等位）。 */
  seed?: unknown[]
  signal?: AbortSignal
}

export interface DshTextBlock {
  type: 'text'
  text: string
}

export interface DshUserMessage {
  id: string
  role: 'user'
  content: DshTextBlock[]
  source?: { kind: string; plugin?: string }
}

export interface DshAgent {
  readonly id: string
  readonly status: 'idle' | 'running'
  /** 入队一个普通 follow-up turn 并唤醒 loop。 */
  followup(message: DshUserMessage): void
  /** 当前无活跃 driver 时 resolve。 */
  whenIdle(): Promise<void>
  cancel(cause?: string, options?: { keepInbox?: boolean }): void
  /** 持久会话（事件日志即真相源）。 */
  readonly session: { readonly id: string; readonly events: readonly unknown[] }
}

export interface DshAgentHandle {
  agent: DshAgent
  /** 停 loop/注销/清会话。 */
  dispose(): Promise<void>
}

export interface DshAgentsRegistry {
  create(options: DshCreateAgentOptions): Promise<DshAgentHandle>
  list(): readonly DshAgent[]
  get(sessionId: string): DshAgent | undefined
}

/** DSH turn 结束原因（core/session turn/end data.reason）。 */
export type DshTurnEndReason =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'

export interface DshSessionEvent {
  type: string
  data?: Record<string, unknown>
}

/** 全局事件输入（core/session event 声明为 (session, event)）。 */
export interface DshSessionEventSubject {
  readonly id: string
}

// ---------------------------------------------------------------------------
// 完成/失败约定
// ---------------------------------------------------------------------------

export const NATIVE_DONE_MARKER = '<task-done/>'

export function isDshTurnEnd(
  event: DshSessionEvent | undefined,
  turn: { data: { turn: number; reason?: string } },
): turn is { data: { turn: number; reason: DshTurnEndReason } } {
  return event?.type === 'turn/end' && typeof turn.data.reason === 'string'
}

export interface NativeRuntimeOptions {
  /** agent 收尾回答的完成标记（默认 `<task-done/>`）。 */
  doneMarker?: string
  /** 覆盖 agentLoop 的 provider/model（一般由 member.model / env 决定）。 */
  agentOptions?: DshAgentOptions
  /** 事件泵队列上限（防事件堆积）。 */
  queueLimit?: number
  /** 会话事件订阅名（测试可替换；真实 harness = `session/event`）。 */
  sessionEventName?: string
  /** report 的会话引用前缀（默认 `session://`）。 */
  sessionRefPrefix?: string
}

const DEFAULT_QUEUE_LIMIT = 256

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/** 从 assistant 消息事件提取纯文本（真实 harness 形状：data.message 为
 *  AssistantMessage 对象 `{ content: ContentBlock[] }`；兼容旧的数组形状）。 */
function textOf(event: DshSessionEvent): string | undefined {
  const data = event.data
  if (!data) return undefined
  const message = data['message'] as { content?: unknown } | undefined
  if (!message || Array.isArray(message)) return undefined
  const content = message.content
  if (!Array.isArray(content)) return undefined
  return (content as DshTextBlock[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function pickAgentOptions(member: Member, env: Record<string, string>): DshAgentOptions | undefined {
  const opts: DshAgentOptions = {}
  if (member.model) opts.model = member.model
  if (env['DSH_PROVIDER']) opts.provider = env['DSH_PROVIDER']
  if (env['DSH_MODEL']) opts.model = env['DSH_MODEL']
  return opts.model || opts.provider ? opts : undefined
}

/** 把派工指令包装成带完成约定的 prompt（不碰编排循环本体）。 */
export function buildNativeDirective(content: string, marker: string): string {
  return `${content}\n\n完成后请以 ${marker} 结尾收尾回答。`
}

/** 从收尾回答（已含 marker）提取报告文本。 */
export function extractReportText(fullText: string, marker: string): string {
  const idx = fullText.indexOf(marker)
  if (idx < 0) return fullText.trim()
  const tail = fullText.slice(idx + marker.length).trim()
  return tail.length > 0 ? tail : fullText.slice(0, idx).trim()
}

/**
 * 装配原生成员运行时（id='native'）。注册后，roster 中 `backend='native'`
 * 的成员经 {@link RosterService.hatch} 孵化即得到真实 DSH 会话句柄。
 */
export function createNativeRuntime(options: NativeRuntimeOptions = {}): MemberRuntime {
  const doneMarker = options.doneMarker ?? NATIVE_DONE_MARKER
  const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT
  const sessionEventName = options.sessionEventName ?? 'session/event'
  const sessionRef = (id: string) => `${options.sessionRefPrefix ?? 'session://'}${id}`

  return {
    id: 'native',

    async hatch(
      ctx: Context,
      input: RuntimeHatchInput,
    ): Promise<RuntimeHandle> {
      const agents = (ctx as unknown as { agents?: DshAgentsRegistry }).agents
      if (!agents || typeof agents.create !== 'function') {
        throw new Error(
          '[native-runtime] ctx.agents 不是 DSH AgentRegistry（缺少 create）——native 成员只能在真实 dsh harness 内运行',
        )
      }
      void agents // 结构校验通过即可；create 下方调用

      const { member } = input
      const sessionId = makeId('session')
      const registry = (ctx as unknown as { agents: DshAgentsRegistry }).agents

      // 1) 起真实 DSH 会话
      const handle = await registry.create({
        sessionId,
        meta: { honeycomb: { memberId: member.id, hiveId: member.hiveId } },
        agentOptions: options.agentOptions ?? pickAgentOptions(member, input.env),
      })
      const agent = handle.agent

      // 事件泵：queue 供 events() 消费
      let disposed = false
      const queue: RuntimeEvent[] = []
      const waiters: Array<() => void> = []
      const push = (type: string, payload?: unknown) => {
        if (queue.length >= queueLimit) queue.shift()
        queue.push({ type, ...(payload !== undefined ? { payload } : {}) })
        waiters.splice(0).forEach((w) => w())
      }

      // 单次 dispatch 的归约状态
      let awaitingReport = false
      let lastTurn = -1
      let lastAssistantText = ''
      let sawToolCall = false

      const onSessionEvent = (subject: DshSessionEventSubject, event: DshSessionEvent) => {
        if (!subject || subject.id !== sessionId) return
        const data = event.data ?? {}

        switch (event.type) {
          case 'turn/start':
            lastTurn = typeof data['turn'] === 'number' ? (data['turn'] as number) : lastTurn
            lastAssistantText = ''
            sawToolCall = false
            if (awaitingReport) push('stream', { turn: lastTurn })
            break

          case 'step/start':
            if (awaitingReport) push('stream', { step: data['step'] })
            break

          case 'tool/call':
            sawToolCall = true
            push('tool-call', { name: data['toolCall'] ?? data['name'], turn: lastTurn })
            break

          case 'tool/result':
            push('tool-result', { name: data['toolCall'] ?? data['name'], turn: lastTurn })
            break

          case 'assistant/message': {
            const text = textOf(event)
            if (text !== undefined) {
              lastAssistantText = text
              if (awaitingReport) push('stream', { text })
            }
            break
          }

          case 'approval/requested':
            push('approval-request', { kind: data['kind'], turn: lastTurn })
            break

          case 'turn/end': {
            const reason = data['reason'] as DshTurnEndReason | undefined
            if (!reason || !awaitingReport) break

            if (reason === 'completed') {
              // 完成回写：收尾回答含完成标记 → 发 courier report
              const reportText = extractReportText(lastAssistantText, doneMarker)
              if (lastAssistantText.includes(doneMarker)) {
                push('done', { turn: lastTurn, sessionId, report: reportText })
                // 报告落账（kind='report' → 编排循环 handleReport → completed）
                void ctx.courier
                  .send(member.hiveId, {
                    from: member.id,
                    to: 'all',
                    kind: 'report',
                    content: reportText,
                    summary: reportText.slice(0, 200),
                    attachments: [sessionRef(sessionId)],
                  })
                  .catch((err: unknown) => {
                    push('error', { turn: lastTurn, reason: 'report-failed', err: String(err) })
                  })
                awaitingReport = false
              } else {
                // turn 正常结束但没有完成标记 → 视为仍在工作，不报告（看门狗兜底）
                push('stream', { turn: lastTurn, note: 'idle-without-marker' })
              }
            } else {
              // 会话失败/中断 → 派生失败态 + 成员 blocked，不回 report
              push('error', { turn: lastTurn, reason, sessionId })
              void ctx.emit('member/work-state', {
                hiveId: member.hiveId,
                memberId: member.id,
                state: 'blocked',
                blockedReason: `native session turn/end=${reason} (${sessionId})`,
              })
            }
            break
          }

          default:
            break
        }
      }

      // 订阅（真实 harness 全局事件；不同 scope 事件自动带 subject）
      const listener = onSessionEvent as unknown as (...args: unknown[]) => void
      // cordis 语义：ctx.on 返回 disposer（register 产物），close/kill 时调用即卸载监听。
      const offSession = ctx.on(sessionEventName as never, listener as never) as () => void

      // 收尾逻辑（close/kill 共用）：卸载监听 → 唤醒全部等待者 → dispose 底层会话。
      // 不用 `this.close()`：对象字面量作为 async 函数返回值时 `this` 会被推成
      // `RuntimeHandle | PromiseLike<RuntimeHandle>` 联合类型，直接调用会 TS2339。
      const shutdown = async (): Promise<void> => {
        if (disposed) return
        disposed = true
        offSession()
        waiters.splice(0).forEach((w) => w())
        await handle.dispose()
      }

      return {
        sessionId,

        async send(message: RuntimeMessage): Promise<void> {
          if (disposed) throw new Error('[native-runtime] handle already closed')
          awaitingReport = true
          lastAssistantText = ''
          const text = buildNativeDirective(message.content, doneMarker)
          agent.followup({
            id: makeId('msg'),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: '@whalepod/honeycomb' },
          })
          push('stream', { sent: text.slice(0, 80) })
        },

        async *events(): AsyncIterable<RuntimeEvent> {
          while (!disposed) {
            if (queue.length > 0) {
              const ev = queue.shift()!
              yield ev
            } else {
              await new Promise<void>((resolve) => waiters.push(resolve))
            }
          }
        },

        async close(): Promise<void> {
          await shutdown()
        },

        async kill(): Promise<void> {
          if (disposed) return
          agent.cancel('killed by honeycomb orchestrator')
          await shutdown()
        },
      }
    },
  }
}
