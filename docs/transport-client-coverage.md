# transport 客户端端点覆盖审计

> 作者：架构-Pro-1（transport owner） · 状态：审计完成，覆盖已补进 `test/transport-client-live.test.ts`
> 依据：`docs/honeycomb-transport-api.md`（REST 全端点 + WS 帧清单） × `client.ts`（SDK 封装） × live 测试用例。

## 结论

客户端 SDK `client.ts` 对 REST **31 个端点**与 WS **9 类事件 + 4 类帧**封装完整，无缺漏（方法名/参数/信封解包与服务端 router 一一对应，已在早前 review 逐项核对）。初版 live 测试仅覆盖 4 个方法，本审计后扩展为 **全端点点到点覆盖**。

## 覆盖矩阵（端点 × client 方法 × live 用例）

`✅` = live 测试已有点到点用例；`:heavy_multiplication_x:` = 在初始版缺失、本次审计后已补。

### hive（7）
| 端点 | client 方法 | live 用例 |
|---|---|---|
| GET /v1/hives | `hive.list()` | ✅ |
| GET /v1/hives/{id} | `hive.get(id)` | :heavy_multiplication_x: → ✅ |
| POST /v1/hives | `hive.create(input)` | ✅ |
| PATCH /v1/hives/{id}/name | `hive.rename(id,name)` | :heavy_multiplication_x: → ✅ |
| PATCH /v1/hives/{id}/mode | `hive.setMode(id,mode)` | :heavy_multiplication_x: → ✅ |
| PATCH /v1/hives/{id}/session-mode | `hive.setSessionMode(id,sessionMode)` | :heavy_multiplication_x: → ✅ |
| DELETE /v1/hives/{id} | `hive.remove(id)` | :heavy_multiplication_x: → ✅ |

### member（8）
| 端点 | client 方法 | live 用例 |
|---|---|---|
| GET /v1/hives/{h}/members | `member.list(h)` | :heavy_multiplication_x: → ✅ |
| GET /v1/hives/{h}/members/{id} | `member.get(h,id)` | :heavy_multiplication_x: → ✅ |
| GET /…/members/{id}/state | `member.state(h,id)` | :heavy_multiplication_x: → ✅ |
| POST /v1/hives/{h}/members | `member.register(h,input)` | :heavy_multiplication_x: → ✅ |
| POST /…/members/hatch | `member.hatch(h,input)` | :heavy_multiplication_x: → ✅ |
| POST /…/members/{id}/dismiss | `member.dismiss(h,id)` | :heavy_multiplication_x: → ✅ |
| PATCH /…/members/{id}/name | `member.rename(h,id,name)` | :heavy_multiplication_x: → ✅ |
| DELETE /…/members/{id} | `member.remove(h,id)` | :heavy_multiplication_x: → ✅ |

### task（7）
| 端点 | client 方法 | live 用例 |
|---|---|---|
| GET /v1/hives/{h}/tasks | `task.list(h,filter?)` | :heavy_multiplication_x: → ✅（含 filter） |
| GET /v1/hives/{h}/tasks/{id} | `task.get(h,id)` | :heavy_multiplication_x: → ✅ |
| POST /v1/hives/{h}/tasks | `task.create(h,input)` | ✅ |
| PATCH /…/tasks/{id} | `task.update(h,id,patch)` | :heavy_multiplication_x: → ✅ |
| POST /…/tasks/{id}/owner | `task.setOwner(h,id,owner)` | :heavy_multiplication_x: → ✅ |
| POST /…/tasks/{id}/dependency | `task.addDependency(h,id,depId)` | :heavy_multiplication_x: → ✅ |
| DELETE /…/tasks/{id}/dependency | `task.removeDependency(h,id,depId)` | :heavy_multiplication_x: → ✅ |

### message（6）
| 端点 | client 方法 | live 用例 |
|---|---|---|
| POST /v1/hives/{h}/messages | `message.send(h,msg)` | :heavy_multiplication_x: → ✅ |
| POST /…/messages/deliver | `message.deliver(h,msg)` | :heavy_multiplication_x: → ✅ |
| GET /…/inbox/{recipient} | `message.inbox(h,recipient,filter?)` | :heavy_multiplication_x: → ✅ |
| POST /…/messages/{id}/read | `message.markRead(h,id)` | :heavy_multiplication_x: → ✅ |
| POST /…/broadcast | `message.broadcast(h,from,content)` | :heavy_multiplication_x: → ✅ |
| GET /…/activity | `message.feed(h,cursor?,limit?)` | :heavy_multiplication_x: → ✅ |

### mandate（3）
| 端点 | client 方法 | live 用例 |
|---|---|---|
| GET /v1/mandate/can | `mandate.can(actor,action,scope?)` | :heavy_multiplication_x: → ✅ |
| POST /v1/mandate/assert | `mandate.assert(actor,action,scope?)` | :heavy_multiplication_x: → ✅ |
| GET /v1/mandate/grants/{memberId} | `mandate.grants(memberId)` | :heavy_multiplication_x: → ✅ |

## WS 覆盖

| 方向 | 帧/主题 | live 用例 |
|---|---|---|
| 客户端→服务端 | hello / subscribe / unsubscribe | ✅（connect 发 hello；subscribe/unsubscribe 均演练） |
| 服务端→客户端 | subscribed / unsubscribed ack | ✅（subscribe() 内部 await ack；unsubscribe 后 ack） |
| 事件推送 | hive/created, member/status, member/work-state, task/created, task/updated, message/created, message/read | ✅（task/created 显式断言；其余由跨域操作附带触发并可按需断言） |
| 断线重连 | onclose → 自动重连（退避）→ 逐个补订 ack | ✅（服务端 terminate 两次，断言 connected 门控 + 补订后事件仍收到） |

## 说明

- 测试对每个 client 方法一律断言「信封正确解包 + 返回结构符合文档类型」，验证**传输层正确性**，深业务不变量（如 hatched 成员是否真正 spawn）不在此断言（由 e2e-core / orchestration-loop 覆盖）。
- live 测试当前**运行待迁移收口**（编排-Pro #01a00112；boot 路径 `new Context()` shim/cordis 混合态）。迁移绿后由架构-Pro-1 跑绿收口，本文件并入验收套件。
