# honeycomb quickstart — 一条命令演示 hive 全流程

`npm run example`（= `tsx examples/hive-quickstart/index.ts`）—— 用一个 mock worker
把「建 hive → 孵化成员 → 建任务 → 派工 → 交付 → courier 消息 → 事件流 / 落盘恢复」
完整演出来。它是活文档，也是后续接入真编排/真连接的联调入口。

## 跑起来

```bash
cd packages/honeycomb && npm run example
```

预期输出（节选）：

```
✔ ① hive 建成 hive_1_j135zdhc (queen=member_2_y6k39vuq)
✔ ② worker 就绪 member_4_jkptveoj (status=idle)
✔ ③ 任务入账 task_6_d0l2opbh → status=backlog
  📬 [worker:…] 收到派工 →「打包吧」，干完，经 courier 回 report…
✔ ④ 派工：task 置 in-progress + 归属 worker；directive 已送达 handle（sendTo=true）
✔ ⑤ 交付：task → status=completed
✔ 女王收件箱: 1 条（其中 1 条 worker report）
重启重放: hive=quickstart task=completed member=worker
```

## 每步对应哪个 service / 事件

| 步骤 | 代码 | service（ctx.*） | 触发的事实/事件 |
|---|---|---|---|
| 装配 | `await apply(ctx, {...})` | plugin | 落盘目录 `persistenceDir`（默认 `~/.dfh/hive`） |
| ① 建 hive | `ctx.hive.create(...)` | **hive** | 女王孵化：`member/status`、`member/hatched` → `hive/created` |
| ② 孵化 worker | `ctx.roster.hatch(...)` | **roster** | `member/status(hatching/idle)`、`member/hatched` |
| ③ 建任务 | `ctx.ledger.create(...)` | **ledger** | `task/created`（status=backlog） |
| ④ 派工 | `ctx.ledger.update(...)` + `ctx.courier.send(directive)` + `ctx.roster.sendTo(...)` | **ledger**/**courier**/**roster** | `task/updated`（in-progress+owner）、`message/created`（王→工） |
| worker 上报 | mock 句柄 `send()` → `ctx.courier.send(report)` | **courier** | `message/created`（工→王，kind=report） |
| ⑤ 交付 | `ctx.ledger.update(...completed)` | **ledger** | `task/updated`（completed） |
| 终态 | `ctx.roster.list` / `ctx.courier.inbox` | roster/courier | 名册 / 收件箱一致 |
| 恢复 | `FactStore(JsonlFactBackend{dir})` + `load()` | persistence | 重启重放重建快照 |

## 参数怎么改

- **落盘目录**：`apply(ctx, { persistenceDir: '/path' })`（示例用 `mkdtemp` 每次临时目录；
  想持久共享，改成固定路径即可）。
- **默认目录**：不传 `persistenceDir` 时默认 `~/.dfh/hive`（`defaultFactDir()`）。
- **idleTimeoutMs**：`apply(ctx, { idleTimeoutMs })`。>0 时编排循环会周期扫 idle 成员并
  `dismiss`（示例用 0 关闭，专注演示派工→交付）。
- **workspaceMode**：`ctx.hive.create({ workspaceMode: 'shared' | 'hlead' | … })`。
- **换 runtime**：`mock` → 想接真运行时，把 `backend: 'mock'` 换成已注册的后端 id；
  示例先 `ctx.roster.registerRuntime(mock)` 注册了 `mock` 后端。

## 切到「真编排循环」

当前 `examples/hive-quickstart/index.ts` 用 **mock 驱动**把步骤显式演出来（更确定、可读）。
要切到真实的 `src/consumer/orchestration-loop.ts` 事件驱动循环，模板见下——

```ts
import { createOrchestrationLoop } from '../../src/consumer/orchestration-loop'

const loop = createOrchestrationLoop({
  ctx,
  roster: { list: (id) => ctx.roster.list(id), sendTo: (h,m,msg) => ctx.roster.sendTo(h,m,msg), dismiss: (h,m) => ctx.roster.dismiss(h,m) },
  ledger: { list: (h,f) => ctx.ledger.list(h,f) },
  applyTask: async (_h, p) => { /* ctx.ledger.update(p.taskId, {status,owner}) */ },
  config: { idleTimeoutMs: 0 },
})
loop.onEvent((e) => console.log('[loop]', e.type))
loop.start([hive.id])
// 之后只需建任务，循环会监听 task/created → 自动派工 → 收 report → 自动 completed
```

### ⚠️ 已知阻塞 bug（src/，未修，等对应 owner）

切真循环前，`src/consumer/orchestration-loop.ts` 有两处问题（**任务边界要求不改 src/**，
故此示例暂用 mock 驱动规避）：
1. **`stop()` 崩溃**（`:314`）：`listeners` 里存的是 `ctx.on(...)` 返回的**注销函数**，
   但 `stop()` 写成 `l.dispose()`，函数没有 `.dispose`，会抛
   `l.dispose is not a function`。应改为 `l()`（直接调用注销函数）。
2. **与 mock/无连接运行时组合时事件链路悬空**：`dispatchFor` 的 async 链在有 report
   回环时可能反复重派同一任务（示例实测曾无限打转直到超时）。这通常与
   `applyTask` 的 owner 清空（`owner: null`）与 `isIdleWorker` 判定耦合有关，
   接真连接后由循环 owner 统一处理。

> 想切真循环：先由 **架构-Pro-2 / 循环 owner** 修掉上面两点，再把本示例步骤 ④⑤ 替换成
> `loop.start` + 一个 `ledger.create` 即可。

## 文件

```
examples/hive-quickstart/
├── index.ts   可运行示例（mock 驱动全流程 + 事件流 + 落盘恢复）
└── README.md  本说明
```

（注：只新增 `examples/` 与 `package.json` 的 `example` script，未改任何 `src/`。）
