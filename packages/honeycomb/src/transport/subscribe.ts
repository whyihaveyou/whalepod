/**
 * subscribe — WS 订阅中心（docs/honeycomb-transport-api.md §4）.
 *
 * 把 honeycomb 的 emit 事件桥接成 WebSocket 推送。维护一个「连接 → 订阅的
 * hiveId 集合」的视图，并注册每个事件监听器；事件触发时按每条连接的订阅过滤，
 * 若匹配则推 `event` 帧（`{ type:'event', topic, hiveId, payload }`）。
 *
 * 订阅语义（§4.4）：
 * - 连接可订阅具体 hiveId，或订阅 `"*"`（广播，收到所有事件）。
 * - 事件帧自带 `hiveId` 字段，前端据此二次过滤。
 *
 * @module @dfh/honeycomb/transport
 */

import type { Context, Disposable, Events } from '@deepseek-ai/cordis'
import type { WsConn, WsMessage } from './types'

/** 广播订阅 sentinel。 */
const ANY: '*' = '*'

/** transport 订阅并推送的事件名清单（§4.3）。 */
export const PUSHED_TOPICS: readonly (keyof Events)[] = [
  'hive/created',
  'hive/renamed',
  'hive/removed',
  'member/hatched',
  'member/dismissed',
  'member/status',
  'member/work-state',
  'task/created',
  'task/updated',
  'message/created',
  'message/read',
]

/** 从事件 payload 提取 hiveId（§4.3 归属判定）。 */
function hiveIdOf(topic: string, payload: any): string | null {
  if (payload && typeof payload.hiveId === 'string') return payload.hiveId
  // 完整对象形式：{ hive } / { task } / { message }
  const holder =
    (payload && (payload.hive ?? payload.task ?? payload.message)) ?? null
  if (holder && typeof holder.hiveId === 'string') return holder.hiveId
  return null
}

export class SubscribeCenter {
  private readonly conns = new Set<WsConn>()
  private readonly disposers: Disposable[] = []

  constructor(private readonly ctx: Context) {}

  /** 接入端在 WS 连接建立时调用。 */
  connect(conn: WsConn): void {
    this.conns.add(conn)
  }

  /** 接入端在 WS 连接关闭时调用。 */
  disconnect(conn: WsConn): void {
    this.conns.delete(conn)
  }

  /** 处理客户端指令（subscribe / unsubscribe / hello）；填写 ack 帧。 */
  handleClientMessage(conn: WsConn, msg: any): void {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'subscribe':
        if (typeof msg.hiveId === 'string') {
          conn.subscriptions.add(msg.hiveId)
          conn.send({ type: 'subscribed', hiveId: msg.hiveId })
        }
        break
      case 'unsubscribe':
        if (typeof msg.hiveId === 'string') {
          conn.subscriptions.delete(msg.hiveId)
          conn.send({ type: 'unsubscribed', hiveId: msg.hiveId })
        }
        break
      case 'hello':
        conn.send({ type: 'hello', ok: true })
        break
    }
  }

  /** 注册全部事件桥接；返回统一的 dispose 函数。 */
  start(): Disposable {
    for (const topic of PUSHED_TOPICS) {
      const off = this.ctx.on(topic, (payload: any) => this.broadcast(topic, payload))
      this.disposers.push(off)
    }
    return () => this.stop()
  }

  stop(): void {
    while (this.disposers.length) this.disposers.pop()!()
  }

  /** 事件 → 按连接订阅过滤推送 event 帧。 */
  private broadcast(topic: string, payload: any): void {
    const hiveId = hiveIdOf(topic, payload)
    const frame: WsMessage = { type: 'event', topic, hiveId, payload }
    for (const conn of [...this.conns]) {
      if (conn.subscriptions.has(ANY) || (hiveId !== null && conn.subscriptions.has(hiveId))) {
        conn.send(frame)
      }
    }
  }
}
