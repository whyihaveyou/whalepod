/**
 * MemberRuntime 命名注册表 + 运行时后端契约 (§6.2).
 *
 * `MemberRuntime` 是「孵化一个成员 → 拿到一个可收发消息的会话句柄」的统一
 * 契约。原生 agent 与外部 CLI connector 都实现它，按 `id` 注册进
 * {@link RuntimeRegistry}，再由 `RosterService.hatch` 按 `backend` 取用。
 *
 * @module @whalepod/honeycomb/runtime/registry
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
  /**
   * 优雅取消：给底层会话一个时间窗口（典型 30s）终止当前 in-flight 任务。
   * - 可选方法：未实现时调用方应降级 `close()` 或 `kill()`。
   * - 幂等：重复调用安全。
   * - best-effort：内部失败应吞掉（不向上抛错），让编排层继续回收路径。
   * - 与 `close()` 区别：`close()` 期望会话正常结束；`cancel()` 期望底层在收到
   *   协议级 cancel 后输出一条 cancelled 事件（或 done(exit≠0)），由胶水层据此
   *   把任务态从 failed 改回 idle。
   */
  cancel?(): Promise<void>
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
  /**
   * 已孵化成员的会话句柄索引（memberId → handle）。
   * - 装配方在 `hatch` 成功后必须调用 `trackHandle` 登记，否则 `cancelTask`
   *   找不到对应 handle，只能走 close()/kill() 兜底。
   * - 句柄在 close()/kill() 完成（或会话自然结束）后应 `untrackHandle`。
   */
  private readonly handles = new Map<string, RuntimeHandle>()

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

  // ---------- 句柄追踪（cancel 链路支撑）----------

  /** 登记一个已孵化句柄（同一 memberId 重复登记会覆盖旧句柄）。 */
  trackHandle(memberId: string, handle: RuntimeHandle): void {
    this.handles.set(memberId, handle)
  }

  /** 取一个句柄（未登记返回 undefined）。 */
  handleFor(memberId: string): RuntimeHandle | undefined {
    return this.handles.get(memberId)
  }

  /** 注销句柄（不影响 MemberRuntime 注册项；close/kill 后调用）。 */
  untrackHandle(memberId: string): void {
    this.handles.delete(memberId)
  }

  /**
   * 便捷方法 —— 对 `memberId` 对应 handle 发起优雅取消。
   * - 找不到句柄 → 返回 false
   * - 句柄没有 `cancel?()` 方法 → 返回 false（调用方应降级 `close()`/`kill()`）
   * - `handle.cancel()` 内部抛错 → 吞掉，返回 false（best-effort）
   * - 成功调用 → 返回 true
   *
   * 不阻塞调用方：失败/无句柄都立刻返回，不影响编排层 failDispatch 回收节奏。
   */
  async cancelTask(memberId: string): Promise<boolean> {
    const handle = this.handles.get(memberId)
    if (!handle) return false
    if (typeof handle.cancel !== 'function') return false
    try {
      await handle.cancel()
      return true
    } catch {
      return false
    }
  }
}
