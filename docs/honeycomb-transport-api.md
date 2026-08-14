# @dfh/honeycomb transport 层设计（API surface）

> 文档编号：DFH-WS / HONEY-003
> 产品：DFH Workstation
> 核心包：`@dfh/honeycomb`
> 责任人：架构-Pro-1
> 状态：设计稿 v1（定稿）
> 前置文档：[honeycomb-orchestration-architecture.md](./honeycomb-orchestration-architecture.md)（服务接口 DTO 定义见其 §5/§6）、[honeycomb-orchestration-loop.md](./honeycomb-orchestration-loop.md)
> 位置：`packages/honeycomb/src/transport/`
> 下游读者：实现-Pro-3（React 前端对接本 API surface）

---

## 0. 摘要

honeycomb 目前只有**进程内 service + 事件**，没有面向前端（React 团队面板）的传输层。本文定义 transport 层，把 5 个 service（`hive` / `ledger` / `courier` / `mandate` / `roster`）暴露成 **HTTP + WebSocket**：

- **查询与变更走 REST**（`GET` / `POST` / `PATCH` / `DELETE`），返回 JSON；
- **实时推送走 WebSocket**（事件订阅，服务端把 honeycomb 的 emit 事件推给前端）。

**三条核心决策：**

1. **Transport 是「薄适配层」**。它不实现业务逻辑，只做「URL/消息 → 服务方法」的翻译。所有数据形态直接复用 `types.ts` 里的 DTO 与领域模型，不新增第二套 JSON 结构。
2. **REST / WS 共享同一套「资源路径」词汇**。REST 端点路径与 WS 订阅主题共用一组资源名（`hive` / `member` / `task` / `message` / `activity`），前端学一次即可。
3. **内存版骨架不接真实网络栈**。本包不含 koa/express/ws 依赖；transport 定义一组**端口接口（Port）**（`HttpAdapter` / `WsAdapter`），内存版用「内存路由 + 内存订阅中心」实现，真实网络适配器（Node http + ws，或主进程桥）在接入端注入。这样接口先行、可编译、签名清晰，符合「内存版实现骨架」的交付要求。

---

## 1. 传输层职责与边界

### 1.1 做什么

- 把 5 个 service 的**查询方法**映射成 `GET` 端点（`list` / `get` / `inbox` / `feed` / `grants` 等）；
- 把 5 个 service 的**变更方法**映射成 `POST` / `PATCH` / `DELETE` 端点；
- 把 honeycomb 的 **emit 事件**桥接成 WS 推送；
- 提供**订阅管理**（前端 WS 连接订阅/退订某个 hive 的事件流）。

### 1.2 不做什么

- 不实现任何业务逻辑（派工、依赖解除、权限裁决都在 service 层，transport 只转发）；
- 不实现认证/鉴权（MVP 阶段不内置登录；前端身份注入 `X-Honey-Bearer` 可留给接入端扩展，见 §6）；
- 不承载静态资源托管（前端静态资源由主进程/桌面壳负责）。

### 1.3 依赖方向

```
transport ──(只调用 service 接口)──▶ services（hive/ledger/courier/mandate/roster）
transport ──(订阅)────────────────▶ ctx（framework 的 on/emit 事件总线）
transport ──(复用 DTO)────────────▶ types / events
```

transport **不**反过来被 service 依赖；transport 也不持有持久化，只借 service 与事件总线。

---

## 2. 端口接口（Port）与内存版结构

transport 把「如何接网络」抽象为两个端口；内存版提供默认实现，真实网络适配器后续注入。

```ts
// transport/port.ts
/** HTTP 请求视图（transport 不绑定具体框架） */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  query: Record<string, string | undefined>
  body: any
}

export interface HttpResponse {
  status: number
  body: any
}

/** HTTP 适配器端口：transport 用它声明一组路由处理器 */
export interface HttpAdapter {
  /** 注册一个路由；`handler(ctx, req) → res`。ctx 承载服务与事件。 */
  route(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pattern: string,
    handler: (req: HttpRequest, transport: HoneycombTransport) => Promise<HttpResponse> | HttpResponse,
  ): void
}

/** WS 推送视图 */
export interface WsMessage {
  topic: string
  payload: any
}

/** WS 客户端连接视图（transport 只发，不实现握手指令细节） */
export interface WsConn {
  id: string
  /** 当前订阅的 hiveId 集合 */
  subscriptions: Set<HiveId>
  send(msg: WsMessage): void
}

/** WS 适配器端口：transport 用它接收连接并驱动推送 */
export interface WsAdapter {
  on(conn: WsConn): void
  off(id: string): void
  // 前端发来的订阅/退订指令会转成对 transport 的调用（见 Schema）
  handleSubscribe(conn: WsConn, hiveId: HiveId): void
  handleUnsubscribe(conn: WsConn, hiveId: HiveId): void
}
```

**内存版**（`transport/memory.ts`）：
- `MemoryHttpAdapter`：内部维护 `{method,pattern,handler}[]`，暴露 `dispatch(method, path, query, body)` 供调用方（主进程桥 / 测试）触发；
- `MemoryWsAdapter`：内部维护 `WsConn[]` 集合 + 一个 `broadcast(topic,payload,hiveId?)` 方法，供 bridge 调用；订阅按 hiveId 过滤。

---

## 3. REST 端点清单（Endpoint Catalog）

> 约定：
> - 路径参数用 `{id}` 占位。
> - 查询参数 `?filter=...` 的取值使用 JSON 编码（避免复杂嵌套），例如 `?filter={"status":"backlog","runnable":true}`。
> - 响应统一包一层 `{ ok, data }`，错误返回 `{ ok:false, error:{ code, message } }`。
> - 有副作用的变更在 service 层触发事件，事件再经 WS 推送，前端通常无需依赖 REST 响应做状态突变。

### 3.1 `hive`（团队服务 → `HiveService`）

| 方法 | 路径 | 调用 service | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/hives` | `hive.list()` | 列所有 hive |
| `GET` | `/v1/hives/{id}` | `hive.get(id)` | 单个 hive |
| `POST` | `/v1/hives` | `hive.create(input)` | `body = CreateHiveInput` |
| `PATCH` | `/v1/hives/{id}/name` | `hive.rename(id,name)` | `body = { name }` |
| `PATCH` | `/v1/hives/{id}/mode` | `hive.setMode(id,mode)` | `body = { mode }` |
| `PATCH` | `/v1/hives/{id}/session-mode` | `hive.setSessionMode(id,mode)` | `body = { sessionMode }` |
| `DELETE` | `/v1/hives/{id}` | `hive.remove(id)` | 删除团队 |

### 3.2 `member`（名册 / 生命周期 → `RosterService`）

| 方法 | 路径 | 调用 service | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/hives/{hiveId}/members` | `roster.list(hiveId)` | 列成员 |
| `GET` | `/v1/hives/{hiveId}/members/{id}` | `roster.get(hiveId,id)` | 单个成员 |
| `GET` | `/v1/hives/{hiveId}/members/{id}/state` | `roster.state(hiveId,id)` | `MemberStateView` |
| `POST` | `/v1/hives/{hiveId}/members` | `roster.register(hiveId,input)` | `body = RegisterMemberInput`（仅登记） |
| `POST` | `/v1/hives/{hiveId}/members/hatch` | `roster.hatch(hiveId,input)` | `body = HatchMemberInput`（孵化） |
| `POST` | `/v1/hives/{hiveId}/members/{id}/dismiss` | `roster.dismiss(hiveId,id)` | 遣散 |
| `PATCH` | `/v1/hives/{hiveId}/members/{id}/name` | `roster.rename(hiveId,id,name)` | `body = { name }` |
| `DELETE` | `/v1/hives/{hiveId}/members/{id}` | `roster.remove(hiveId,id)` | 移除登记 |

> 注：`RosterService.assign(memberId,taskId)` 与 `resume` 属编排循环/恢复内部能力，当前 `RosterService` 未对其开放前端写入口；前端不直接派工（派工由 queen 经 `ledger` 或服务端策略触发）。若后续需要 `resume` 端点，接入端在 `RosterService` 补上对应方法后再加一个 `POST .../resume` 即可，路径与语义已在本 surface 预留。

### 3.3 `task`（台账 → `LedgerService`）

| 方法 | 路径 | 调用 service | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/hives/{hiveId}/tasks` | `ledger.list(hiveId,filter)` | `query.filter`（TaskFilter JSON） |
| `GET` | `/v1/hives/{hiveId}/tasks/{id}` | `ledger.get(id)` | 单个任务 |
| `POST` | `/v1/hives/{hiveId}/tasks` | `ledger.create(hiveId,input)` | `body = CreateTaskInput` |
| `PATCH` | `/v1/hives/{hiveId}/tasks/{id}` | `ledger.update(id,patch)` | `body = TaskPatch` |
| `POST` | `/v1/hives/{hiveId}/tasks/{id}/owner` | `ledger.setOwner(id,owner)` | `body = { owner|null }` |
| `POST` | `/v1/hives/{hiveId}/tasks/{id}/dependency` | `ledger.addDependency(id,blockedBy)` | `body = { blockedBy }` |
| `DELETE` | `/v1/hives/{hiveId}/tasks/{id}/dependency` | `ledger.removeDependency(id,blockedBy)` | `body = { blockedBy }` |

### 3.4 `message`（信使 → `CourierService`）

| 方法 | 路径 | 调用 service | 说明 |
| --- | --- | --- | --- |
| `POST` | `/v1/hives/{hiveId}/messages` | `courier.send(hiveId,message)` | `body = OutgoingMessage`（同步投递） |
| `POST` | `/v1/hives/{hiveId}/messages/deliver` | `courier.deliver(hiveId,message)` | 异步入队，返回 MessageId |
| `GET` | `/v1/hives/{hiveId}/inbox/{recipient}` | `courier.inbox(hiveId,recipient,filter)` | `query.filter`（InboxFilter JSON） |
| `POST` | `/v1/hives/{hiveId}/messages/{id}/read` | `courier.markRead(hiveId,id)` | 标记已读 |
| `POST` | `/v1/hives/{hiveId}/broadcast` | `courier.broadcast(hiveId,from,content)` | `body = { from, content }` |
| `GET` | `/v1/hives/{hiveId}/activity` | `courier.feed(hiveId,cursor?,limit?)` | `query.cursor`,`query.limit`（活动流） |

### 3.5 `mandate`（授权 → `MandateService`）

| 方法 | 路径 | 调用 service | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/mandate/can` | `mandate.can(actor,action,scope?)` | `query = { actor, action, scope? }` |
| `POST` | `/v1/mandate/assert` | `mandate.assert(actor,action,scope?)` | 鉴权失败 403 |
| `GET` | `/v1/mandate/grants/{memberId}` | `mandate.grants(memberId)` | 该成员的授权清单 |

---

## 4. WebSocket 消息 Schema

> WS 端点：`/ws`（内存版为 `MemoryWsAdapter`，真实网络适配器处理 upgrade）。
>
> 前端 WS 连接的两种消息方向：
> - **前端 → 服务端**：`subscribe` / `unsubscribe`（按 hiveId）指令；
> - **服务端 → 前端**：事件推送（`event` 帧）。

### 4.1 客户端 → 服务端（指令）

```jsonc
// 订阅某个 hive 的事件流
{ "type": "subscribe", "hiveId": "hive_xxx" }

// 退订
{ "type": "unsubscribe", "hiveId": "hive_xxx" }

// （扩展）查询能力 / 握手
{ "type": "hello", "client": "panel", "version": 1 }
```

### 4.2 服务端 → 客户端（事件帧）

统一包一层，便于前端统一分发：

```jsonc
{
  "type": "event",
  "topic": "member/status",          // 即 honeycomb 事件名
  "hiveId": "hive_xxx",
  "payload": { /* 事件 payload，见下 */ }
}
```

### 4.3 推送的事件覆盖（前瞻 & 交叉订阅）

transport 订阅 honeycomb 的**全部 emit 事件**（`Events` 合并表），推送给订阅了对应 hive 的连接。事件名、payload 与 `hive/seed-events.ts` / `events.ts` 完全一致：

| topic（hiveId 绑定） | payload |
| --- | --- |
| `hive/created` | `{ hive }` |
| `hive/renamed` | `{ hiveId, name }` |
| `hive/removed` | `{ hiveId }` |
| `member/hatched` | `{ hiveId, member }` |
| `member/dismissed` | `{ hiveId, memberId }` |
| `member/status` | `{ hiveId, memberId, status, note? }` |
| `member/work-state` | `{ hiveId, memberId, state, blockedReason? }` |
| `task/created` | `{ task }` |
| `task/updated` | `{ task, change }` |
| `message/created` | `{ message }` |
| `message/read` | `{ hiveId, messageId }` |

**hiveId 归属判定**：
- 事件 payload 带 `hiveId` 字段 → 直接用它；
- 带完整对象（如 `{ hive }`、`{ task }`、`{ message }`）→ 取对象的 `hiveId`；
- `hive/created` 推给订阅 `"*"`（广播）的连接与即将存在的 hive；`hive/removed` 推给原订阅者。

### 4.4 跨 hive 广播

前端可订阅 `"*"` 以接收不限 hive 的事件（如 `hive/created` 列表刷新）。订阅 `"*"` 时收到所有事件，事件帧的 `hiveId` 字段让前端可过滤。

---

## 5. Service → Transport 映射总表

| Service | 注入点 | 资源前缀（REST） | WS topic 组 |
| --- | --- | --- | --- |
| `HiveService` | `ctx.hive` | `/v1/hives` | `hive/*` |
| `RosterService` | `ctx.roster` | `/v1/hives/{hiveId}/members`, `/v1/hives/{hiveId}/members/{id}` | `member/*` |
| `LedgerService` | `ctx.ledger` | `/v1/hives/{hiveId}/tasks` | `task/*` |
| `CourierService` | `ctx.courier` | `/v1/hives/{hiveId}/messages`, `/inbox`, `/broadcast`, `/activity` | `message/*` |
| `MandateService` | `ctx.mandate` | `/v1/mandate/*` | （无事件，纯查询） |

**注入方式**：transport 在 `apply(ctx)` 时经 `ctx.inject(['hive','roster','ledger','courier','mandate'], ...)` 拿到服务，构造 `HoneycombTransport`，再挂到 `HttpAdapter` / `WsAdapter` 上，并 `ctx.on(each event, filter→push)`。

---

## 6. 错误模型与鉴权（可扩展）

### 6.1 错误

| HTTP 状态 | code | 场景 |
| --- | --- | --- |
| `400` | `BAD_REQUEST` | 缺参/非法 JSON |
| `403` | `FORBIDDEN` | `MandateDeniedError` / `MessageDroppedError`（dropped→`400` 亦可） |
| `404` | `NOT_FOUND` | `get` 未命中 |
| `409` | `CONFLICT` | 状态冲突（如派工/删除在途） |

错误响应统一：

```jsonc
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "mandate denied: ledger.create" } }
```

### 6.2 鉴权

MVP 无真实登录。transport 预留 `X-Honey-Actor` 请求头（可选），接入端可注入当前操作者 `MemberId`；若启用，变更端点会先 `mandate.assert(actor, action, scope)`。默认关闭（`transport.auth = false`）。

---

## 7. 目录结构（建议，与 HONEY-001 §11 衔接）

```
packages/honeycomb/src/transport/
  index.ts            # 导出 transport 装配入口 + 全部 DTO/端口
  types.ts            # REST/WS DTO、HttpRequest/Response、WsMessage/WsConn
  port.ts             # HttpAdapter / WsAdapter / HoneycombTransport 端口接口
  memory.ts           # MemoryHttpAdapter + MemoryWsAdapter（内存版）
  router.ts           # 路由注册：把 5 个服务的方法绑到端点（本 surface §3）
  subscribe.ts        # WS 订阅中心：事件 → 按 hiveId 推送（本 surface §4）
  auth.ts             # 可选鉴权：X-Honey-Actor → mandate.assert（§6.2）
  plugin.ts           # apply(ctx)：注入服务、注册路由、接事件、挂适配器
```

---

## 8. 交付边界（实现-Pro-3 依据）

实现-Pro-3（React 前端）对本 surface 的依赖：

1. **REST 端点**：按 §3 清单调用查询/变更，响应 `{ ok, data }` / `{ ok:false, error }`。
2. **WS 事件流**：连接 `/ws`，发 `subscribe {hiveId}`，收 `event{topic,hiveId,payload}` 帧；事件 payload 结构 = `types.ts` 领域对象。
3. **类型共享**：transport 复用 `@dfh/honeycomb/types` 的全部 DTO；前端可 `import type` 共享类型，无需自行定义第二套。

**本任务（架构-Pro-1）交付**：
- 本文档（API surface 定稿）；
- `src/transport/` 内存版骨架（接口可编译、方法签名清晰）。

实现-Pro-3 的「替换 mock service」任务（`01a000ce…`）将以本 surface 为对接契约，`blocked_by` 本任务（`01a000cd…`）。
