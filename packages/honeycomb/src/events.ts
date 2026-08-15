/**
 * Honeycomb event model (§8).
 *
 * Emit-style events are merged into cordis's `Events` interface via
 * declaration merging; each key maps to its payload object. The two waterfall
 * hooks (`mandate/decide`, `courier/outgoing`) are continuation-style chains
 * driven by `ctx.waterfall`, mirroring the harness's `tools/pre-execute` hook.
 *
 * On the cordis migration the `declare module` target moved from the legacy
 * `./framework` shim to the real `@deepseek-ai/cordis` package.
 *
 * @module @whalepod/honeycomb/events
 */

import type {
  Hive,
  HiveId,
  Member,
  MemberId,
  MemberStatus,
  Message,
  MessageId,
  OutgoingMessage,
  MandateAction,
  MandateGrant,
  MandateScope,
  Task,
  WorkState,
} from './types'

/** Merge honeycomb's event map into cordis's `Events` for typed emit/on. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    // 团队
    'hive/created'(payload: { hive: Hive }): void
    'hive/renamed'(payload: { hiveId: HiveId; name: string }): void
    'hive/removed'(payload: { hiveId: HiveId }): void

    // 名册 / 生命周期
    'member/hatched'(payload: { hiveId: HiveId; member: Member }): void
    'member/dismissed'(payload: { hiveId: HiveId; memberId: MemberId }): void
    'member/status'(payload: {
      hiveId: HiveId
      memberId: MemberId
      status: MemberStatus
      note?: string
    }): void
    'member/work-state'(payload: {
      hiveId: HiveId
      memberId: MemberId
      state: WorkState
      blockedReason?: string
    }): void

    // 台账
    'task/created'(payload: { task: Task }): void
    'task/updated'(payload: { task: Task; change: 'status' | 'owner' | 'dependency' | 'description' }): void

    // 信使
    'message/created'(payload: { message: Message }): void
    'message/read'(payload: { hiveId: HiveId; messageId: MessageId }): void

    // 连接器（connectors/registry.ts）
    'connectors/registered'(payload: { id: string }): void
    'connectors/discovered'(payload: { descriptor: unknown }): void
    'connectors/cache-invalidated'(payload: { id: string }): void

    // -- waterfall hooks (§8) ---------------------------------------------------
    /**
     * `courier/outgoing` — rewrite or drop an outgoing message.
     * Continuation style: last arg is `next`; return `null` to drop (veto).
     */
    'courier/outgoing'(
      message: OutgoingMessage | null,
      payload: { hiveId: HiveId; message: OutgoingMessage },
      next: (m: OutgoingMessage | null) => OutgoingMessage | null,
    ): OutgoingMessage | null

    /**
     * `mandate/decide` — audit/override a grant decision.
     * Return a grant to override, or call `next()` to keep the default.
     */
    'mandate/decide'(
      grant: MandateGrant,
      payload: { actor: MemberId; action: MandateAction; scope?: MandateScope },
      next: (g: MandateGrant) => MandateGrant,
    ): MandateGrant
  }
}

/** Emit-style event map (mirrors the merged cordis `Events` interface above). */
export interface HiveEventMap {
  'hive/created': { hive: Hive }
  'hive/renamed': { hiveId: HiveId; name: string }
  'hive/removed': { hiveId: HiveId }
  'member/hatched': { hiveId: HiveId; member: Member }
  'member/dismissed': { hiveId: HiveId; memberId: MemberId }
  'member/status': { hiveId: HiveId; memberId: MemberId; status: MemberStatus; note?: string }
  'member/work-state': { hiveId: HiveId; memberId: MemberId; state: WorkState; blockedReason?: string }
  'task/created': { task: Task }
  'task/updated': { task: Task; change: 'status' | 'owner' | 'dependency' | 'description' }
  'message/created': { message: Message }
  'message/read': { hiveId: HiveId; messageId: MessageId }
}

// -- waterfall hooks (§8) ---------------------------------------------------

/** Waterfall hook names (kept as constants to avoid typos). */
export const MandateDecide = 'mandate/decide'
export const CourierOutgoing = 'courier/outgoing'

/** `mandate/decide` payload. */
export interface MandateDecidePayload {
  actor: MemberId
  action: MandateAction
  scope?: MandateScope
}

/** `mandate/decide` continuation listener. */
export type MandateDecideListener = (
  grant: MandateGrant,
  payload: MandateDecidePayload,
  next: (grant: MandateGrant) => MandateGrant,
) => MandateGrant

/** `courier/outgoing` payload. */
export interface CourierOutgoingPayload {
  hiveId: HiveId
  message: OutgoingMessage
}

/** `courier/outgoing` continuation listener. */
export type CourierOutgoingListener = (
  message: OutgoingMessage | null,
  payload: CourierOutgoingPayload,
  next: (message: OutgoingMessage | null) => OutgoingMessage | null,
) => OutgoingMessage | null
