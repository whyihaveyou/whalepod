/**
 * MemberRuntime 命名注册表 + 运行时后端契约 (§6.2).
 *
 * `MemberRuntime` 是「孵化一个成员 → 拿到一个可收发消息的会话句柄」的统一
 * 契约。原生 agent 与外部 CLI connector 都实现它，按 `id` 注册进
 * {@link RuntimeRegistry}，再由 `RosterService.hatch` 按 `backend` 取用。
 *
 * @module @dfh/honeycomb/runtime/registry
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Member } from '../types'

export interface RuntimeMessage {
  role: string
  content: string
}

export interface RuntimeEvent {
  type: string
  payload?: unknown
}

/** 一个已孵化成员的运行时会话句柄。 */
export interface RuntimeHandle {
  readonly sessionId: string
  send(message: RuntimeMessage): Promise<void>
  events(): AsyncIterable<RuntimeEvent>
  close(): Promise<void>
  kill(): Promise<void>
}

export interface RuntimeHatchInput {
  member: Member
  cwd: string
  env: Record<string, string>
}

/** 成员运行时后端契约（原生 agent / 外部 CLI connector 统一实现）。 */
export interface MemberRuntime {
  readonly id: string
  hatch(ctx: Context, input: RuntimeHatchInput): Promise<RuntimeHandle>
}

/** Named registry of member runtime backends (§6.2). */
export class RuntimeRegistry {
  private readonly entries = new Map<string, MemberRuntime>()

  register(runtime: MemberRuntime): void {
    this.entries.set(runtime.id, runtime)
  }

  get(id: string): MemberRuntime | undefined {
    return this.entries.get(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  list(): MemberRuntime[] {
    return [...this.entries.values()]
  }

  ids(): string[] {
    return [...this.entries.keys()]
  }
}
