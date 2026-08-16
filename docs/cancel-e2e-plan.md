---
title: Cancel ⑦ E2E 测试方案 —— 全链路场景矩阵 + CI 纳入判据
status: design
owners: 架构-Pro-2
date: 2026-08-16
related: 01a0086c-be0c-7302-af2a-6510a8e27212
parent: docs/cancel-lifecycle.md（设计稿）、docs/honeycomb-transport-api.md §3.4
---

# Cancel ⑦ E2E 测试方案

> 本方案定「cancel 链路跨层串联」的 E2E 断言基线与 CI 纳入判据。
> **不写实现** —— 落地实现另起实施卡（建议按 §6 切分派单）。
> 既有两套单测（cancel-dispatch 25 例 / transport-cancel 6 例）是对照组：E2E 只补
> 跨层**真实串联**(真 transport server + 真 persistence + 真 runtime 句柄)，不重复
> 单测已锁的断言。

## 0. 地基盘点（已经上 main 的硬事实）

| 层 | 锚点 | 锚定 commit |
| --- | --- | --- |
| `RuntimeHandle.cancel?()` + `AgentSessionHandle.cancel()`（feature-detect 协议级 cancel / 降级 close+30s / cancelInProgress 去重 + 泵侧 idle 改写） | runtime/{registry,agent-runtime}.ts | 9edf767 |
| 编排循环看门狗先 cancel 再 failDispatch + `cancelTask(hiveId,taskId,reason)` 入口 + `task-cancelled` 事实 | consumer/orchestration-loop.ts + persistence/{facts,store}.ts | 9edf767 + a9c2894（fold owner 清空修复） |
| REST `POST /v1/tasks/{id}/cancel`（202 / 幂等 202 / TASK_NOT_FOUND 409 / TASK_TERMINAL 409 / TASK_NOT_RUNNING 409 / ORCHESTRATION_UNAVAILABLE 503） | transport/{router,core,server,memory,port,types}.ts | a9c2894 |
| native-runtime cancel（feature-detect 原生中断 / 降级 kill-after-30s / cancelled 事件 / idle 回写 / 幂等） | runtime/native-runtime.ts（⑤） | 525fd46 |
| 测试对照组 | test/cancel-dispatch.test.ts（25 例）、test/transport-cancel.test.ts（6 例）、test/native-runtime.test.ts（13 例）、test/connector-cancel.test.ts（8 例） | 已在 CI pinned |
| CI pinned 现状 | `node --import tsx --test` 单命令，17 项 | ci.yml cc716b3 |

**E2E 要补的真空层**（单测现在盖不到的地方）：
- **真 transport server**（真 Node http+ws socket）+ **真 persistence**（tmp 目录 FactStore）+
  **真 runtime 句柄**（真 AgentSessionHandle/NativeHandle 挂在 roster 上）三层同时在线时，
  cancel 链路的**时序串**是否完好（单测各层独立断言过，没串过）；
- 三 adapter 路径在**同一调度/事件命名层**下行为是否可观察可区分；
- 跨层**竞态场景**（cancel×完成撞车、cancel×看门狗撞车）在真实计时下是否确定性收敛。

## 1. 全链路 E2E 场景矩阵（断言基线）

E2E 夹具（quickstart 复用 **`assets/` 下 shell harness 型**）：
```
boot(persistenceDir=tmp, orchestration=loop(ctx 级), server=createNodeTransportServer,
     rosterFactory=<adapter-specific>, hive/task/member seed via REST)
```
所有场景断言采用「**时序锚点[]**」记法——按序断言，每层断言独立可读，
失败 dump 实际事件序列（遵守测试断言铁律）。

### 场景 A（HTTP 完整闭环 · 在途任务取消全链）🏅 主路径

REST POST → 编排 disarm+applyTask → fact → roster.cancelTask → runtime graceful →
work-state idle → WS task/updated 广播 → transport-client HoneycombWsClient 收到。

| # | 层 | 断言锚点 |
| --- | --- | --- |
| A1 | HTTP 响应 | status `202`；`body.ok=true`；`body.data.id=<taskId>`；`body.data.status='cancelled'`；`body.data.owner` falsy |
| A2 | persistence fact | FactStore replay 得到 task：`status='cancelled'`、`owner===undefined`、`updatedAt===fact.at`；追加的 `task-cancelled` fact 含 `taskId`/`memberId=<owner>`/`reason=<请求体 reason>>`/`at`；**owner 清空不回写**（fold 修复回归） |
| A3 | WS 广播链 | 订阅 hive 的 honeycombWsClient 在 cancel 后收到 `task/updated` 帧：payload.task.id===taskId、payload.task.status==='cancelled'；**无新消息类型**（不断言 task-cancelled 专属帧） |
| A4 | roster 优雅通道 | roster runtime handle 被 `cancelTask(memberId)`，`handle.cancel?()` 至少调一次（ACP/native 各路径断言见 §2） |
| A5 | 成员状态回收 | member 的 `member/work-state` 帧显示 `idle`（native 路径，从 native-runtime ⑤ idle 回写；ACP 路径经泵侧 idle 改写）；**不被误标 blocked/failed** |
| A6 | REST 回读 | `GET /v1/hives/{hiveId}/tasks/{id}`：`status==='cancelled'`、owner falsy |
| A7 | 看门狗清零 | 取消后再过 `dispatchTimeoutMs`，**不再二次触发 failDispatch / 不再二次触发 roster.cancelTask**（disarm 生效） |

### 场景 B（幂等 · 重复 cancel）

B1 第一次 cancel A 全链；B2 第二次 cancel → `202` + 快照不变化；fact 数恒 1；roster.cancelTask 恒 1；A7 看门狗行为不变。

### 场景 C（不存在任务 → `409 TASK_NOT_FOUND`）

REST 409 + `error.code='TASK_NOT_FOUND'` + `error.message` 含 id；无 fact 写入；roster.cancelTask 0 次；WS 无新帧。

### 场景 D（终态任务 → `409 TASK_TERMINAL`）

前置 `PATCH status='completed'`，cancel → 409 + `error.code='TASK_TERMINAL'` + message 含 `completed`；无 task-cancelled fact；roster.cancelTask 0 次。

### 场景 E（未在途任务 → `409 TASK_NOT_RUNNING`）

backlog 任务 cancel → 409 `TASK_NOT_RUNNING`；错误消息含 `backlog`；文档提示的 PATCH 出队路径另行 PATCH 置 cancelled（**不产 task-cancelled fact**，语义差异已有测试锁定）。

### 场景 F（编排未挂钩 → `503 ORCHESTRATION_UNAVAILABLE`）

服务以无 orchestration 的 options.transport 启动；in-progress 任务 cancel → 503 code。其余分支（不存在/终态）不受影响。（**本场景用 transport-cancel 6 例中 ⑥ 已锁，E2E 只作存在性快验**。）

### 场景 G（竞态 · cancel 与 prompt 完成撞车）

驱动：在途任务 → 注入同时期的「完成信号」(native: turn/end completed / ACP: done(0)) 与 cancel 请求。
| # | 断言 |
| --- | --- |
| G1 | REST cancel 仍 202（受理语义 > 终局语义） |
| G2 | fact 至多一条 task-cancelled；若取消落在「completed 先写入」之后，则可能改为「cancel no-op」——**确定性判据见 §3 竞态化解**；快照终态一致（completed XOR cancelled，不出现双重写造成 Undefined terminated state） |
| G3 | 运行时侧：cancelInProgress 置位后，后续 done/cancelled 都在「idle/finished 二态收敛，不出现 failed」（泵侧区分已锁，E2E 只验证端到端不冒出 failed 帧） |

### 场景 H（竞态 · 看门狗 cancel × 用户 cancel 并发）

看门狗到点的尚未发 cancel 时 window 内，用户 REST cancel 又触发。
| # | 断言 |
| --- | --- |
| H1 | roster.cancelTask 总数 ≤ 2（看门狗一次 + 用户一次）且 processable —— 任何时候 cancelInProgress 去重使底层 ≤ 1 次 cancelled 通知 |
| H2 | 任务终态 cancelled；不出现「cancel 后又被看门狗 failDispatch 改出 failed」的自相矛盾帧序列 |
| H3 | runtime 侧 pump 至少一次 idle 帧；不出现 'failed' |

### 场景 I（竞态 · cancel 不存在任务 × 随后任务创建同 id）

C 分支断言基础上：409 之后**不影响**后续同 id（不下规）任务重新创建/派工行为。
（**E2E 价值低——cancel 的幂等由 loop 侧 in-progress 守卫兜底，E2E 只保证 409 不污染后续**。）

### 场景 J（WS 事件时序定型）

按序：dispatch → (REST 契约 wait) → user cancel → expected 帧序列：
```
- (若 ACP) 'member/work-state' idle
- 'task/updated' payload.task.status='cancelled'
```
帧间间隔 ≤ grace window；**完全不出现** 'task-failed' 消息（创建 fact 也不出现）。

**矩阵的分级**：A/B/C/D/E/F/I 是「REST+fact+WS 三层串」(必入 pinned)；G/H/J 是「竞态类」(可选，见 §3)。

## 2. 三 adapter 路径 E2E 策略

原则：不重写新 adapter 类，只用现有入口（connectors/adapters + runtime handles）。

### 2.1 ACP 路径（确定性必过，fixture: `test/fixtures/acp-mock-agent.mjs`）

spawn argv：`acp-mock-agent.mjs`（ACP 1.x NDJSON-over-stdio）；catalog 用现有 `opencode-acp` / `kimi-code-acp`。【已有能力】：
- **`ACP_MOCK_CANCEL_AFTER=<n>`**：第 n stream chunk 后假装收到 session/cancel → pump sees `cancelled` 事件 → agent-runtime WorkState idle 改写（锚定泵侧语义）；
- **`ACP_MOCK_DELAY_MS`**：控制 chunk 间隙 → 控制 REST cancel 落在 cancelAfter 之前/之后（撞车分解于 §4）；
- **`ACP_MOCK_KEEP_ALIVE=1`**：live 测试存活到显式 close。

**E2E 场景接线（ACP）**：
- A 主路径：spawn mock with `ACP_MOCK_DELAY_MS=50`→ task in-progress (REST 契约让 loop.dispatch 或 `ledger.update` hold 态)；REST cancel 在「第 n chunk 之前」到达 → cancelAfter 命中 → 则 pump got cancelled → **anchoring**：ACPs cancel() 越过协议级 `connection.cancel`，泵侧 `cancelled` 事件已经出现 → member idle 帧序断言。
- G 撞车：`ACP_MOCK_CANCEL_AFTER=3` + `ACP_MOCK_DELAY_MS=20` ⇒ chunk1/chunk2 到达后 REST cancel，确认 chunk3（已是 cancelled 响应）到达后再不收到 stream/working 帧 ⇒ 终 brake 在 idle。

### 2.2 stdio adapter 路径（无协议 cancel → 降级 close + 30s 优雅窗口）

4 stdio adapter（opencode/codex/kimi/hermes）**本身无 `cancel?()`**，按 ② 契约 `AgentSessionHandle.cancel()` 降级 `gracefulCloseWithTimeout(30_000)`。**fixture**：现有 `test/fixtures/dsh-mock-agent.mjs`（若可控输出事件）/重写一个 `degraded-stdio-mock`：
- 收到 `close()` → 依次发 `tool-result / stream / done(exit 143)`（模拟 SIGTERM）→ pump sees done→cancelled（语义已由单测覆盖，E2E 不重复抽检）→ **assert**：成员回收仍走 idle（cancelInProgress 改写已开）；
- **若未来 stdio agent 需真实测试 send 协议**：再补一扇 legacy 会话事件序列（cancel 之前/之后的差别仅发生在 window 内的 done 时序——两种顺序下 final state 都必须为 idle，不允许 failed）。

**E2E 场景接线（stdio）**：A 场景同 ACP，只是 A4 断言改为「close() 被调一次，30s window 内退出前可能经过 kill()（不强制）」。由于 stdio 无协议 cancel，**不 assertion 事件 cancelled 到达**（它不发生）——assertion 的是终态 idle + 没闸 failed。

### 2.3 native 路径（真实现已有 ⑤，13 例基线）

native-runtime.test.ts 13 例已覆盖 handle 层语义。E2E **新增**只串「REST → 编排 → native handle.cancel」并断言 `agent.cancel('cancelled by honeycomb orchestrator')` 至少命中一次的**可观察副作用**：DSH 会话 turn 序列在 cancelled 之后再无新 turn（概念验证用 ctx.agents 桩，① 基线已建立）。

**E2E 固定接线（native，确定性）**：ctx.agents 提供 fake registry（native-runtime.test.ts 同款）；dispatch via loop（真 catch） → 断言取消后 fact + WS idle 序列。

## 3. CI 纳入判据（pinned vs 本地分界）

按 `connector-cancel`/`cancel-dispatch`/`transport-cancel` 三部先例确立：

| 纳入 | 判据 |
| --- | --- |
| ** pinned 必绿** | ① 不 spawn 真实外部 CLI（fixtures 全部 mjs 本地 mock）<br>② 不依赖 kimi/codex/gemini 真实 CLI 存在<br>③ 分支断言按「在同一时刻跑 N 次都过」的确定性时序（cancelInProgress/折叠确定性 mask 化）<br>④ 运行时长 ≤30s/例 |
| **本地/live opt-in** | ① 需真实 CLI（`RUN_ACP_LIVE=1` 类）<br>② live native DSH runtime 起会话（long-living）<br>③ 人工诊断才用的慢竞态回放 |

**初步判定**：

| 场景 | 判定 | 备注 |
| --- | --- | --- |
| A 在途闭环（ACP + stdio + native） | ✅ pinned | 全 mock/deterministic |
| B 幂等 | ✅ pinned | 同 A |
| C/D/E/F 错误分支 | ✅ pinned | transport-cancel 已有 lib 对照, pinned 复用 |
| G/H/J 竞态 | ✅ pinned（**若**确定性可达）/ ⛔ 否则降级本地 | G 需要 mock 对「REST 到达 vs chunk 到达」绝对可控；固定 `ACP_MOCK_DELAY_MS` + REST 先响应再 wait 读取 WS 应能确定性达成 (打断时机≤1 chunk 粒度) |
| I | ⛔ 不引 pinned | 价值低,已在错误分支单测中被「409 不影响后续」覆盖 (transport-cancel ⑥ 断言了无 loop 的服务后任务仍送达 409) |
| live kimi / live native | ⛔ opt-in | 按 connector-live/acp-kimi-live 惯例 (`RUN_*_LIVE=1`) 单独 RUN，不进 pinned |

**违反判据即不入 pinned**：一旦有测试只在 macOS 绿 / 在长 OOM 下绿 / 靠 sleep 维绿 → 拆出去或标 skip。**铁律：宁 skip 不假绿**。

## 4. 边界竞态清单（已知碰撞点 + 规避断言）

| 竞态 | 机械 | E2E 断言对策 |
| --- | --- | --- |
| **cancel 与 prompt 完成撞车** | cancelInProgress 为 true 后，pump 见 done(0) → finished 优先（9edf767 泵侧已锁） | G 场景：A4 断言敢信「终态 finished 且**不**有 failed/canclled 帧」；不强制任务快照 cancelled（按受理语义 202 OK, 快照由完成先行占了 completed) |
| **重复 cancel 幂等** | 同 ①-④；cancelInProgress 一次置位后续 no-op | B 场景：fact 恒 1、roster.cancelTask 恒 1、REST 仍 202 |
| **cancel 不存在任务** | REST 先到，后续添加同 id 任务互不相关 | I 场景低优，pinned 不引入 |
| **看门狗 cancel × 用户 cancel 撞车** | watchdog cancel fire-and-forget（不阻塞 failDispatch 回收）≠ 用户 cancel REST 同步受理 | H 场景断言「roster.cancelTask ≤2 次 且任一时刻 process 至多 1 次底层 cancelled 通知」+ 「不出现 cancelled→failed 帧序」 |
| **task-cancelled vs task-failed 事实区分** | ❗目前是「类型写一个 task-cancelled，状态写一个 status」两条并存；`task-failed` 词表不存在 | A/J 场景断言：cancel 后 replay facts 里 **有一条 task-cancelled 且没 task-failed**；快照 status='cancelled'。**当未来 leader 把 task-failed 提词表**，此处断言改「task-failed 0 条、task-cancelled 1 条」不变 |
| **owner 复活（折叠顺序）** | a9c2894 已修：task-cancelled fold `owner=undefined`（不回写 memberId） | A2 断言「replay task owner===undefined」——对 route 整体责任人 (E2E 实现者) 留作核查点 |
| **运行时 cancel ≠ 编辑级幂等到 PM prompt 的语义** | 协议级 cancel 后客户端可能收到后续 tool_call/approval 残留（live kimi 实观） | 不并入 pinned；live 下探 disclosure |

## 5. 与现有测试的分工（断言不重叠）

| 文件 | 覆盖 | E2E 新增只 Assert |
| --- | --- | --- |
| `test/cancel-dispatch.test.ts` (25) | registry/胶水/泵侧/看门狗/loop 入口/fold | –（E2E 不重断言） |
| `test/transport-cancel.test.ts` (6) | REST 语义全分支 + orchestration 未挂钩 + WS 收到 task/updated | E2E 只补 CLOSE 相关串联，托管复用现有断言；unique 断言：**server 级时序** 「cancel → WS 到达 距离间隔」 |
| `test/native-runtime.test.ts` (13) | native handle.cancel 语义（⑤） | E2E 只串 REST→编排→native agent.cancel 调用点 |
| `test/connector-cancel.test.ts` (8) | 4 stdio 无 cancel 契约断言 + AcpSession 有 cancel | E2E 不重断言 |
| **新 E2E（建议名 `test/cancel-e2e.test.ts`）** | — | 场景矩阵 A–H + J 逐条断言锚点。**不写成 25+6 重复断言的「第三个包」**。 |

## 6. 实施切分建议（供派单，非本设计内容）

| 块 | 范围 | 估时 | 依赖 |
| --- | --- | --- | --- |
| E2E-boot 夹具 | tmp persistence + server+loop+嫁接 WS wsClient | 0.5 天 | 无 |
| 场景 A（原生路径 + stdio 对照） | 主链 + 幂等 + 错误分支 | 1 天 | 夹具 |
| 场景 A（ACP） | ACP_MOCK 复用 + cancel 事件锚定 | 0.5 天 | fixture 已有 |
| 竞态 G/H/J | ACP_MOCK_DELAY/CANCEL_AFTER 时序 + 帧序 assert | 1 天 | 夹具+A |
| CI 纳入 | ci.yml +1（cancel-e2e.test.ts） | 0.1 天 | 上全会 |

（满足 leader「E2E 收官」范围之外的可选追加 —— stdio 降级的 legacy 时序更多覆盖。）

## 7. 不合适 / 我反对纳入的事

- ❌ **为 E2E 同时实现完整四个 stdio adapter 的 spawn 协议 stub** —— 连接器-Pro 契约早就 feature-detect 过；E2E 唯一需要 stdio 的是「close+30s 回调被触达一次」的降级断言，现 mock 已足。
- ❌ **在 E2E 里引入真 LLM 会话 token 费用** —— live path（RUN_ACP_LIVE=1 / 真 DSH）保持 opt-in 即可；
- ❌ **复制 transport-cancel 6 例进 E2E** —— §5 已划分；唯一例外是 G/H/J 竞态不同源跨层。

---

**下一步**：leader 审本方案 → 若无语业问题，派实施卡按 §6 切分（可派回同一 owner 或共享到编排-Pro/实现-Pro-1 按其时跟团节奏）。
