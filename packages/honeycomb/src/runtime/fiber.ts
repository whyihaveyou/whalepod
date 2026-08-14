/**
 * Fiber 托管（§6.4）.
 *
 * 每个已孵化成员对应一个 Fiber，承载其 {@link RuntimeHandle}，并负责
 * `hatch` / `dismiss` 时的启动与回收。生命周期 `pending → loading → active →
 * disposed` 在概念级实现里收敛为 `active` / `disposed` 两态；`ctx.effect` /
 * `ctx.onDispose` 关闭宿主上下文时统一回收所有 Fiber。
 *
 * @module @dfh/honeycomb/runtime/fiber
 */

import { makeId } from '../framework'
import type { MemberId } from '../types'
import type { RuntimeHandle } from './registry'

export type FiberState = 'pending' | 'loading' | 'active' | 'disposed'

export interface Fiber {
  readonly id: string
  readonly memberId: MemberId
  state: FiberState
  readonly handle: RuntimeHandle | undefined
  dispose(): Promise<void>
}

/** Manages Fiber lifecycle per member. */
export class FiberHost {
  private readonly fibers = new Map<MemberId, Fiber>()

  /** Adopt a runtime handle into a Fiber for a member (replacing any prior one). */
  adopt(memberId: MemberId, handle: RuntimeHandle): Fiber {
    const existing = this.fibers.get(memberId)
    if (existing) void existing.dispose()

    const fiber: Fiber = {
      id: makeId('fiber'),
      memberId,
      state: 'active',
      handle,
      dispose: async () => {
        if (fiber.state === 'disposed') return
        fiber.state = 'disposed'
        try {
          await handle.close()
        } catch {
          // close is best-effort
        }
        this.fibers.delete(memberId)
      },
    }
    this.fibers.set(memberId, fiber)
    return fiber
  }

  get(memberId: MemberId): Fiber | undefined {
    return this.fibers.get(memberId)
  }

  async dispose(memberId: MemberId): Promise<void> {
    const fiber = this.fibers.get(memberId)
    if (fiber) await fiber.dispose()
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.fibers.values()].map((fiber) => fiber.dispose()))
  }
}
