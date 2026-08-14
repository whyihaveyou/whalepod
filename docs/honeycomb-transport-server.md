# @dfh/honeycomb transport 真网络服务接入说明

> 文档编号：DFH-WS / HONEY-006
> 产品：DFH Workstation
> 核心包：`@dfh/honeycomb`
> 责任人：架构-Pro-1
> 状态：定稿（任务 #01a00107）
> 前置契约：[honeycomb-transport-api.md](./honeycomb-transport-api.md)
> 读者：实现-Pro-3（前端联调）、主进程/桌面壳（server 生命周期）

---

## 0. 摘要

本说明面向把 honeycomb 的 **真实网络服务**（HTTP REST + WebSocket 实时推送）接入运行环境的人。目前 transport 有两种形态：

| 形态 | 入口 | 特点 |
| --- | --- | --- |
| 内存版 | `createMemoryTransport(ctx)` | 进程内，无网络栈；供测试 / 单元 / 主进程桥「翻译后注入」 |
| **真网络版** | `createNodeTransportServer(ctx, opts)` 或 `config.transport.enabled` | 监听真实 TCP 端口，REST 走 `fetch`、WS 走真连接 |

本文档讲**真网络版**：代码位置、怎样启动、默认端口与如何指定、前端如何连、生命周期。

---

## 1. 代码位置

```
packages/honeycomb/src/transport/
  http.ts      # NodeHttpAdapter —— node:http 起监听，请求 → transport.dispatch()
  ws.ts        # NodeWsAdapter   —— ws.WebSocketServer，事件 → 前端推送
  server.ts    # createNodeTransportServer(ctx, opts) —— HTTP+WS 一体化装配
  core.ts      # createHoneycombTransport(ctx) —— 构建 transport + 注册全部 REST 路由
  (…types/port/router/subscribe/memory 为既有骨架)
```

从包根直接导出：`import { createNodeTransportServer, NodeHttpAdapter, NodeWsAdapter } from '@dfh/honeycomb'`

依赖：`node:http` + `ws@^8`（WS 服务端必需，Node 核心只有客户端 WebSocket，无服务端能力）。

---

## 2. 快速启动

### 2.1 直接调 API（推荐主进程/桌面壳用）

```ts
import { Context, apply, createNodeTransportServer } from '@dfh/honeycomb'

const ctx = new Context()
await apply(ctx, { persistenceDir: '/path/to/hive-data' })

const server = await createNodeTransportServer(ctx, {
  host: '127.0.0.1', // 默认
  port: 0,           // 0 = 随机可用端口（默认），避免端口冲突
})

console.log(`REST+WS: http://${server.host}:${server.port}`)
// WS 端点固定为 /ws → ws://${host}:${port}/ws

// …前端连接…
await server.close() // 应用退出时
```

### 2.2 经插件配置自动启动

在 `HoneycombConfig` 里开 transport 开关，插件 boot 后自动起 server，并跟随 `ctx.dispose()` 自动关闭：

```ts
await apply(ctx, {
  persistenceDir: '/path/to/hive-data',
  transport: {
    enabled: true,   // 打开
    host: '127.0.0.1',
    port: 8765,      // 指定固定端口
  },
})
```

启动失败仅告警（`console.warn`），不阻断核心服务——核心 5 个 service 已就绪，接入端可之后手动 `createNodeTransportServer` 补救。

---

## 3. 默认端口 & 如何指定

| 项 | 默认 | 说明 |
| --- | --- | --- |
| host | `127.0.0.1` | 仅本机可连，不暴露公网。若要局域网访问改 `0.0.0.0`（自行权衡安全）。 |
| port | `0`（随机可用端口） | `createNodeTransportServer` 缺省 `0`，启动后读 `server.port` 拿真实端口。 |
| **固定端口默认值** | `8765` | 仅当走 `config.transport.port` 且**未显式指定**时，`resolve` 用 `DEFAULT_TRANSPORT_PORT = 8765` 兜底。 |

> 注意：直接调 `createNodeTransportServer({ port })` 时 `port` 缺省是 `0`（随机）；而 `config.transport.port` 缺省是 `8765`。两者语义一致（都是「指定端口号」），随机 vs 固定取决于你是否显式传值。

**指定端口示例：**
```ts
// 固定端口
createNodeTransportServer(ctx, { port: 8765 })
// 或
apply(ctx, { transport: { enabled: true, port: 8765 } })

// 随机端口（拿真实值）
const s = await createNodeTransportServer(ctx, { port: 0 })
console.log(s.port) // 实际监听端口
```

---

## 4. REST 调用（前端/测试）

- 基址：`http://{host}:{port}`
- 端点、方法、请求/响应形态**完全遵守** `honeycomb-transport-api.md §3`；
- 响应统一：`{ ok: true, data }` / `{ ok: false, error: { code, message } }`；
- 查询参数 JSON 编码：`GET /v1/hives/{id}/tasks?filter={"runnable":true}`（本项目 fetch 写法见下，query 放 `URLSearchParams` 或手拼均可）。

```ts
// 建 hive
const r = await fetch(`${base}/v1/hives`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '团队A', workspace: '/tmp/a' }),
})
const { data: hive } = await r.json()

// 查询任务（runnable 过滤）
const u = new URL(`${base}/v1/hives/${hive.id}/tasks`)
u.searchParams.set('filter', JSON.stringify({ runnable: true }))
const { data: tasks } = await (await fetch(u)).json()
```

---

## 5. WebSocket 调用（前端/测试）

- 端点：`ws://{host}:{port}/ws`（挂载路径默认 `/ws`，可用 `wsPath` 改）。
- 协议：完全遵守 `honeycomb-transport-api.md §4`。

```
客户端 → 服务端：
  { "type": "subscribe",   "hiveId": "hive_xxx" }
  { "type": "unsubscribe", "hiveId": "hive_xxx" }
  { "type": "hello", "client": "panel", "version": 1 }

服务端 → 客户端：
  { "type": "subscribed",   "hiveId": "hive_xxx" }        // ack：订阅已生效
  { "type": "unsubscribed", "hiveId": "hive_xxx" }
  { "type": "hello", "ok": true }
  { "type": "event", "topic": "task/created", "hiveId": "hive_xxx", "payload": { … } }
```

> ⚠️ **关键：先等 `subscribed` ack 再触发事件**。由于订阅消息与 REST 触发事件走两条独立连接/时序，若在订阅尚未生效时就触发，会丢首个事件。正确顺序：
> 1. `send({type:'subscribe', hiveId})`
> 2. `await` 收到 `{type:'subscribed'}` ack
> 3. 再开始发查询/操作，事件才会被推回。

```ts
import WebSocket from 'ws' // 前端浏览器用原生 new WebSocket(...)

const ws = new WebSocket(`ws://${host}:${port}/ws`)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const events = []
ws.onmessage = (e) => events.push(JSON.parse(e.data))

// 订阅（服务端会回 subscribed ack）
ws.send(JSON.stringify({ type: 'subscribe', hiveId }))
// …等到 events 里出现 { type:'subscribed' }，再触发业务…
```

`hiveId` 判定：事件帧 `hiveId` 字段由服务端从事件 payload 推导（带 `hiveId` 字段直接用；`{task}/{message}/{hive}` 取对象内 `hiveId`）。前端可再按需二次过滤。

---

## 6. 生命周期与释放

```ts
// 方式 A：手动
const server = await createNodeTransportServer(ctx, { port: 0 })
await server.close()           // 停 http server + ws server + 关闭所有 WS 连接
void server.transport          // 内部 HoneycombTransport 实例

// 方式 B：经 config.transport.enabled（插件绑定）
await ctx.dispose()            // 自动 close server（注册了 onDispose）
```

- `server.close()` 幂等：未监听则直接返回。
- WS 连接在 close 时被 `terminate()`，释放 socket。
- `SubscribeCenter` 的事件监听在 `ws.close()` 时注销，避免泄漏。

---

## 7. 端到端闭环验证（测试）

`test/transport-http.test.ts` 起真实 server，证明全链路：

```
建 hive(REST) → 查 hive(REST) → WS 订阅(等 ack) → REST 建 task(触发 task/created) → WS 收到 event 帧
```

运行：`npx tsx test/transport-http.test.ts`（Node 22 自带 fetch，`ws` 客户端连真 socket）。

---

## 8. 接入检查清单（实现-Pro-3）

- [ ] REST 基址 = `http://{host}:{port}`；端点/响应结构照 `honeycomb-transport-api.md §3`；
- [ ] WS 地址 = `ws://{host}:{port}/ws`；订阅前先等 `subscribed` ack；
- [ ] 共享类型：`import type` 复用 `@dfh/honeycomb` 的 `Hive/Task/Message/Member…` DTO，不另写一套 JSON 类型；
- [ ] 端口：开发期可用 `port: 0` 拿随机端口，或固定 `8765`；
- [ ] 出错统一判断 `res.ok === false` 读 `res.error.code/message`。
