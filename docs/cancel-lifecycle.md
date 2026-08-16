---
title: Cancel 链路设计 —— RuntimeHandle → AgentSession → ACP session/cancel
status: design
owners: 架构-Pro-2
date: 2026-08-15
related: 01a0051d-be36-7b70-80f4-e32326f10e02
---

# Cancel 链路设计

> 北极星痒点：现在看板/会话没有「停止」能一路传到 agent 进程。
> 本文给 cancel 链路从「编排循环触发点」到「ACP session/cancel 通知」的完整路径与分工，
> 标注可立刻做的层与等依赖的层，输出可拆分任务清单。

## 0. 现状（已经做好的地基）

| 层 | 已有 | 来源 |
| --- | --- | --- |
| `SessionEvent.cancelled` 变体 | ✅ | f89a70d (cancel follow-up) |
| `AgentSession.cancel?()` optional 契约 | ✅ | f89a70d（5 stdio adapter 走 close/kill 兜底，AcpSession 真实现） |
| `AcpSession.cancel()` 真实现（发 `connection.cancel({ sessionId })`） | ✅ | f89a70d |
| `deriveWorkState('cancelled') → 'idle'` 映射 | ✅ | f1c0e48 (leader 的 typecheck fix) |
| `normalizeSessionEvent('cancelled') → RuntimeEvent.cancelled` | ✅ | f1c0e48 |
| 契约 feature-detect 测试（4 stdio 无 cancel / AcpSession 有 cancel） | ⏳ WIP（连接器-Pro in-flight，未提交）| 预期 `test/connector-cancel.test.ts`；交付后 §7 任务 ① 的「降级分支」才被锁住 |
| 16/16 整套确定性测试（无 cancel 路径回归） | ✅ | 111f45a CI 绿 |
| live kimi acp 端到端（包含 cancel） | ✅ | d10f2b6 RUN_ACP_LIVE=1 opt-in |

**未做（本文档要解决的范围）**：
- `RuntimeHandle.cancel?()`（runtime/registry.ts）
- `AgentSessionHandle` 把 cancel 透传到底层 session 的胶水
- 编排循环的「dispatch 看门狗到点时」是否触发 cancel
- 任务事实层区分 `cancelled`（用户/编排主动）vs `failed`（系统故障）
- transport 侧的 cancel REST/WS 通道（等 #01a004b1-9056 决议）
- native-runtime 路径的 cancel（编排-Pro 收尾 native-runtime 后协调）

**设计闭环条件**：连接器-Pro 的契约 feature-detect 测试交付后，本设计表的「降级分支」才被真锁住；交付前的实现是「按契约设计稿」施工。

## 1. 设计目标

1. **一条「挂断」能传到 agent 进程**——从上（用户按停止 / queen 决策）到下（ACP `session/cancel` 通知 / stdio SIGTERM）的全链路打通。
2. **feature-detect 友好**——有 cancel 的后端（ACP）用 cancel；没有的后端（stdio）降级 close/kill，调用方零分支。
3. **任务事实可追溯**——cancel 后任务事实日志明确写 `cancelled`（而不是 `failed`），重派决策据此分流。
4. **编排循环自洽**——已有的 dispatch 看门狗（`dispatchTimeoutMs` 到点）应先尝试 cancel 再 failDispatch；不再让超时只看报告就强行失败。
5. **native-runtime 兼容**——和编排-Pro 的 native cancel（走 DSH 会话中止）使用同一套 RuntimeHandle.cancel() 契约。

## 2. 完整链路

### 2.1 触发源

谁能发起 cancel：

| 触发方 | 是否允许 | 理由 |
| --- | --- | --- |
| queen（编排循环） | ✅ | 派工超时 / 任务被撤回 / 显式 cancel |
| 任务 owner（queen 之上的人类/agent） | ✅ | 通过 mandate service 委派（待 transport 决议） |
| 普通 worker | ❌ | "我自己干不下去" = 失败，记 failed 而非 cancel |
| 用户 UI（dsh web 看板点停止） | ✅ | 走 transport 通道，最终落到 queen（待 #01a004b1-9056） |

### 2.2 全路径

```
[UI 点停止]  →  transport POST /hive/:id/member/:mid/cancel
                              ↓ (待 #01a004b1-9056)
[queen 决策] →  orchestration-loop.cancelTask(taskId, reason)
                              ↓
                  roster.cancelTask(hiveId, taskId, reason)
                              ↓
                  runtime.cancelTask(memberId)        ← 新增 RuntimeRegistry 方法
                              ↓
                  handle.cancel()                    ← 新增 RuntimeHandle.cancel?()
                              ↓
       ┌──────────────────────┴──────────────────────┐
       │                                             │
[AcpSession.cancel() 可用]                 [StdioSession 无 cancel]
       ↓                                             ↓
connection.cancel({ sessionId })            session.close() (SIGTERM)
   ↓                                              ↓ (兜底) session.kill() (SIGKILL)
   ↓                                       in-flight send() 拒绝 / events 收尾
   ↓
in-flight prompt() 收到通知
   ↓
agent 响应 stopReason='cancelled'
   ↓
AcpSession 发 'cancelled' SessionEvent
   ↓
deriveWorkState('cancelled') → 'idle'
   ↓
member/work-state 转移回 idle
   ↓
orchestration loop 收到 RuntimeEvent.cancelled
   ↓
标记任务事实 cancelled（而非 failed），可选自动重派
```

### 2.3 状态机视角

```
[worker.status]                 [member.work-state]              [task.status]
idle ─────┐                     idle ─────┐                      pending/running
         │派工                         │working                        ↓
working ←┘                       working ←┘                            running
   │                                  │                                  │
   │ (stuck > dispatchTimeoutMs)      │ (cancelled 事件 / done=137/143) │
   ↓                                  ↓                                  ↓
   watchdog 触发                  ┌─ cancel(ACP) ─→ cancelled 事件 ─→ idle
   ├─ 1. handle.cancel()         └─ close/kill(stdio) ─→ done(exit 137/143) ─→ idle
   │                                                                  │
   ↓                                                                  ↓
[失败分支]                                                        task.status
failDispatch (re-dispatch or rollback)                             = 'cancelled'
                                                                   (与 failed 分开)
```

## 3. 契约设计

### 3.1 `RuntimeHandle.cancel?()` —— optional

```ts
// packages/honeycomb/src/runtime/registry.ts
export interface RuntimeHandle {
  readonly sessionId: string
  send(message: RuntimeMessage): Promise<void>
  events(): AsyncIterable<RuntimeEvent>

  /**
   * 中断 in-flight turn（仅当底层 session 支持 mid-turn 取消）。
   *
   * 与 close()/kill() 的区别：
   *   - cancel()：保留 worker 与 session 进程/通道，只中断当前 turn。
   *     调用后 worker 仍可被派下一条 RuntimeMessage。
   *   - close()：优雅关闭，in-flight send() 会 reject。
   *   - kill()：强制关闭，进程被 kill，session 不可复用。
   *
   * 可选：未实现 cancel() 的后端（stdio 4 家）走 close() 降级，
   * 仍要等待 in-flight send() 终结。feature-detect 模板：
   *
   *   if (handle.cancel) {
   *     await handle.cancel()
   *   } else {
   *     await handle.close()
   *   }
   *
   * 调用约束：cancel 只在已发出 send() 期间有效；不在 send 期间是 no-op。
   */
  cancel?(): Promise<void>

  close(): Promise<void>
  kill(): Promise<void>
}
```

### 3.2 `AgentSessionHandle` 胶水实现

```ts
// packages/honeycomb/src/runtime/agent-runtime.ts
class AgentSessionHandle implements RuntimeHandle {
  // ...existing code...

  /**
   * 中断 in-flight turn。feature-detect session.cancel；无则降级 close()。
   * - ACP：session.cancel() 调 connection.cancel()，session 发 'cancelled' 事件
   * - stdio：session.close() 优雅终止子进程，session 发 'done' 事件（exit code 143/137）
   *
   * 降级路径的语义缺口：stdio 走 close() 后 session 不可复用，下次 send() 会失败。
   * 编排循环对降级路径的 cancel 后处理：直接 failDispatch（不走重派），worker 走 idle-dismiss
   * 自然回收入池，避免下次派工复用死 session。
   */
  async cancel(): Promise<void> {
    if (typeof (this.session as { cancel?: unknown }).cancel === 'function') {
      await (this.session as { cancel: () => Promise<void> }).cancel()
      return
    }
    // 降级：stdio 无 cancel，发起 close()；编排循环不再复用此 session
    await this.session.close()
  }
}
```

### 3.3 编排循环集成点

`consumer/orchestration-loop.ts` 已有 `dispatchTimeoutMs` 看门狗（`onDispatchTimeout`），
到点时**先**调 `handle.cancel()` 让 agent 中止当前 turn，**再**走 `failDispatch`（重派或回滚）。

```ts
// pseudocode
async function onDispatchTimeout(taskId: string): Promise<void> {
  const memberId = dispatchOwners.get(taskId)
  if (!memberId) return
  const handle = runtimeHandles.get(memberId)
  if (!handle) return
  // 新增：cancel in-flight turn，避免无谓的 token 消耗 / 子进程跑完
  if (handle.cancel) {
    try { await handle.cancel() } catch { /* 容忍，强制走 failDispatch */ }
  }
  // 已有：撤销看门狗 + failDispatch
  clearWatchdog(taskId)
  await failDispatch(taskId, 'dispatch-timeout')
}
```

同时**新增** queen 显式 cancel 任务入口：

```ts
// orchestration-loop 暴露给上层（mandate / transport）的方法
async function cancelTask(hiveId: string, taskId: string, reason: string): Promise<void> {
  const task = ledger.getTask(hiveId, taskId)
  if (!task || task.status === 'cancelled' || task.status === 'completed') return
  const memberId = task.assignedTo
  if (memberId) {
    const handle = runtimeHandles.get(memberId)
    if (handle?.cancel) {
      try { await handle.cancel() } catch { /* ignore */ }
    }
  }
  // 写事实：cancelled（而非 failed），保留 attempt 计数
  ledger.appendFact({ type: 'task-cancelled', taskId, reason, by: 'queen' })
  emitLoopEvent({ type: 'cancelled', hiveId, taskId, reason })
  // 不自动重派（cancel 是用户/queen 主动决策），除非 reason 是 'preempt-for-higher-priority'
}
```

### 3.4 任务事实层：`cancelled` vs `failed` 区分

ledger facts 新增 `task-cancelled` 类型（区别于 `task-failed`）：

| Fact type | 触发 | 含义 | 重派 |
| --- | --- | --- | --- |
| `task-dispatched` | 派工 | 任务开始 attempt N | - |
| `task-reported` | worker 报告 | 完成 attempt N | - |
| `task-failed` | agent error / system fault | 失败 attempt N | 走 maxDispatchAttempts |
| `task-cancelled` | queen / owner 主动取消 | 取消 attempt N | 不自动重派 |
| `task-completed` | 最终成功 | 完成 | - |

worker `done(exitCode=137/143)` 时的归类：
- **有 cancel() 的后端**（ACP）：归为 `cancelled`（因为有明确的 'cancelled' SessionEvent 标记）
- **降级到 close()/kill() 的后端**（stdio）：归为 `cancelled`（即使底层 SessionEvent 是 'done'，其触发源是 cancel 路径）
- **自然 exit（用户正常完成）**：`done(exitCode=0)` 仍是 `task-reported`，不归 cancelled

实现方式：胶水层在 emitStatus 时携带 cause：

```ts
// AgentSessionHandle
private cancelInProgress = false

async cancel(): Promise<void> {
  this.cancelInProgress = true  // 标记「下次 send/done 是 cancel 路径的产物」
  if (typeof (this.session as { cancel?: unknown }).cancel === 'function') {
    await (this.session as { cancel: () => Promise<void> }).cancel()
    return
  }
  await this.session.close()  // 触发 'done'(exit 143)
}

// pump 监听 in-flight send 的终态
private async pump(): Promise<void> {
  for await (const event of this.session.events) {
    const derived = deriveWorkState(event)
    if (this.cancelInProgress && event.type === 'done') {
      // 降级 close() 路径：done 实际是 cancel 触发的，标记 cancelled
      this.emitStatus('idle', event, /* cause */ 'cancelled')
      this.cancelInProgress = false
      return
    }
    if (derived) this.emitStatus(derived, event)
  }
}
```

## 4. native-runtime 兼容（与编排-Pro 协调）

native-runtime 的 cancel 走 DSH 会话中止（用 dsh 自身的 stop API），不需要走 ACP 协议。
两边都用同一套 `RuntimeHandle.cancel?()` 契约：

```
                                RuntimeHandle.cancel?()
                                       │
                ┌──────────────────────┴──────────────────────┐
                │                                             │
        AgentSessionHandle                              NativeSessionHandle
                │                                             │
        feature-detect session.cancel                  ctx.agents.stopSession(sessionId)
        - 有：调 cancel                                   （DSH 自己的会话中止）
        - 无：调 close()                                  → 同样 emit RuntimeEvent.cancelled
```

两边实现细节不同，但 RuntimeHandle.cancel() 签名一致，编排循环零分支。
**待协调事项**：native-runtime 的 SessionEvent 是否会发 `cancelled` 变体？如果不发，native 走 idle 而非 cancelled（但任务状态仍可由 orchestration-loop 归为 cancelled 因 cancelInProgress 标志）。

### 4.1 ⑤ 实现落地（task #01a0087d）

native-runtime 已按 ② 同一套语义接上 cancel（不发明新词，复用既有 loop 入口点）：

- **cancel() 实现**（feature-detect + 降级）：
  - `typeof agent.cancel === 'function'` → 优先走 DSH 会话原生中断 `agent.cancel('cancelled by honeycomb orchestrator')`；
  - 无原生 cancel → 降级 `Promise.race([shutdown(), 30s 宽限])`，超时 force kill（对齐 ② 的 feature-detect 降级契约）；
  - `cancelInProgress` 布尔去重，重复调用幂等（只打一次底层）；
  - 错误一律吞掉（cancel 是尽力而为）。
- **cancel 状态按派工粒度归零**：`send()` 重置 `cancelInProgress = false` —— native handle 跨任务复用（同一 DSH 会话多次 followup），上次派工的 cancel 不得污染本次派工的真实失败判定。
- **cancel-induced 终端 → 成员回 idle 而非 blocked**：`turn/end` 非 completed 且 `cancelInProgress` 时，push `RuntimeEvent('cancelled', { turn, reason, sessionId })` + emit `member/work-state` state `'idle'`（复用 ② 的 idle 改写路径，不发 report / message/created）。
- 任务事实 `task-cancelled` 仍由 orchestration-loop 既有入口归集（本文件不新增 loop 分支）。

**测试**：`test/native-runtime.test.ts` 新增 3 例（mock ctx + FakeAgent，不起真 dsh）—— 在途取消 → cancelled + idle + 原生 cancel 带 cause；已完成任务再取消 → no-op（无 cancelled、无新业务 emit、不污染后续派工）；重复取消 → 幂等（cancelCalls === 1）。

## 5. transport 通道（待 #01a004b1-9056）

预留接口位（**不在本轮实现**）：

```ts
// packages/honeycomb/src/transport/（待补）
// REST 入口
POST /hive/:hiveId/task/:taskId/cancel
  body: { reason: string }
  → 200 { ok: true } 或 409 { ok: false, currentStatus: 'cancelled' | 'completed' }

// WebSocket 推送
// 编排循环 emit 'cancelled' 事件 → 推到 /ws/hive/:hiveId 客户端
```

权限：仅 queen 角色可调；普通成员调被 403 拒绝。

## 6. 实现任务切分

按 ROI 和依赖关系排：

| 任务 | 范围 | 依赖 | ROI | 估时 | 状态 |
| --- | --- | --- | --- | --- | --- |
| ① RuntimeHandle.cancel?() + AgentSessionHandle.cancel() | runtime/registry.ts + runtime/agent-runtime.ts | 无 | 高（解锁所有下游） | 0.5 天 | ✅ 落地（含 RuntimeRegistry.trackHandle/cancelTask 便捷层） |
| ② AgentSessionHandle pump 区分 cancel-induced done | runtime/agent-runtime.ts | ① | 中（任务事实层需要） | 0.3 天 | ✅ 落地（cancelInProgress 幂等去重 + 泵侧 idle 改写） |
| ③ 编排循环 dispatch 看门狗调 cancel + 任务事实 cancelled 类型 | consumer/orchestration-loop.ts | ① | 高（把派工超时闭环做对） | 0.5 天 | ✅ 落地（HiveFact 新增 task-cancelled + store fold） |
| ④ 编排循环 cancelTask 入口 + emit 'cancelled' 事件 | consumer/orchestration-loop.ts | ① ③ | 中（用户/queen 主动 cancel） | 0.5 天 | ✅ 落地（roster.cancelTask? / appendFact? 均 optional，向后兼容） |
| ⑤ native-runtime cancel 兼容 + 与编排-Pro 协调 | runtime/native-runtime.ts | ① native-runtime 收口 | 中（外部 DSH agent 也要能 cancel） | 1 天 | ✅ 落地（§4.1：feature-detect 原生中断 / 降级 close+30s / cancelInProgress 按派工归零 / cancelled 事件 + idle 改写；test/native-runtime.test.ts +3 例全绿） |
| ⑥ transport cancel 通道 | transport/ | #01a004b1-9056 决议 | 低（UI 才会用） | 1 天 | ⏳ 等 #01a004b1-9056 |
| ⑦ E2E 集成测试（dispatch watchdog → cancel → task-cancelled） | test/ | ①②③ | 高（回归防护） | 0.5 天 | ✅ 部分覆盖（test/cancel-dispatch.test.ts 23 例：①-④ 全链路单测；跨进程 E2E 待 ⑤⑥） |

**总估时**：~4 天（不含 transport 决议等待）

**立刻可做（无依赖）**：① ② ③ ④ —— ✅ 全部落地（任务 #01a0052c，test/cancel-dispatch.test.ts 23 例全绿）
**等依赖**：⑤ ✅ 已落地（任务 #01a0087d），⑥ 等 #01a004b1-9056

## 7. 验证

完成后跑：
- `pnpm tsx --test test/cancel-dispatch.test.ts`（✅ ①-④ 全链路：registry cancelTask / 胶水 feature-detect + cancelInProgress 泵侧区分 / 看门狗先 cancel 再 failDispatch / cancelTask 入口 + task-cancelled fold，23 例）
- `pnpm tsx --test test/native-runtime.test.ts`（✅ ⑤：cancel 在途 native 任务 → cancelled + idle、已完成再取消 no-op、重复取消幂等，13 例全绿）
- `pnpm tsx --test test/connector-cancel.test.ts`（⏳ 待连接器-Pro 交付，契约定锚；交付前不要触碰该文件）
- `pnpm tsx --test test/orchestration-loop.test.ts`（回归：既有派工算法未被 cancel 改动破坏）
- `pnpm tsx --test test/persistence.test.ts`（回归：事实 fold 不受 task-cancelled 新词影响）

## 8. 已知限制 / 待办

- 降级路径（stdio close()）的 cancel 触发 'done'(exit 143) 归类为 cancelled，但用户**实际**杀掉子进程的 SIGKILL 信号（exit 137）无法与「system fault kill」区分。当前用 `cancelInProgress` 标志只能覆盖本框架主动 cancel 的场景；外部 SIGKILL 会被误判为 cancelled。建议未来在 SessionEvent 加 `causedBy?: 'cancel' | 'external-signal'` 字段。
- transport cancel 通道缺权限模型；MVP 阶段只允许 queen 角色（已实现的话）。
- native-runtime 已确认能发 cancelled 事件（cancel-induced `turn/end` aborted → `RuntimeEvent('cancelled')` + idle 转移，任务事实归 cancelled）；无原生 `agent.cancel` 的 DSH 走 close()+30s 降级，超时 force kill，此时终端事件仍按 cancelInProgress 归 cancelled。

## 9. 排期建议

| 周次 | 任务 |
| --- | --- |
| 本周 | ① + ② + ③（runtime 胶水 + 编排 dispatch 集成） |
| 下周 | ④（queen cancelTask 入口） + ⑤（native 兼容） |
| 后周 | ⑥（transport）+ ⑦（E2E） |

—— 文档完 ——
