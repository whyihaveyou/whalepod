/**
 * CourierService — 信使服务 (§5.3).
 *
 * 消息投递、收件箱、广播、动态时间线（feed）。`send` 内部走 `courier/outgoing`
 * waterfall（重写/丢消息），`deliver` 是异步入队路径（概念级实现直接落库）。
 *
 * 迁移到真实 cordis：工厂函数 → `Service` 子类（`super(ctx, 'courier')`）；
 * `courier/outgoing` waterfall 由「归约」改为 cordis 的「continuation」形态——
 * 无任何监听时终端 `next` 直接返回消息（等价于原默认行为）。
 *
 * @module @dfh/honeycomb/services/courier
 */

import { Service, type Context } from '@deepseek-ai/cordis'
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

export class HoneycombCourierService extends Service implements CourierService {
  constructor(ctx: Context, private readonly store: FactStore) {
    super(ctx, 'courier')
  }

  private async persist(hiveId: HiveId, final: OutgoingMessage): Promise<Message> {
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
    await this.store.append(hiveId, { type: 'message-created', message, at: now() })
    return message
  }

  private itemTs(item: ActivityItem): number {
    return item.kind === 'message' ? item.message.createdAt : item.task.createdAt
  }

  private itemId(item: ActivityItem): string {
    return item.kind === 'message' ? item.message.id : item.task.id
  }

  async send(hiveId: HiveId, message: OutgoingMessage): Promise<Message> {
    const payload: CourierOutgoingPayload = {
      hiveId,
      message: { ...message, attachments: message.attachments ?? [] },
    }
    // cordis continuation 形态：终端 next 直接返回消息（无监听即原样）。
    const final = this.ctx.waterfall(
      CourierOutgoing,
      payload.message,
      payload,
      (m: OutgoingMessage | null) => m,
    )
    if (final === null) throw new MessageDroppedError(hiveId)
    const persisted = await this.persist(hiveId, final)
    this.ctx.emit('message/created', { message: persisted })
    return persisted
  }

  async deliver(hiveId: HiveId, message: OutgoingMessage): Promise<MessageId> {
    // 异步入队路径：概念级实现直接落库并返回 id（真实异步队列留待运行时接入）。
    const persisted = await this.persist(hiveId, message)
    this.ctx.emit('message/created', { message: persisted })
    return persisted.id
  }

  async inbox(
    hiveId: HiveId,
    recipient: MessageRecipient,
    filter?: InboxFilter,
  ): Promise<Message[]> {
    let messages = this.store.messagesOf(hiveId)
    if (recipient !== 'all') {
      messages = messages.filter((message) => message.to === recipient || message.to === 'all')
    }
    if (filter?.from !== undefined) {
      messages = messages.filter((message) => message.from === filter.from)
    }
    if (filter?.unreadOnly) messages = messages.filter((message) => !message.read)
    messages = messages.sort((a, b) => b.createdAt - a.createdAt)
    if (filter?.limit !== undefined) messages = messages.slice(0, filter.limit)
    return messages
  }

  async markRead(hiveId: HiveId, id: MessageId): Promise<void> {
    if (!this.store.message(id)) throw new Error(`message not found: ${id}`)
    await this.store.append(hiveId, { type: 'message-read', messageId: id, at: now() })
    this.ctx.emit('message/read', { hiveId, messageId: id })
  }

  async broadcast(hiveId: HiveId, from: MessageSender, content: string): Promise<void> {
    const workers = this.store
      .membersOf(hiveId)
      .filter((member) => member.role === 'worker' && !this.store.isDismissed(member.id))
    for (const worker of workers) {
      await this.send(hiveId, { from, to: worker.id, kind: 'note', content })
    }
  }

  async feed(hiveId: HiveId, cursor?: FeedCursor, limit?: number): Promise<ActivityPage> {
    const take = limit ?? 20
    const items: ActivityItem[] = []
    for (const message of this.store.messagesOf(hiveId)) {
      items.push({ kind: 'message', message })
    }
    for (const task of this.store.tasksOf(hiveId)) items.push({ kind: 'task', task })
    items.sort((a, b) => this.itemTs(b) - this.itemTs(a) || this.itemId(b).localeCompare(this.itemId(a)))

    let filtered = items
    if (cursor) {
      filtered = items.filter((item) => {
        const ts = this.itemTs(item)
        const id = this.itemId(item)
        return ts < cursor.ts || (ts === cursor.ts && id < cursor.id)
      })
    }
    const page = filtered.slice(0, take)
    const hasMore = filtered.length > take
    const last = page[page.length - 1]
    return {
      items: page,
      hasMore,
      nextCursor: hasMore && last ? { ts: this.itemTs(last), id: this.itemId(last) } : undefined,
    }
  }
}
