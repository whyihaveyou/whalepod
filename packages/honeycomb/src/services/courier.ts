/**
 * CourierService — 信使服务 (§5.3).
 *
 * 消息投递、收件箱、广播、动态时间线（feed）。`send` 内部走 `courier/outgoing`
 * waterfall（重写/丢消息），`deliver` 是异步入队路径（概念级实现直接落库）。
 *
 * @module @dfh/honeycomb/services/courier
 */

import type { Context } from '../framework'
import { makeId, now } from '../util'
import { CourierOutgoing, type CourierOutgoingPayload } from '../events'
import type { FactStore } from '../persistence/store'
import type {
  ActivityItem,
  ActivityPage,
  FeedCursor,
  HiveId,
  InboxFilter,
  Message,
  MessageId,
  MessageRecipient,
  MessageSender,
  OutgoingMessage,
} from '../types'

export class MessageDroppedError extends Error {
  readonly hiveId: HiveId
  constructor(hiveId: HiveId) {
    super('outgoing message was dropped by the courier/outgoing waterfall')
    this.name = 'MessageDroppedError'
    this.hiveId = hiveId
  }
}

export interface CourierService {
  send(hiveId: HiveId, message: OutgoingMessage): Promise<Message>
  deliver(hiveId: HiveId, message: OutgoingMessage): Promise<MessageId>
  inbox(hiveId: HiveId, recipient: MessageRecipient, filter?: InboxFilter): Promise<Message[]>
  markRead(hiveId: HiveId, id: MessageId): Promise<void>
  broadcast(hiveId: HiveId, from: MessageSender, content: string): Promise<void>
  feed(hiveId: HiveId, cursor?: FeedCursor, limit?: number): Promise<ActivityPage>
}

export function createCourierService(ctx: Context, deps: { store: FactStore }): CourierService {
  const { store } = deps

  async function persist(hiveId: HiveId, final: OutgoingMessage): Promise<Message> {
    const message: Message = {
      id: makeId('message'),
      hiveId,
      from: final.from,
      to: final.to,
      kind: final.kind,
      content: final.content,
      summary: final.summary,
      attachments: final.attachments ?? [],
      read: false,
      createdAt: now(),
    }
    await store.append(hiveId, { type: 'message-created', message, at: now() })
    return message
  }

  function itemTs(item: ActivityItem): number {
    return item.kind === 'message' ? item.message.createdAt : item.task.createdAt
  }

  function itemId(item: ActivityItem): string {
    return item.kind === 'message' ? item.message.id : item.task.id
  }

  return {
    async send(hiveId, message) {
      const payload: CourierOutgoingPayload = {
        hiveId,
        message: { ...message, attachments: message.attachments ?? [] },
      }
      const final = ctx.waterfall<OutgoingMessage | null, CourierOutgoingPayload>(
        CourierOutgoing,
        payload.message,
        payload,
      )
      if (final === null) throw new MessageDroppedError(hiveId)
      const persisted = await persist(hiveId, final)
      ctx.emit('message/created', { message: persisted })
      return persisted
    },

    async deliver(hiveId, message) {
      // 异步入队路径：概念级实现直接落库并返回 id（真实异步队列留待运行时接入）。
      const persisted = await persist(hiveId, message)
      ctx.emit('message/created', { message: persisted })
      return persisted.id
    },

    async inbox(hiveId, recipient, filter) {
      let messages = store.messagesOf(hiveId)
      if (recipient !== 'all') {
        messages = messages.filter((message) => message.to === recipient || message.to === 'all')
      }
      if (filter?.from !== undefined) messages = messages.filter((message) => message.from === filter.from)
      if (filter?.unreadOnly) messages = messages.filter((message) => !message.read)
      messages = messages.sort((a, b) => b.createdAt - a.createdAt)
      if (filter?.limit !== undefined) messages = messages.slice(0, filter.limit)
      return messages
    },

    async markRead(hiveId, id) {
      if (!store.message(id)) throw new Error(`message not found: ${id}`)
      await store.append(hiveId, { type: 'message-read', messageId: id, at: now() })
      ctx.emit('message/read', { hiveId, messageId: id })
    },

    async broadcast(hiveId, from, content) {
      const workers = store
        .membersOf(hiveId)
        .filter((member) => member.role === 'worker' && !store.isDismissed(member.id))
      for (const worker of workers) {
        await this.send(hiveId, { from, to: worker.id, kind: 'note', content })
      }
    },

    async feed(hiveId, cursor, limit) {
      const take = limit ?? 20
      const items: ActivityItem[] = []
      for (const message of store.messagesOf(hiveId)) items.push({ kind: 'message', message })
      for (const task of store.tasksOf(hiveId)) items.push({ kind: 'task', task })
      items.sort((a, b) => itemTs(b) - itemTs(a) || itemId(b).localeCompare(itemId(a)))

      let filtered = items
      if (cursor) {
        filtered = items.filter((item) => {
          const ts = itemTs(item)
          const id = itemId(item)
          return ts < cursor.ts || (ts === cursor.ts && id < cursor.id)
        })
      }
      const page = filtered.slice(0, take)
      const hasMore = filtered.length > take
      const last = page[page.length - 1]
      return {
        items: page,
        hasMore,
        nextCursor: hasMore && last ? { ts: itemTs(last), id: itemId(last) } : undefined,
      }
    },
  }
}
