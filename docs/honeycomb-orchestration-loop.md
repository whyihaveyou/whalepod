# @dfh/honeycomb 编排循环设计（consumer/orchestration-loop.ts 详解）

> 文档编号：DFH-WS / HONEY-002
> 产品：DFH Workstation
> 核心包：`@dfh/honeycomb`
> 责任人：架构-Pro-1
> 状态：设计稿 v1
> 前置文档：[honeycomb-orchestration-architecture.md](./honeycomb-orchestration-architecture.md)（本文档所有类型/事件/服务引用其 §3/§5/§6/§7/§8）
> 下游读者：实现-Pro-2（本文档是其实现 `consumer/orchestration-loop.ts` 的直接依据）

---

## 0. 摘要

编排循环（`OrchestrationLoop`）是 `@dfh/honeycomb` 里唯一的**主动调度者**：它订阅 hive 事件，把 `ledger` 里可执行的任务派给空闲的 worker，跟踪 worker 的交付与失败，并处理依赖阻塞与 idle 超时。

**三条核心决策：**

1. **纯事件驱动，零轮询**。循环没有任何定时轮询队列的逻辑；一切派工都由事件触发（§2）。唯一的定时器是 idle 超时（§7），它也不是轮询，而是「空闲后启动一个一次性计时器」。
2. **状态所有权三分**。`Member.status`、`Member.workState`、`Task.status` 分别由不同层拥有，循环只写自己拥有的，杜绝双写竞争（§1）。
3. **派工幂等可重入**。任意事件都可以触发一次 `dispatchPass()`，循环内部去重，重复触发不产生重复派工（§4）。

---

## 1. 职责边界（谁拥有哪些状态）

这是实现正确性的前提，必须先钉死：

| 状态 | 拥有者 | 语义 | 写入方 |
| --- | --- | --- | --- |
| `Member.status`（MemberStatus） | **运行时层**（hatch/dismiss 的 Fiber） | 成员进程/轮次的**生命周期**态 | 运行时经 `member/status` 事件声明 |
| `Member.workState`（WorkState） | **编排循环** | 成员的**工作队列**态（手头有没有活、卡在哪） | 循环调用 `roster.assign` 等驱动 |
| `Task.status`（TaskStatus） | **编排循环** | 任务的**生命周期**态 | 循环调用 `ledger.update` |
| `Task.blockedBy / blocks` | 数据（循环维护） | 依赖边 | `ledger.addDependency/removeDependency` |
| `Task.owner` | **编排循环** | 任务当前归属 | 循环 `ledger.setOwner` |

**铁律**：
- 循环**绝不**直接写 `Member.status`——它只读该状态判断「谁空闲、谁失败」，然后通过 `roster.assign/dismiss/resume` 请求运行时去变。
- 运行时**绝不**写 `Task.status` 或 `Member.workState`——它只发 `member/status` 事件。
- 由此，`Member.status` 与 `Member.workState` 的交叉处（如「working 但 workState=queued」）不会出现脏写，最多是瞬时观察不一致，循环用「事件序」而非「轮询读」来收敛。

---

## 2. 驱动模型：事件驱动（订阅清单）

循环在启动时（`apply(ctx)` 内）订阅以下事件，**每个事件都指向一个 handler**，绝不轮询：

| 订阅事件 | 触发原因 | 循环动作 |
| --- | --- | --- |
| `task/created` | 新任务进台账 | `dispatchPass(hiveId)` |
| `task/updated`（change=`status`） | 任务状态变化（含依赖解除后的完成） | 见 §6 依赖解阻塞 + `dispatchPass` |
| `member/hatched` | 新 worker 可用 | `dispatchPass(hiveId)` |
| `member/status`（→`idle`） | worker 空闲 | `dispatchPass(hiveId)` |
| `member/status`（→`failed`） | worker 失败 | 回滚该成员在办任务（§9）→ `dispatchPass` |
| `member/dismissed` | worker 被遣散 | 回滚该成员在办任务（§9）→ `dispatchPass` |
| `message/created`（kind=`report`） | worker 交付 | 交付闭环（§5）→ `dispatchPass` |
| `message/created`（kind=`shutdown-request`） | queen 请求遣散 | 走 §7 的 shutdown 协商，不派工 |

**为什么不用轮询**：
1. 事件序即因果序：`report` 到达 → 任务 complete → worker 回 idle，事件天然保证先后，无需扫描。
2. 负载为零：没有可派工时循环完全静默，不产生任何 CPU/DB 开销。
3. 可恢复：事件来自仅追加事实日志，进程重启后重放事件即可重建调度状态（§11）。

---

## 3. 核心数据结构（循环内部派生视图）

循环不落库任何「调度快照」，只维护两件内存态：

```ts
class OrchestrationLoop {
  /** 每个成员的 idle 起始时间（用于 idle 超时）；workState 回到 idle 且队列空时记录 */
  private idleSince = new Map<MemberId, number>();

  /** 每个成员的一次性 idle 计时器（NodeJS.Timeout）；被任何新派工取消 */
  private idleTimers = new Map<MemberId, ReturnType<typeof setTimeout>>();

  /** 防重入锁：某 hive 正在 dispatchPass 时不重复进入 */
  private dispatching = new Set<HiveId>();
}
```

> 注：这些视图都能由事实日志重建——`idleSince` 可由「最近一条 `member/work-state {idle}` 事件」推导。因此即便崩溃后重启，回放事实即可恢复。

---

## 4. Queen 派工算法

### 4.1 可执行任务选择（runnable）

```text
runnable(hiveId) =
  ledger.list(hiveId, { status: "backlog", runnable: true })
    .filter(t => t.blockedBy 中不存在任何 status != "completed" 的任务)
    .sort(by 优先级)   // 默认 FIFO（createdAt 升序）
```

- `runnable` 是**派生谓词**，不落库：`blockedBy` 全部 completed 才算可执行。
- 优先级默认 FIFO；扩展点：`dispatch/rank` **waterfall**，插件可为每个任务打分（`next()` 委派默认打分 0），循环按分数降序。

```ts
// 概念级：rank 钩子
const score = await ctx.waterfall("dispatch/rank", task, 0);
```

### 4.2 空闲 worker 选择

```text
idleWorkers(hiveId) =
  roster.list(hiveId)
    .filter(m => m.role === "worker"
              && m.status === "idle"
              && m.workState === "idle")
```

对每个待派任务 `selectWorker(task, pool)` 按以下顺序打分取最优：

1. **能力匹配**：`mandate.grants(worker)` 的能力矩阵满足任务所需能力（外部 CLI 的 `TeammateDescriptor.capabilities` 透传到此）；
2. **队列深度**：`queued.foreground + queued.background` 最小者优先；
3. **公平性**：`lastDispatchedAt` 最久者优先（round-robin）。

选出的 worker 从 `pool` 移除，保证一个 worker 一轮只接一个任务（避免「一个 worker 被连续喂爆、其余饿死」）。

### 4.3 派工后的状态流转

```
dispatch(task, worker):
  ledger.update(task.id, { status: "in-progress", owner: worker.id })  # ①
  roster.assign(worker.id, task.id)                                     # ②
```

事件序（精确）：

```
① task/updated { task, change:"status" }      // backlog → in-progress
   task/updated { task, change:"owner" }      // owner: null → worker.id
② member/work-state { state:"queued" }        // idle → queued（循环拥有）
   member/work-state { state:"starting" }     // queued → starting（运行时开始 turn）
   member/status { status:"working" }         // idle → working（运行时拥有）
   member/work-state { state:"running" }      // starting → running
   loop/dispatch { taskId, memberId }         // 循环可观测事件
```

> `loop/dispatch` 是循环新增的观测事件（§10 增补），实现与前端都可订阅它做派工审计。

---

## 5. Worker 交付闭环

### 5.1 正常路径

```
worker 完成 turn
  → 运行时发 member/status { status:"idle" }            # working → idle
  → worker 发 report 消息（courier.send kind:"report"）
  → message/created { message kind:"report" }
  → 循环 onMessage(e):
       task = ledger.getByOwner(worker.id)   # 该 worker 在办的任务
       verdict = await waterfall("delivery/review", task, message, "accept")
       if verdict == "accept":
         ledger.update(task.id, { status:"completed" })
       else:
         rollback(task)   # 见 §9.3，重派
       → dispatchPass(hiveId)   # 触发下一个可执行任务
```

事件序（accept 路径）：

```
message/created { message kind:"report" }
task/updated { task, change:"status" }      // in-progress → completed
member/work-state { state:"idle" }          // running → idle（队列已空）
（若有下一个可执行任务）循环继续 dispatchPass → 回到 §4.3 序列
```

### 5.2 交付评审钩子 `delivery/review`（waterfall）

`delivery/review` 是交付的**唯一裁决点**（与 `mandate/decide`、`tools/pre-execute` 同构）：

```ts
// 概念级
type DeliveryVerdict = "accept" | "reject";
// 默认策略（next() 委派）返回 "accept"；
// queen 策略插件可插入，依据 report 内容决定 reject → 触发 rollback 重派。
```

- **accept** → `task → completed`，闭环；
- **reject** → 任务回滚（owner 清空、status → backlog、attempts+1），worker 收到一条 `note` 消息说明驳回原因，随后重派（§9.3）。

---

## 6. 依赖阻塞（blockedBy）

### 6.1 挂起语义

- 依赖未满足的任务**停在 `backlog`**（不单独置 `blocked`），只是 `runnable` 谓词为 false，因此**永远不会被派工**。
- 区分：`Task.status == "blocked"` 保留给「已派工但 worker 运行态受阻（paused/blocked）」的场景，与 `blockedBy` 无关。

### 6.2 解除与自动恢复

```
某任务 X 完成（task/updated change:"status" = completed）
  → 循环 onTaskUpdated:
       for (Y in X.blocks):              # 反向边，找出所有被 X 阻塞的任务
         if runnable(Y):                 # Y 的 blockedBy 已全部 completed
           → dispatchPass(hiveId)        # Y 自动进入可派工池
```

- `blocks` 反向边在 `ledger.addDependency` 时由循环同步维护，使「解除阻塞」的查找是 O(被阻塞任务数)，而非全表扫描。
- 事件序（依赖解除）：

```
task/updated { X, change:"status" }        // X → completed
（循环判定 Y 已 runnable）
task/updated { Y, change:"status" }        // 若 Y 曾被标记，此处仅当 Y 显式变更才发
→ 直接进入 §4.3 派工序列（dispatch(Y, worker)）
```

> 注意：Y 停留在 `backlog` 时，解除依赖**不产生** Y 的 `task/updated`（Y 的状态没变）；「可派工」是谓词推导，体现在「下一轮 dispatchPass 把 Y 纳入池子」，最终以 `loop/dispatch` 事件宣告 Y 被派工。

---

## 7. Idle 超时与自动 dismiss

`HoneycombConfig.idleTimeoutMs` 的语义：worker 空闲（workState=idle 且队列空）超过该阈值后，循环自动 `dismiss` 该 worker，回收其运行时资源。

```
onMemberIdle(memberId):                       # work-state → idle 且队列空
  idleSince.set(memberId, now())
  if member.role == "worker" && config.idleTimeoutMs > 0:
    idleTimers.set(memberId, setTimeout(() => {
      if 该成员仍空闲:
        roster.dismiss(memberId)              # → member/dismissed → §9.2 回滚
    }, config.idleTimeoutMs))

onAnyAssign(memberId):                        # 该成员被派新活
  clearTimeout(idleTimers.get(memberId))
  idleTimers.delete(memberId)
  idleSince.delete(memberId)
```

- **queen 不自动 dismiss**（默认），除非配置显式允许；否则 leader 被超时遣散会导致团队失主。
- 计时器是**一次性**的（不是周期轮询）；成员重新派工即取消。计时器由 `ctx.effect` 托管，插件 dispose 时统一清理，避免泄漏。
- 事件序（自动 dismiss）：

```
（idle 超时）
member/dismissed { memberId }               # dismiss 触发
（若该成员有在办任务，先触发 §9.2 的回滚事件序列）
```

### 7.1 shutdown-request 协商（非强制）

queen 想主动遣散 worker 时走协商，避免强杀正在写文件的 worker：

```
queen → courier.send(kind:"shutdown-request", to:worker)
worker 收到后自行收尾 → 回 courier.send(kind:"note", 内容 "shutdown_approved")
queen 收到 approved → roster.dismiss(worker)
```

- 这与 idle 自动 dismiss 是两条独立路径；协商路径由**业务消息**驱动，超时路径由**计时器**驱动，二者最终都汇聚到 `roster.dismiss`。

---

## 8. 与 MemberStatus × WorkState 状态机的关系

循环是 `WorkState` 与 `Task.status` 的唯一写者，是 `MemberStatus` 的读者。下面给出完整转移表与「每次转移 emit 哪个事件」。

### 8.1 MemberStatus（运行时拥有，循环只读）

| 转移 | 触发 | emit |
| --- | --- | --- |
| `hatching` → `idle` | 运行时就绪 | `member/status { status:"idle" }`（hatch 起点另有 `member/hatched`） |
| `idle` → `working` | turn 启动 | `member/status { status:"working" }` |
| `working` → `idle` | turn 完成 | `member/status { status:"idle" }` |
| `working` → `failed` | 运行时崩溃/执行错误 | `member/status { status:"failed", note }` |
| `idle` → `dormant` | dismiss 保留 | `member/dismissed`（+ status 逻辑置 dormant） |
| `dormant` → `idle` | resume | `member/status { status:"idle" }` |

### 8.2 WorkState（循环拥有）

| 转移 | 触发 | emit |
| --- | --- | --- |
| `idle` → `queued` | `roster.assign` 入队 | `member/work-state { state:"queued" }` |
| `queued` → `starting` | 运行时开始 turn | `member/work-state { state:"starting" }` |
| `starting` → `running` | turn 执行中 | `member/work-state { state:"running" }` |
| `running` → `idle` | turn 完成且队列空 | `member/work-state { state:"idle" }` |
| `running` → `paused` | 暂停请求 | `member/work-state { state:"paused" }` |
| `paused` → `running` | 恢复 | `member/work-state { state:"running" }` |
| `*` → `blocked` | 运行时受阻（starting/removing/session 停） | `member/work-state { state:"blocked", blockedReason }` |
| `blocked` → `queued` | 阻塞解除 | `member/work-state { state:"queued" }` |

### 8.3 Task.status（循环拥有）

| 转移 | 触发 | emit |
| --- | --- | --- |
| `backlog` → `in-progress` | 派工 | `task/updated { change:"status" }` + `change:"owner"` |
| `in-progress` → `completed` | report 被 accept | `task/updated { change:"status" }` |
| `in-progress` → `backlog` | worker 失败/被遣散/驳回 | `task/updated { change:"status" }`（owner 清空） |
| `in-progress` → `blocked` | worker 运行态受阻（paused/blocked） | `task/updated { change:"status" }` |
| `blocked` → `in-progress` | worker 恢复 | `task/updated { change:"status" }` |
| `backlog`/`blocked` → `cancelled` | queen 取消或 attempts 超限 | `task/updated { change:"status" }` |

**交叉不变量**（循环保证，实现需断言）：
- `Task.status == "in-progress"` ⇒ 存在唯一 `owner`，且该 owner 的 `workState ∈ {queued, starting, running, paused}`；
- `Task.status == "blocked"` ⇒ owner 的 `workState == "blocked"`（或 paused）；
- `Member.status == "working"` ⇒ `workState == "running"`（瞬时允许 starting 过渡）。

---

## 9. 错误 / 失败处理

### 9.1 worker `failed`

```
member/status { status:"failed", note }
  → 循环 onMemberStatus:
       inProgress = ledger.list(hiveId, { status:"in-progress", owner:memberId })
       for task in inProgress:
         rollback(task, reason:"worker-failed")
       → dispatchPass(hiveId)
```

### 9.2 worker 被 `dismiss`

同 9.1：在办任务全部回滚重派，逻辑一致（`reason:"worker-dismissed"`）。

### 9.3 回滚 / 重派 `rollback(task)`

```
rollback(task, reason):
  attempts = (task.attempts ?? 0) + 1
  if attempts > config.maxDispatchAttempts:      # 默认 3
    ledger.update(task.id, { status:"cancelled" })   # 放弃
    courier.send(kind:"system", to:"all", content:"任务放弃：<subject>（失败 3 次）")
  else:
    ledger.update(task.id, { status:"backlog" })     # owner 清空
    ledger.setOwner(task.id, null)
    ledger.touchAttempts(task.id, attempts)          # 见 §10 增补
    # task 回到 backlog 且 runnable → 由 dispatchPass 重派给别的 worker
```

事件序（失败回滚，以 failed 为例）：

```
member/status { status:"failed", note }
task/updated { task, change:"status" }      // in-progress → backlog（或 cancelled）
task/updated { task, change:"owner" }       // owner → null（若 backlog 重派）
loop/skip { taskId, reason:"..." }          // 若无空闲 worker 承接，则 skip
→ 若重派成功 → §4.3 派工序列
```

### 9.4 失败隔离

- 单个 worker `failed` 只影响**它自己**在办的任务，不影响同 hive 其它 worker（事件 scope-filtered + 回滚按 owner 过滤）。
- 重派天然换 worker：回滚后 owner 清空，`dispatchPass` 重新选空闲者，不会再次选中已 failed 的成员（其 `status != idle`）。

---

## 10. 对架构文档的增补（API Addendum）

编排循环的实现需要架构文档（HONEY-001）补充以下接口；实现-Pro-2 需同步确认。

### 10.1 `Task` 增补字段（HONEY-001 §3.3）

```ts
interface Task {
  // ...原有字段
  /** 派工尝试次数（失败重派上限用），默认 0 */
  attempts?: number;
  /** 最近一次 owner（owner 清空后保留审计） */
  lastOwner?: MemberId;
}
```

### 10.2 `RosterService` 增补方法（HONEY-001 §6.1）

```ts
interface RosterService {
  // ...原有方法
  /** 投递任务到成员队列并启动 turn（编排循环专用写入口） */
  assign(memberId: MemberId, taskId: TaskId): Promise<void>;
  /** 成员恢复（dormant → idle），复用 dismiss 的反向路径 */
  resume(memberId: MemberId): Promise<void>;
}
```

### 10.3 事件词汇增补（HONEY-001 §8）

```ts
interface HiveEventMap {
  // ...原有事件
  /** 循环派工（可观测/审计） */
  "loop/dispatch": { hiveId: HiveId; taskId: TaskId; memberId: MemberId };
  /** 循环跳过派工（无可派 worker / 依赖未满足） */
  "loop/skip":    { hiveId: HiveId; taskId: TaskId; reason: "no-worker" | "not-runnable" | "dep-blocked" };
}
```

### 10.4 waterfall 钩子增补（HONEY-001 §8）

| 钩子 | 语义 |
| --- | --- |
| `dispatch/rank` | 派工优先级打分；`next()` 委派默认 0（FIFO） |
| `delivery/review` | 交付评审；`next()` 委派默认 `accept` |

### 10.5 `HoneycombConfig` 增补（HONEY-001 §10）

```ts
interface HoneycombConfig {
  // ...原有字段
  /** 失败重派上限，默认 3 */
  maxDispatchAttempts?: number;
  /** 是否允许自动 dismiss queen，默认 false */
  autoDismissQueen?: boolean;
}
```

---

## 11. 主循环伪代码（完整）

```ts
export const name = "honeycomb-orchestration-loop";

export function apply(ctx: Context, config: HoneycombConfig) {
  ctx.inject(["roster", "ledger", "courier", "mandate"], (roster, ledger, courier, mandate) => {
    const loop = new OrchestrationLoop(ctx, config, { roster, ledger, courier, mandate });
    loop.start();
    ctx.effect(() => loop.stop());   // dispose 时注销订阅 + 清理 idle 计时器
  });
}

class OrchestrationLoop {
  private idleSince  = new Map<MemberId, number>();
  private idleTimers = new Map<MemberId, ReturnType<typeof setTimeout>>();
  private dispatching = new Set<HiveId>();

  constructor(private ctx, private config, private svc) {}

  start() {
    this.ctx.on("task/created",    e => this.onDispatchTrigger(e.hiveId));
    this.ctx.on("task/updated",    e => this.onTaskUpdated(e));
    this.ctx.on("member/hatched",  e => this.onDispatchTrigger(e.hiveId));
    this.ctx.on("member/status",   e => this.onMemberStatus(e));
    this.ctx.on("message/created", e => this.onMessage(e));
    this.ctx.on("member/dismissed",e => this.onMemberDismissed(e));
  }
  stop() { /* 注销所有订阅 + clearTimeout 所有 idleTimers */ }

  // ---------- 派工核心 ----------
  async onDispatchTrigger(hiveId: HiveId) {
    if (this.dispatching.has(hiveId)) return;      // 防重入
    this.dispatching.add(hiveId);
    try { await this.dispatchPass(hiveId); }
    finally { this.dispatching.delete(hiveId); }
  }

  async dispatchPass(hiveId: HiveId) {
    const runnable = (await this.svc.ledger.list(hiveId, { status: "backlog", runnable: true }))
      .filter(t => !t.blockedBy.length || t.blockedBy.every(id => this.isDone(id)));

    const pool = (await this.svc.roster.list(hiveId))
      .filter(m => m.role === "worker" && m.status === "idle" && this.workStateOf(m) === "idle");

    for (const task of this.rank(runnable)) {
      if (!pool.length) {
        this.ctx.emit("loop/skip", { hiveId, taskId: task.id, reason: "no-worker" });
        break;
      }
      const worker = this.selectWorker(task, pool);
      pool.splice(pool.indexOf(worker), 1);
      await this.dispatch(task, worker);
    }
  }

  async dispatch(task: Task, worker: Member) {
    await this.svc.ledger.update(task.id, { status: "in-progress", owner: worker.id });
    await this.svc.roster.assign(worker.id, task.id);     // WorkState: idle→queued→starting
    this.clearIdleTimer(worker.id);
    this.ctx.emit("loop/dispatch", { hiveId: task.hiveId, taskId: task.id, memberId: worker.id });
  }

  async rank(tasks: Task[]): Promise<Task[]> {
    const scored = [];
    for (const t of tasks) scored.push([await this.ctx.waterfall("dispatch/rank", t, 0), t]);
    return scored.sort((a, b) => b[0] - a[0]).map(([, t]) => t);   // 分数高者优先，同分 FIFO
  }

  selectWorker(task: Task, pool: Member[]): Member {
    // 1 能力匹配 → 2 队列最浅 → 3 最久未派工
    return pool.sort((a, b) =>
      this.capMatch(b, task) - this.capMatch(a, task) ||
      this.queueDepth(a) - this.queueDepth(b) ||
      this.lastDispatchedAt(a) - this.lastDispatchedAt(b))[0];
  }

  // ---------- 交付闭环 ----------
  async onMessage(e) {
    if (e.message.kind !== "report") return;
    const task = await this.taskByOwner(e.message.from);        // 该 worker 在办任务
    if (!task) return;
    const verdict = await this.ctx.waterfall("delivery/review", task, e.message, "accept");
    if (verdict === "accept") {
      await this.svc.ledger.update(task.id, { status: "completed" });
    } else {
      await this.rollback(task, "report-rejected");
    }
    await this.onDispatchTrigger(e.hiveId);
  }

  // ---------- 依赖解除 ----------
  async onTaskUpdated(e) {
    if (e.change === "status" && e.task.status === "completed") {
      for (const dependentId of e.task.blocks) {         // 反向边
        if (await this.isRunnable(dependentId)) {
          await this.onDispatchTrigger(e.task.hiveId);   // 依赖解除 → 派工
          break;
        }
      }
    }
  }

  // ---------- 失败 / 遣散回滚 ----------
  async onMemberStatus(e) {
    if (e.status === "failed") {
      for (const t of await this.inProgressBy(e.memberId)) await this.rollback(t, "worker-failed");
      await this.onDispatchTrigger(e.hiveId);
    } else if (e.status === "idle") {
      this.markIdle(e.memberId);                          // 启动 idle 超时计时器
      await this.onDispatchTrigger(e.hiveId);
    }
  }

  async onMemberDismissed(e) {
    for (const t of await this.inProgressBy(e.memberId)) await this.rollback(t, "worker-dismissed");
    await this.onDispatchTrigger(e.hiveId);
  }

  async rollback(task: Task, reason: string) {
    const attempts = (task.attempts ?? 0) + 1;
    if (attempts > (this.config.maxDispatchAttempts ?? 3)) {
      await this.svc.ledger.update(task.id, { status: "cancelled" });
      await this.svc.courier.send(task.hiveId, {
        from: "system", to: "all", kind: "system",
        content: `任务放弃：${task.subject}（失败 ${attempts} 次）`,
      });
    } else {
      await this.svc.ledger.update(task.id, { status: "backlog" });
      await this.svc.ledger.setOwner(task.id, null);
      await this.svc.ledger.touchAttempts(task.id, attempts);   // 增补方法
    }
  }

  // ---------- idle 超时 ----------
  markIdle(memberId: MemberId) {
    const m = this.svc.roster.get(this.hiveOf(memberId), memberId);
    if (!m || m.role !== "worker") return;
    if (this.config.autoDismissQueen === false && m.role === "queen") return;
    if (!this.config.idleTimeoutMs) return;
    this.idleSince.set(memberId, Date.now());
    this.idleTimers.set(memberId, setTimeout(async () => {
      if (this.stillIdle(memberId)) await this.svc.roster.dismiss(this.hiveOf(memberId), memberId);
    }, this.config.idleTimeoutMs));
  }
  clearIdleTimer(memberId: MemberId) {
    clearTimeout(this.idleTimers.get(memberId));
    this.idleTimers.delete(memberId);
    this.idleSince.delete(memberId);
  }
  // ...isDone / isRunnable / inProgressBy / taskByOwner / workStateOf / queueDepth 等辅助方法略
}
```

---

## 12. 时序图（ASCII）

### 12.1 正常派工 → 交付 → 闭环

```
 Queen        Ledger          Loop            Roster/Runtime      Worker
   │             │               │                 │                │
   │  create task│               │                 │                │
   ├────────────▶│── task/created▶│                 │                │
   │             │               │── dispatchPass ─▶│                │
   │             │◀─update(in-prog)│                │                │
   │             │── task/updated▶│                 │                │
   │             │               │── assign ───────▶│── 启动 turn ──▶│
   │             │               │◀─ work-state:queued→starting      │
   │             │               │◀─ status:working──────────────────┤
   │             │               │◀─ loop/dispatch                   │
   │             │               │                 │      …执行…     │
   │             │               │◀─ status:idle────────────────────┤
   │             │               │◀─ report(kind:"report")───────────┤
   │             │               │── waterfall delivery/review       │
   │             │◀─update(completed)                                │
   │             │── task/updated▶│                                  │
   │             │               │◀─ work-state:idle                 │
   │             │               │── dispatchPass（下一个任务）        │
```

### 12.2 依赖阻塞 → 解除 → 恢复派工

```
   │             │               │                 │                │
   │  task A（blockedBy B）进 backlog，runnable=false                 │
   │             │               │── dispatchPass：skip A（not-runnable）
   │  task B 完成│               │                 │                │
   ├────────────▶│── task/updated(B completed)▶│                    │
   │             │               │── 检查 A ∈ B.blocks              │
   │             │               │── A 已 runnable → dispatchPass   │
   │             │               │── assign A ──────▶│──────────────▶│
   │             │               │◀─ loop/dispatch(A)                │
```

### 12.3 worker 失败 → 回滚 → 重派

```
   │             │               │                 │                │
   │             │               │◀─ status:failed───────────────────┤
   │             │               │── 找 owner=worker 的 in-progress  │
   │             │◀─update(backlog) + owner=null                     │
   │             │── task/updated▶│                                  │
   │             │               │── dispatchPass → 换 worker        │
   │             │               │◀─ loop/dispatch(新 worker)         │
```

---

## 13. 精确事件序列汇总（实现-Pro-2 速查）

| 场景 | 事件序列（顺序） |
| --- | --- |
| 派工 | `task/updated{status}` → `task/updated{owner}` → `member/work-state{queued}` → `member/work-state{starting}` → `member/status{working}` → `member/work-state{running}` → `loop/dispatch` |
| 正常交付 | `message/created{report}` → `task/updated{completed}` → `member/work-state{idle}` → （下一任务，重复派工序列） |
| 依赖解除 | `task/updated{完成者, completed}` → （无额外 task/updated）→ 派工序列 |
| worker 失败 | `member/status{failed}` → `task/updated{backlog}` → `task/updated{owner=null}` → （`loop/skip{no-worker}` 若无空闲）→ 或派工序列 |
| worker 遣散 | `member/dismissed` → （同失败回滚序列） |
| 报告驳回 | `message/created{report}` → `task/updated{backlog}` → `task/updated{owner=null}` → 派工序列 |
| 重派超限放弃 | `member/status{failed}` → `task/updated{cancelled}` → `message/created{system}` |
| idle 自动 dismiss | （计时器到期）→ `member/dismissed` → （同遣散回滚序列） |
| 暂停/恢复 | `member/work-state{paused}` → `task/updated{blocked}` →（恢复）`member/work-state{running}` → `task/updated{in-progress}` |

---

## 14. 交付物与实现边界

**本文档交付：**
- 事件驱动的派工/交付/依赖/失败四类闭环的伪代码与状态转移；
- 三张时序图；
- 一张精确事件序速查表；
- 对 HONEY-001 的接口增补清单（§10）。

**实现-Pro-2 的边界：**
- 实现 `consumer/orchestration-loop.ts`，严格遵循 §1 状态所有权三分与 §13 事件序；
- 循环**不得**直接写 `Member.status`、不得引入轮询；
- 依赖本文档 §10 增补的 `RosterService.assign/resume`、`Task.attempts/lastOwner`、`LedgerService.touchAttempts` 与 `loop/*` 事件、`delivery/review` + `dispatch/rank` 钩子；
- 崩溃恢复：回放事实日志重建 `idleSince`（由最近一条 `work-state{idle}` 推导）后，重启时对每个 hive 执行一次 `dispatchPass` 补派遗留任务。

---

## 15. 关键设计决策记录

1. **事件驱动零轮询**：派工完全由事件触发，唯一计时器是 idle 超时，且为一次性非周期。
2. **状态所有权三分**：`Member.status`（运行时）/ `Member.workState` + `Task.status`（循环）严格分离，杜绝双写竞争。
3. **依赖用数据而非状态表达**：`blockedBy` 未满足 = 停留 `backlog` 且 `runnable=false`；`Task.status=blocked` 留给「已派工但运行态受阻」，避免两套阻塞语义混淆。
4. **派工幂等**：`dispatchPass` 可被任意事件重复触发，防重入锁 + 选出的 worker 从池中移除，保证不重复派工。
5. **交付/派工均可扩展**：`delivery/review`（accept/reject）与 `dispatch/rank`（打分）两个 waterfall 钩子，让 queen 策略插件可插入而不改核心循环。
6. **失败重派有上限**：`maxDispatchAttempts` 防死循环，超限转 `cancelled` 并系统广播。
