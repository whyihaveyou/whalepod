/**
 * Honeycomb fact vocabulary (§9.2).
 *
 * All hive state is a replay of an append-only fact log; the "current
 * snapshot" is always derived, never double-written. The vocabulary below is
 * the §9.2 list, plus two minimal extensions required by the §5/§6 service
 * surface (`hive-updated` for `setMode`/`setSessionMode`, `member-renamed`
 * for `RosterService.rename`) — see the delivery notes in README.
 *
 * @module @whalepod/honeycomb/persistence/facts
 */

import type {
  Hive,
  HiveId,
  Member,
  MemberId,
  MemberStatus,
  Message,
  MessageId,
  Task,
  TaskId,
  TaskPatch,
} from '../types'

/** Non-name hive mutations (mode / session-mode) folded into one patch fact. */
export interface HiveUpdatePatch {
  workspaceMode?: Hive['workspaceMode']
  sessionMode?: Hive['sessionMode']
}

/** The append-only fact vocabulary for a single hive. */
export type HiveFact =
  | { type: 'hive-created'; hive: Hive }
  | { type: 'hive-renamed'; hiveId: HiveId; name: string; at: number }
  | { type: 'hive-updated'; hiveId: HiveId; patch: HiveUpdatePatch; at: number }
  | { type: 'hive-removed'; hiveId: HiveId; at: number }
  | { type: 'member-registered'; member: Member; at: number }
  | { type: 'member-renamed'; memberId: MemberId; name: string; at: number }
  | { type: 'member-status'; memberId: MemberId; status: MemberStatus; at: number }
  | { type: 'member-dismissed'; memberId: MemberId; at: number }
  | { type: 'task-created'; task: Task; at: number }
  | { type: 'task-updated'; taskId: TaskId; patch: TaskPatch; at: number }
  | { type: 'task-dependency'; taskId: TaskId; blockedBy: TaskId; op: 'add' | 'remove'; at: number }
  | { type: 'task-cancelled'; taskId: TaskId; memberId: MemberId | null; reason: string; at: number }
  | { type: 'message-created'; message: Message; at: number }
  | { type: 'message-read'; messageId: MessageId; at: number }

export type FactType = HiveFact['type']

/** A fact as stored: the fact plus its append metadata. */
export interface FactRecord {
  /** Monotonic sequence number within the log. */
  seq: number
  /** Append timestamp (epoch ms). */
  at: number
  /** Owning hive — partitions the log for per-hive replay (jsonl/sqlite). */
  hiveId: HiveId
  fact: HiveFact
}

export function factType(fact: HiveFact): FactType {
  return fact.type
}
