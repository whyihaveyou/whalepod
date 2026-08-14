/**
 * MandateService — 授权服务 (§5.4).
 *
 * 决策 `mandate/decide` waterfall：默认策略由 queen/worker 角色决定；插件可在
 * waterfall 里审计/收紧/放行（返回新的 verdict 覆盖）。`allowOverrides: false`
 * 时忽略第三方覆盖，只用默认策略。
 *
 * @module @dfh/honeycomb/services/mandate
 */

import type { Context } from '../framework'
import { MandateDecide, type MandateDecidePayload } from '../events'
import type { ResolvedHoneycombConfig } from '../config'
import type { FactStore } from '../persistence/store'
import type { MandateAction, MandateGrant, MandateScope, Member, MemberId } from '../types'

export class MandateDeniedError extends Error {
  readonly actor: MemberId
  readonly action: MandateAction
  constructor(actor: MemberId, action: MandateAction, reason?: string) {
    super(reason ? `mandate denied: ${action} (${reason})` : `mandate denied: ${action}`)
    this.name = 'MandateDeniedError'
    this.actor = actor
    this.action = action
  }
}

export interface MandateService {
  can(actor: MemberId, action: MandateAction, scope?: MandateScope): Promise<boolean>
  assert(actor: MemberId, action: MandateAction, scope?: MandateScope): Promise<void>
  grants(member: MemberId): Promise<MandateGrant[]>
}

const ALL_ACTIONS: MandateAction[] = [
  'hive.remove',
  'hive.rename',
  'hive.set-mode',
  'roster.hatch',
  'roster.dismiss',
  'roster.register',
  'ledger.create',
  'ledger.update',
  'ledger.assign',
  'courier.send',
  'courier.broadcast',
  'hive.shutdown',
]

/** 默认策略：queen 全授权；worker 仅 courier.send 与 ledger.update（owner-scoped）。 */
export function defaultGrant(
  member: Member | undefined,
  action: MandateAction,
  _scope?: MandateScope,
): MandateGrant {
  const role = member?.role ?? 'worker'
  if (role === 'queen') return { action, verdict: 'granted', reason: 'queen holds all mandates' }
  if (action === 'courier.send') return { action, verdict: 'granted' }
  if (action === 'ledger.update') {
    return { action, verdict: 'owner-scoped', reason: 'worker may update owned tasks' }
  }
  return { action, verdict: 'denied', reason: 'queen-only mandate' }
}

export function createMandateService(
  ctx: Context,
  deps: { store: FactStore; config: ResolvedHoneycombConfig },
): MandateService {
  const { store, config } = deps

  function resolve(actor: MemberId, grant: MandateGrant, scope?: MandateScope): boolean {
    if (grant.verdict === 'granted') return true
    if (grant.verdict === 'owner-scoped') {
      if (scope?.taskId) return store.task(scope.taskId)?.owner === actor
      return false
    }
    return false
  }

  return {
    async can(actor, action, scope) {
      const member = store.member(actor)
      const initial = defaultGrant(member, action, scope)
      let grant = initial
      if (config.mandate.allowOverrides) {
        const payload: MandateDecidePayload = { actor, action, scope }
        grant = ctx.waterfall<MandateGrant, MandateDecidePayload>(MandateDecide, initial, payload)
      }
      return resolve(actor, grant, scope)
    },

    async assert(actor, action, scope) {
      if (!(await this.can(actor, action, scope))) {
        const member = store.member(actor)
        const grant = defaultGrant(member, action, scope)
        throw new MandateDeniedError(actor, action, grant.reason)
      }
    },

    async grants(memberId) {
      const member = store.member(memberId)
      return ALL_ACTIONS.map((action) => defaultGrant(member, action))
    },
  }
}
