/**
 * RosterService — 名册服务 (§6.1).
 *
 * 管理成员记录、孵化/遣散（§6.4）与运行时后端注册表（§6.2）。所有成员状态
 * 变更通过事实日志落地（`member-registered` / `member-status` /
 * `member-dismissed`），派生视图（`state`）不落库（§7.3）。
 *
 * @module @dfh/honeycomb/services/roster
 */

import type { Context } from '../framework'
import { makeId, now } from '../util'
import type { FactStore } from '../persistence/store'
import type { MemberRuntime, RuntimeMessage, RuntimeRegistry } from '../runtime/registry'
import { FiberHost } from '../runtime/fiber'
import type {
  HatchMemberInput,
  HiveId,
  Member,
  MemberId,
  MemberStateView,
  MemberStatus,
  RegisterMemberInput,
  WorkState,
} from '../types'

export interface RosterService {
  register(hiveId: HiveId, input: RegisterMemberInput): Promise<Member>
  list(hiveId: HiveId): Promise<Member[]>
  get(hiveId: HiveId, id: MemberId): Promise<Member | undefined>
  remove(hiveId: HiveId, id: MemberId): Promise<void>
  rename(hiveId: HiveId, id: MemberId, name: string): Promise<void>
  hatch(hiveId: HiveId, input: HatchMemberInput): Promise<Member>
  dismiss(hiveId: HiveId, id: MemberId): Promise<void>
  state(hiveId: HiveId, id: MemberId): Promise<MemberStateView>
  /** Register a member runtime backend (§6.2). */
  registerRuntime(runtime: MemberRuntime): void
  listRuntimes(): MemberRuntime[]
  /**
   * Dispatch a message to a live member runtime handle (queen → worker).
   *
   * Reach the adopted {@link RuntimeHandle} and `send(RuntimeMessage)` —
   * the store/forward seam used by the orchestration loop. Returns `false`
   * when the member has no live runtime handle (dismissed / never hatched /
   * no backend), so the caller can treat it as a failed dispatch.
   */
  sendTo(hiveId: HiveId, id: MemberId, message: RuntimeMessage): Promise<boolean>
}

export interface RosterServiceDeps {
  store: FactStore
  runtimes: RuntimeRegistry
}

function deriveWorkState(status: MemberStatus): WorkState {
  switch (status) {
    case 'hatching':
      return 'starting'
    case 'working':
      return 'running'
    case 'failed':
      return 'blocked'
    case 'dormant':
      return 'paused'
    case 'idle':
    case 'finished':
      return 'idle'
  }
}

export function createRosterService(ctx: Context, deps: RosterServiceDeps): RosterService {
  const { store, runtimes } = deps
  const fibers = new FiberHost()
  ctx.onDispose(() => void fibers.disposeAll())

  async function register(hiveId: HiveId, input: RegisterMemberInput): Promise<Member> {
    const ts = now()
    const member: Member = {
      id: makeId('member'),
      hiveId,
      name: input.name,
      role: input.role ?? 'worker',
      backend: input.backend,
      connectorId: input.connectorId ?? null,
      status: 'idle',
      model: input.model,
      createdAt: ts,
      updatedAt: ts,
    }
    await store.append(hiveId, { type: 'member-registered', member, at: ts })
    return member
  }

  async function hatch(hiveId: HiveId, input: HatchMemberInput): Promise<Member> {
    const member = await register(hiveId, { ...input, role: input.role ?? 'worker' })
    ctx.emit('member/status', { hiveId, memberId: member.id, status: 'hatching' })

    const runtime = runtimes.get(input.backend)
    if (!runtime) {
      // 后端未注册：注册为被动槽位（无运行时），孵化视为 no-op。
      ctx.emit('member/hatched', { hiveId, member: store.member(member.id) ?? member })
      return store.member(member.id) ?? member
    }

    const cwd = input.cwd ?? store.hive(hiveId)?.workspace ?? ''
    try {
      const handle = await runtime.hatch(ctx, { member, cwd, env: {} })
      fibers.adopt(member.id, handle)
      await store.append(hiveId, { type: 'member-status', memberId: member.id, status: 'idle', at: now() })
      ctx.emit('member/status', { hiveId, memberId: member.id, status: 'idle' })
    } catch (error) {
      await store.append(hiveId, { type: 'member-status', memberId: member.id, status: 'failed', at: now() })
      ctx.emit('member/status', {
        hiveId,
        memberId: member.id,
        status: 'failed',
        note: error instanceof Error ? error.message : String(error),
      })
    }

    ctx.emit('member/hatched', { hiveId, member: store.member(member.id) ?? member })
    return store.member(member.id) ?? member
  }

  return {
    register,
    hatch,

    async list(hiveId) {
      return store.membersOf(hiveId).filter((member) => !store.isDismissed(member.id))
    },

    async get(_hiveId, id) {
      return store.member(id)
    },

    async remove(hiveId, id) {
      await fibers.dispose(id)
      await store.append(hiveId, { type: 'member-dismissed', memberId: id, at: now() })
      ctx.emit('member/dismissed', { hiveId, memberId: id })
    },

    async rename(hiveId, id, name) {
      if (!store.member(id)) throw new Error(`member not found: ${id}`)
      await store.append(hiveId, { type: 'member-renamed', memberId: id, name, at: now() })
    },

    async dismiss(hiveId, id) {
      await fibers.dispose(id)
      await store.append(hiveId, { type: 'member-dismissed', memberId: id, at: now() })
      ctx.emit('member/dismissed', { hiveId, memberId: id })
    },

    async state(_hiveId, id) {
      const member = store.member(id)
      if (!member) throw new Error(`member not found: ${id}`)
      const workState = deriveWorkState(member.status)
      return {
        memberId: id,
        status: member.status,
        workState,
        blockedReason: workState === 'blocked' ? 'runtime failed' : null,
        queued: { foreground: 0, background: 0 },
        activeTurnId: null,
      }
    },

    registerRuntime(runtime) {
      runtimes.register(runtime)
    },

    listRuntimes() {
      return runtimes.list()
    },

    async sendTo(_hiveId, id, message) {
      const fiber = fibers.get(id)
      if (!fiber?.handle) return false
      await fiber.handle.send(message)
      return true
    },
  }
}
