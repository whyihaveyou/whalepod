/**
 * RosterService — 名册服务 (§6.1).
 *
 * 管理成员记录、孵化/遣散（§6.4）与运行时后端注册表（§6.2）。所有成员状态
 * 变更通过事实日志落地（`member-registered` / `member-status` /
 * `member-dismissed`），派生视图（`state`）不落库（§7.3）。
 *
 * 迁移到真实 cordis：实现形态由工厂函数改为 `Service` 子类（`super(ctx,
 * 'roster')` 自动注册 `ctx.roster`），公开接口与行为不变；`ctx.onDispose`
 * 映射为 `ctx.effect`。
 *
 * @module @whalepod/honeycomb/services/roster
 */

import { Service, type Context } from '@deepseek-ai/cordis'
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

export class HoneycombRosterService extends Service implements RosterService {
  private readonly fibers = new FiberHost()

  constructor(
    ctx: Context,
    private readonly store: FactStore,
    private readonly runtimes: RuntimeRegistry,
  ) {
    super(ctx, 'roster')
    // 迁移：ctx.onDispose(() => void fibers.disposeAll()) → ctx.effect(disposer)
    ctx.effect(() => () => void this.fibers.disposeAll(), '@whalepod/honeycomb/roster.dispose')
  }

  async register(hiveId: HiveId, input: RegisterMemberInput): Promise<Member> {
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
    await this.store.append(hiveId, { type: 'member-registered', member, at: ts })
    return member
  }

  async hatch(hiveId: HiveId, input: HatchMemberInput): Promise<Member> {
    const member = await this.register(hiveId, { ...input, role: input.role ?? 'worker' })
    this.ctx.emit('member/status', { hiveId, memberId: member.id, status: 'hatching' })

    const runtime = this.runtimes.get(input.backend)
    if (!runtime) {
      // 后端未注册：注册为被动槽位（无运行时），孵化视为 no-op。
      this.ctx.emit('member/hatched', { hiveId, member: this.store.member(member.id) ?? member })
      return this.store.member(member.id) ?? member
    }

    const cwd = input.cwd ?? this.store.hive(hiveId)?.workspace ?? ''
    try {
      const handle = await runtime.hatch(this.ctx, { member, cwd, env: {} })
      this.fibers.adopt(member.id, handle)
      await this.store.append(hiveId, {
        type: 'member-status',
        memberId: member.id,
        status: 'idle',
        at: now(),
      })
      this.ctx.emit('member/status', { hiveId, memberId: member.id, status: 'idle' })
    } catch (error) {
      await this.store.append(hiveId, {
        type: 'member-status',
        memberId: member.id,
        status: 'failed',
        at: now(),
      })
      this.ctx.emit('member/status', {
        hiveId,
        memberId: member.id,
        status: 'failed',
        note: error instanceof Error ? error.message : String(error),
      })
    }

    this.ctx.emit('member/hatched', { hiveId, member: this.store.member(member.id) ?? member })
    return this.store.member(member.id) ?? member
  }

  async list(hiveId: HiveId): Promise<Member[]> {
    return this.store.membersOf(hiveId).filter((member) => !this.store.isDismissed(member.id))
  }

  async get(_hiveId: HiveId, id: MemberId): Promise<Member | undefined> {
    return this.store.member(id)
  }

  async remove(hiveId: HiveId, id: MemberId): Promise<void> {
    await this.fibers.dispose(id)
    await this.store.append(hiveId, { type: 'member-dismissed', memberId: id, at: now() })
    this.ctx.emit('member/dismissed', { hiveId, memberId: id })
  }

  async rename(hiveId: HiveId, id: MemberId, name: string): Promise<void> {
    if (!this.store.member(id)) throw new Error(`member not found: ${id}`)
    await this.store.append(hiveId, { type: 'member-renamed', memberId: id, name, at: now() })
  }

  async dismiss(hiveId: HiveId, id: MemberId): Promise<void> {
    await this.fibers.dispose(id)
    await this.store.append(hiveId, { type: 'member-dismissed', memberId: id, at: now() })
    this.ctx.emit('member/dismissed', { hiveId, memberId: id })
  }

  async state(_hiveId: HiveId, id: MemberId): Promise<MemberStateView> {
    const member = this.store.member(id)
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
  }

  registerRuntime(runtime: MemberRuntime): void {
    this.runtimes.register(runtime)
  }

  listRuntimes(): MemberRuntime[] {
    return this.runtimes.list()
  }

  async sendTo(_hiveId: HiveId, id: MemberId, message: RuntimeMessage): Promise<boolean> {
    const fiber = this.fibers.get(id)
    if (!fiber?.handle) return false
    await fiber.handle.send(message)
    return true
  }
}
