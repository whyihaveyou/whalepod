/**
 * http — 真实 HTTP 适配器（node:http）.
 *
 * 把 `HttpAdapter` 端口接到 Node 原生 `node:http` 服务器：监听本机端口，
 * 把收到的 HTTP 请求翻译成 `HttpRequest`，交给 `HoneycombTransport.dispatch()`
 * 处理（复用全部 REST 路由），再把 `HttpResponse` 写回 socket。
 *
 * 特性：
 * - 默认 127.0.0.1，端口可配（0 = 随机，`listen()` 后经 `port` 读取真实值）。
 * - 自动解析 URL path + query；POST/PATCH 读取 JSON body。
 * - 响应统一 `application/json`；OPTIONS 预检直接 204（供前端跨源调用的便捷项，
 *   真实 CORS 策略由接入端 host 层或主进程代理决定，这里不内置任何 origin 放行）。
 *
 * 与内存版的关系：`HoneycombTransport.dispatch()` 是唯一路由入口；内存版经
 * `MemoryHttpAdapter.dispatch()`（自匹配），真实版经本类把真实 socket 请求翻译后
 * 复用同一 `dispatch()`。路由逻辑零重复。
 *
 * @module @whalepod/honeycomb/transport
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import type { HoneycombTransport } from './port'
import type { HttpRequest, HttpResponse } from './types'

/** 从 Node IncomingMessage 读 body（按文本收集，JSON 解析留到 dispatch 前）。 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export interface NodeHttpServerOptions {
  /** 监听地址；默认 127.0.0.1。 */
  host?: string
  /** 端口；默认 0（随机）——本类推荐显式传 0 或由接入端指定。 */
  port?: number
}

/**
 * 真实 HTTP 服务器：把 `node:http` 请求映射到 `HoneycombTransport.dispatch()`.
 */
export class NodeHttpAdapter {
  readonly server: http.Server
  private readonly transport: HoneycombTransport
  private readonly host: string
  private readonly port: number
  private _listening = false

  constructor(transport: HoneycombTransport, options: NodeHttpServerOptions = {}) {
    this.transport = transport
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 0
    this.server = http.createServer((req, res) => void this.handle(req, res))
  }

  /** 真实监听端口（`listen()` 解析后可用）。 */
  get actualPort(): number {
    const addr = this.server.address() as AddressInfo | null
    return addr ? addr.port : 0
  }

  /** 是否已监听。 */
  get listening(): boolean {
    return this._listening
  }

  /** 解析真实请求 → `HttpRequest` → `transport.dispatch()` → 写回。 */
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // OPTIONS 预检
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Honey-Actor',
          'Content-Length': '0',
        })
        res.end()
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const body = await readBody(req)
      const httpReq: HttpRequest = {
        method: (req.method ?? 'GET') as HttpRequest['method'],
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body: body ? safeJson(body) : undefined,
      }

      const httpRes = await this.transport.dispatch(httpReq)
      let payload: string
      try {
        payload = JSON.stringify(httpRes.body)
      } catch (e) {
        payload = JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: `stringify: ${String(e)}` } })
      }
      res.writeHead(httpRes.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': Buffer.byteLength(payload),
      })
      res.end(payload)
    } catch (error) {
      const payload = JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: String(error) } })
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(payload)
    }
  }

  /** 开始监听。resolve 的真实端口（01 用例可直接读 `actualPort`）。 */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this._listening = true
        this.server.removeListener('error', reject)
        resolve()
      })
    })
  }

  /** 关闭服务器。 */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this._listening) return resolve()
      this.server.close((err) => (err ? reject(err) : resolve()))
    })
  }

  /** 暴露给共享 upgrade（WS）使用的底层服务器与在监听 socket 上注册 upgrade。 */
  onUpgrade(listener: (req: http.IncomingMessage, socket: Socket, head: Buffer) => void): void {
    this.server.on('upgrade', listener)
  }
}

/** 安全 JSON 解析：非 JSON 内容当字符串处理（一般 body 均为 JSON）。 */
function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
