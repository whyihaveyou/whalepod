/**
 * HoneycombTransport — transport 核心端口接口（§2 / §5）.
 *
 * Transport 把 5 个 service 暴露成 HTTP+WS。本类定义 transport 的公共形状：
 * 路由注册、请求分发、订阅中心桥接。它只依赖 service 接口与事件总线，
 * 自身不含任何网络栈。
 *
 * 「内存版实现骨架」的形态：`HoneycombTransport` 是完整可用的纯内存实现——
 * 调用方（主进程桥 / 测试 / 接入端真实适配器）经 `dispatch()` 投递 REST 请求、
 * 经 `attachWs()` 挂接 WS 连接即可使用。真实的 Node http/ws 适配器在接入端
 * 实现 `HttpAdapter` / `WsAdapter` 端口并驱动本类。
 *
 * @module @whalepod/honeycomb/transport
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HiveService } from '../services/hive'
import type { LedgerService } from '../services/ledger'
import type { CourierService } from '../services/courier'
import type { MandateService } from '../services/mandate'
import type { RosterService } from '../services/roster'
import type {
  HttpRequest,
  HttpResponse,
  WsConn,
  WsClientMessage,
} from './types'
import { fail } from './types'

/** transport 持有的服务门面。 */
export interface TransportServices {
  hive: HiveService
  ledger: LedgerService
  courier: CourierService
  mandate: MandateService
  roster: RosterService
  /**
   * 编排循环门面（可选，cancel 通道的唯一接触面）。
   *
   * 结构类型而非 `OrchestrationLoop` 本体 —— transport 不需要 import consumer
   * 层（依赖方向 §1.3：transport 只依赖 service + 结构类型），且
   * `createOrchestrationLoop(deps).cancelTask(hiveId, taskId, reason)` 恰好满足。
   * 装配方（生产/测试）把整个 loop 句柄或仅其 cancelTask 裁剪面传进来即可。
   *
   * 未挂钩时 POST /v1/tasks/{id}/cancel 对 in-progress 任务返回
   * `503 ORCHESTRATION_UNAVAILABLE`；非在途任务的 409/幂等路径不依赖本门面。
   */
  orchestration?: TransportOrchestration
}

/**
 * 编排循环调用面（cancel 普测 §3.6）：transport 唯一需要的一个方法。
 * 与 `OrchestrationLoop.cancelTask` 签名结构兼容。
 */
export interface TransportOrchestration {
  cancelTask(hiveId: string, taskId: string, reason: string): Promise<void>
}

/** transport 可选鉴权（§6.2）：从请求解析操作者；返回 null 表示匿名。 */
export interface TransportAuth {
  actor(req: HttpRequest): Promise<string | null>
}

/** transport 装配选项。 */
export interface TransportOptions {
  /** 启用鉴权则对变更端点先 mandate.assert；默认关闭。 */
  auth?: TransportAuth | false
  /** 编排循环门面（cancel 通道）；未提供则 POST /tasks/{id}/cancel 对在途任务返回 503。 */
  orchestration?: TransportOrchestration
}

/** JSON 查询参数解析（`?filter={...}` 等）。 */
function parseJsonQuery(value: string | undefined): any {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export class HoneycombTransport {
  readonly services: TransportServices
  readonly ctx: Context
  private readonly options: TransportOptions
  /** REST 路由表：`method\0pattern → handler`（router.ts 填充）。 */
  private readonly routes = new Map<string, (req: HttpRequest, t: HoneycombTransport) => Promise<HttpResponse>>()

  constructor(ctx: Context, services: TransportServices, options: TransportOptions = {}) {
    this.ctx = ctx
    this.services = services
    this.options = options
  }

  /** 供 router.ts 注册一条路由。 */
  registerRoute(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pattern: string,
    handler: (req: HttpRequest, t: HoneycombTransport) => Promise<HttpResponse> | HttpResponse,
  ): void {
    this.routes.set(method + '\u0000' + pattern, async (req, t) => handler(req, t))
  }

  /**
   * 分发一个 HTTP 请求（内存版入口）。接入端把真实请求翻译成 `HttpRequest`
   * 后调用本方法即可复用全部路由。
   */
  async dispatch(req: HttpRequest): Promise<HttpResponse> {
    // 逐条匹配（内存版顺序扫描；真实适配器可用 trie）
    for (const [key, handler] of this.routes) {
      const [method, pattern] = key.split('\u0000')
      if (method !== req.method) continue
      if (matchPattern(pattern, req.path) === null) continue
      return await handler(req, this)
    }
    return fail('NOT_FOUND', `no route: ${req.method} ${req.path}`, 404)
  }

  /** 查询参数 JSON 解析辅助（供 router.ts 用）。 */
  queryJson(req: HttpRequest, key: string): any {
    return parseJsonQuery(req.query[key])
  }

  /** 路径参数辅助：把 `{hiveId}` 等占位解析出的值取出。 */
  pathParams(req: HttpRequest, pattern: string): Record<string, string> {
    return matchPattern(pattern, req.path) ?? {}
  }

  /** 鉴权门面：变更端点调用前检查（配置开启时）。 */
  async authorize(req: HttpRequest, action: string, scope?: any): Promise<void> {
    if (!this.options.auth) return
    const actor = await this.options.auth.actor(req)
    if (!actor) throw new Error('unknown actor')
    await this.services.mandate.assert(actor, action as any, scope)
  }

  /** 基建：接入端注册 HTTP 适配器/WS 适配器（真实网络栈注入点）。 */
  attachHttp(adapter: HttpAdapter): void {
    for (const [key, handler] of this.routes) {
      const [method, pattern] = key.split('\u0000')
      adapter.route(method as any, pattern, (req, _t) => handler(req, this))
    }
  }

  attachWs(adapter: WsAdapter): void {
    // 订阅中心在 subscribe.ts 中实现；这里由接入端调用 adapter.on 触发订阅。
    // 实际事件→推送的桥接注册在 plugin.ts 的 apply() 中完成（见 subscribe.ts）。
    void adapter
  }
}

/** 轻量路径匹配（供 dispatch / pathParams 复用）。 */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const s = path.split('/').filter(Boolean)
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]
    if (seg.startsWith('{') && seg.endsWith('}')) {
      params[seg.slice(1, -1)] = decodeURIComponent(s[i])
    } else if (seg !== s[i]) {
      return null
    }
  }
  return params
}

// ---------------------------------------------------------------------------
// 端口接口（Port）——真实网络适配器实现这些（doc §2）
// ---------------------------------------------------------------------------

/** HTTP 适配器端口：transport 用它声明一组路由处理器。 */
export interface HttpAdapter {
  route(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pattern: string,
    handler: (req: HttpRequest, transport: HoneycombTransport) => Promise<HttpResponse> | HttpResponse,
  ): void
}

/** WS 适配器端口：transport 用它接收连接、处理订阅指令、驱动推送。 */
export interface WsAdapter {
  /** 新连接建立。 */
  on(conn: WsConn): void
  /** 连接关闭。 */
  off(connId: string): void
  /** 前端投来一条客户端指令（subscribe/unsubscribe/hello）。 */
  onClientMessage(conn: WsConn, msg: WsClientMessage): void
  /** transport 主动向一个连接推送（按订阅过滤由 subscribe.ts 完成）。 */
  push(conn: WsConn, topic: string, payload: any): void
}

export * from './types'
