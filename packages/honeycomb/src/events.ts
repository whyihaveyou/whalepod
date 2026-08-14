/**
 * Honeycomb event model (§8).
 *
 * Emit-style events are merged into the framework's `Events` interface via
 * declaration merging; each key maps to its payload object. The two waterfall
 * hooks (`mandate/decide`, `courier/outgoing`) are reduction chains with
 * explicit input/output types and are *not* part of the emit map — they are
 * driven by `ctx.waterfall`, mirroring the harness's `tools/pre-execute` hook.
 *
 * @module @dfh/honeycomb/events
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

declare module './framework' {
  interface Events {
    // 团队
    'hive/created': { hive: Hive }
    'hive/renamed': { hiveId: HiveId; name: string }
    'hive/removed': { hiveId: HiveId }

    // 名册 / 生命周期
    'member/hatched': { hiveId: HiveId; member: Member }
    'member/dismissed': { hiveId: HiveId; memberId: MemberId }
    'member/status': { hiveId: HiveId; memberId: MemberId; status: MemberStatus; note?: string }
    'member/work-state': { hiveId: HiveId; memberId: MemberId; state: WorkState; blockedReason?: string }

    // 台账
    'task/created': { task: Task }
    'task/updated': { task: Task; change: 'status' | 'owner' | 'dependency' | 'description' }

    // 信使
    'message/created': { message: Message }
    'message/read': { hiveId: HiveId; messageId: MessageId }
  }
}

/** Emit-style event map (mirrors the merged `Events` interface above). */
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

/** `mandate/decide` listener: reduce a grant, or return `undefined` to pass through. */
export type MandateDecideListener = (
  grant: MandateGrant,
  payload: MandateDecidePayload,
) => MandateGrant | undefined

/** `courier/outgoing` payload. */
export interface CourierOutgoingPayload {
  hiveId: HiveId
  message: OutgoingMessage
}

/** `courier/outgoing` listener: rewrite the outgoing message, return `null` to drop. */
export type CourierOutgoingListener = (
  message: OutgoingMessage,
  payload: CourierOutgoingPayload,
) => OutgoingMessage | null | undefined
