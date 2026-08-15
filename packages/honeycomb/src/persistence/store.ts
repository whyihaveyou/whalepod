/**
 * Fact store + snapshot derivation (§9).
 *
 * The store owns the append-only log (via a pluggable backend, default
 * in-memory) and derives the current {@link HiveSnapshot} by replaying facts
 * in order. Services never mutate snapshot state directly — they only append
 * facts.
 *
 * @module @whalepod/honeycomb/persistence/store
 */

import { now } from '../util'
import type { Hive, HiveId, Member, MemberId, Message, MessageId, Task, TaskId } from '../types'
import type { FactRecord, HiveFact } from './facts'

/** Pluggable append-only backend (§9.3). `jsonl` / `sqlite` providers slot in here. */
export interface FactBackend {
  /** Append a record to the log. */
  append(record: FactRecord): Promise<void>
  /** Replay the full log (optionally scoped to a hive). */
  replay(hiveId?: HiveId): Promise<FactRecord[]>
}

/** In-memory backend (default; used by unit tests). */
export class MemoryFactBackend implements FactBackend {
  private readonly log: FactRecord[] = []

  async append(record: FactRecord): Promise<void> {
    this.log.push(record)
  }

  async replay(hiveId?: HiveId): Promise<FactRecord[]> {
    if (hiveId === undefined) return [...this.log]
    return this.log.filter((record) => record.hiveId === hiveId)
  }
}

/** Derived current state of the whole store. */
export interface HiveSnapshot {
  hives: Map<HiveId, Hive>
  members: Map<MemberId, Member>
  tasks: Map<TaskId, Task>
  messages: Map<MessageId, Message>
  /** Members that have been dismissed/removed (logical tombstone). */
  dismissed: Set<MemberId>
}

function emptySnapshot(): HiveSnapshot {
  return { hives: new Map(), members: new Map(), tasks: new Map(), messages: new Map(), dismissed: new Set() }
}

/** Replay a sequence of facts into a fresh snapshot (pure function). */
export function replay(facts: readonly FactRecord[]): HiveSnapshot {
  const snapshot = emptySnapshot()
  for (const record of facts) applyFact(snapshot, record.fact)
  return snapshot
}

function applyFact(snapshot: HiveSnapshot, fact: HiveFact): void {
  switch (fact.type) {
    case 'hive-created':
      snapshot.hives.set(fact.hive.id, { ...fact.hive })
      break
    case 'hive-renamed': {
      const hive = snapshot.hives.get(fact.hiveId)
      if (hive) {
        hive.name = fact.name
        hive.updatedAt = fact.at
      }
      break
    }
    case 'hive-updated': {
      const hive = snapshot.hives.get(fact.hiveId)
      if (hive) {
        if (fact.patch.workspaceMode !== undefined) hive.workspaceMode = fact.patch.workspaceMode
        if (fact.patch.sessionMode !== undefined) hive.sessionMode = fact.patch.sessionMode
        hive.updatedAt = fact.at
      }
      break
    }
    case 'hive-removed': {
      const hive = snapshot.hives.get(fact.hiveId)
      snapshot.hives.delete(fact.hiveId)
      if (hive) {
        for (const member of snapshot.members.values()) {
          if (member.hiveId === fact.hiveId) snapshot.members.delete(member.id)
        }
        for (const task of snapshot.tasks.values()) {
          if (task.hiveId === fact.hiveId) snapshot.tasks.delete(task.id)
        }
        for (const message of snapshot.messages.values()) {
          if (message.hiveId === fact.hiveId) snapshot.messages.delete(message.id)
        }
      }
      break
    }
    case 'member-registered':
      snapshot.members.set(fact.member.id, { ...fact.member })
      snapshot.dismissed.delete(fact.member.id)
      break
    case 'member-renamed': {
      const member = snapshot.members.get(fact.memberId)
      if (member) {
        member.name = fact.name
        member.updatedAt = fact.at
      }
      break
    }
    case 'member-status': {
      const member = snapshot.members.get(fact.memberId)
      if (member) {
        member.status = fact.status
        member.updatedAt = fact.at
      }
      break
    }
    case 'member-dismissed': {
      const member = snapshot.members.get(fact.memberId)
      if (member) {
        member.status = 'dormant'
        member.updatedAt = fact.at
      }
      snapshot.dismissed.add(fact.memberId)
      break
    }
    case 'task-created':
      snapshot.tasks.set(fact.task.id, { ...fact.task })
      break
    case 'task-updated': {
      const task = snapshot.tasks.get(fact.taskId)
      if (task) {
        Object.assign(task, fact.patch)
        task.updatedAt = fact.at
      }
      break
    }
    case 'task-dependency': {
      const task = snapshot.tasks.get(fact.taskId)
      if (task) {
        if (fact.op === 'add') {
          if (!task.blockedBy.includes(fact.blockedBy)) task.blockedBy.push(fact.blockedBy)
        } else {
          task.blockedBy = task.blockedBy.filter((id) => id !== fact.blockedBy)
        }
        task.updatedAt = fact.at
      }
      const blocker = snapshot.tasks.get(fact.blockedBy)
      if (blocker) {
        if (fact.op === 'add') {
          if (!blocker.blocks.includes(fact.taskId)) blocker.blocks.push(fact.taskId)
        } else {
          blocker.blocks = blocker.blocks.filter((id) => id !== fact.taskId)
        }
      }
      break
    }
    case 'message-created':
      snapshot.messages.set(fact.message.id, { ...fact.message })
      break
    case 'message-read': {
      const message = snapshot.messages.get(fact.messageId)
      if (message) message.read = true
      break
    }
  }
}

/**
 * The fact store: append-only log + derived live snapshot.
 */
export class FactStore {
  private seq = 0
  private snapshot: HiveSnapshot = emptySnapshot()
  readonly backend: FactBackend

  constructor(backend: FactBackend = new MemoryFactBackend()) {
    this.backend = backend
  }

  /** Append a fact and fold it into the live snapshot. */
  async append(hiveId: HiveId, fact: HiveFact): Promise<void> {
    this.seq += 1
    const record: FactRecord = { seq: this.seq, at: now(), hiveId, fact }
    await this.backend.append(record)
    applyFact(this.snapshot, fact)
  }

  /** Reload from backend and rebuild the snapshot. */
  async load(): Promise<void> {
    const records = await this.backend.replay()
    this.snapshot = replay(records)
    this.seq = records.reduce((max, record) => Math.max(max, record.seq), 0)
  }

  /** Current derived snapshot (read-only view — do not mutate). */
  view(): HiveSnapshot {
    return this.snapshot
  }

  // -- derived queries (convenience) ----------------------------------------

  hive(id: HiveId): Hive | undefined {
    return this.snapshot.hives.get(id)
  }

  member(id: MemberId): Member | undefined {
    return this.snapshot.members.get(id)
  }

  task(id: TaskId): Task | undefined {
    return this.snapshot.tasks.get(id)
  }

  message(id: MessageId): Message | undefined {
    return this.snapshot.messages.get(id)
  }

  isDismissed(id: MemberId): boolean {
    return this.snapshot.dismissed.has(id)
  }

  hives(): Hive[] {
    return [...this.snapshot.hives.values()]
  }

  membersOf(hiveId: HiveId): Member[] {
    return [...this.snapshot.members.values()].filter((member) => member.hiveId === hiveId)
  }

  tasksOf(hiveId: HiveId): Task[] {
    return [...this.snapshot.tasks.values()].filter((task) => task.hiveId === hiveId)
  }

  messagesOf(hiveId: HiveId): Message[] {
    return [...this.snapshot.messages.values()].filter((message) => message.hiveId === hiveId)
  }
}
