# native-runtime：DSH 原生会话入队（native member）

> 文档头对应实现：`packages/honeycomb/src/runtime/native-runtime.ts`
> 本文件回答「harness 原生会话如何成为 honeycomb 编队的原生一员」，与
> `agent-runtime.ts`（外部 CLI / ACI 包装路径）形成对照。

## 1. 一句话语义

**honeycomb 插件跑在真实 dsh harness 进程内时，`hatch()` 不再 spawn 外部 CLI，
而是用 `ctx.agents`（harness 装配的 core/agent AgentRegistry）创建同进程的真实
DSH 智能体会话**：指令经 `agent.followup()` 入队、会话事件经 `session/event`
全局事件回流、完成标记经 courier report 回写看板。任务板点「执行」→ 真会话干活
→ 状态回写 → 可跳转复盘，全链路闭环。

## 2. 与 agent-runtime（外部 ACI 路径）的对照

两条路径都实现同一 `MemberRuntime` 契约（`hatch` → `RuntimeHandle`），只差
「会话从哪来、事件怎么回流」：

| 契约点 | agent-runtime（外部 ACI） | native-runtime（DSH 原生） |
|--------|--------------------------|---------------------------|
| 会话来源 | `adapter.spawnSession()` 拉起外部 CLI 子进程 | `ctx.agents.create()` 起同进程真实 DSH 会话 |
| 下行指令 | `session.send()` → 子进程 stdin | `agent.followup(UserMessage)` 入队 |
| 事件回流 | 子进程 stdout → `SessionEvent` | `ctx.on('session/event')` 全局事件按 sessionId 过滤 |
| 终端事件 | `done{exitCode}` / `error` | `turn/end{reason}`（completed/error/aborted/…） |
| 完成回写 | exitCode===0 即 finished（provider 未接线） | 收尾回答含 `NATIVE_DONE_MARKER` → courier report |
| 失败转移 | `done(exit≠0)`/`error` → failed | `turn/end` 非 completed → 事件层 failed + work-state=blocked，看门狗兜底 retry→failed |
| 会话引用 | `session.sessionId`（stdout 流） | `sessionId` 即 DSH session id（可跳转复盘） |
| 依赖注入 | `resolveAdapter` 构造注入，解耦 connectors | `ctx.agents` 结构契约（`DshAgentsRegistry`），不 import harness 包 |
| 取消 | `session.cancel()` / close | `agent.cancel(cause)`（⑤ native cancel 与 ACP 同一 `RuntimeHandle.cancel` 契约） |

### 事件映射（同一套 RuntimeEvent 流）

| DSH 会话事件（native） | RuntimeEvent | agent-runtime 等价（ACI） |
|------------------------|--------------|--------------------------|
| `turn/start` | `stream {turn}` | `stream` |
| `assistant/message`（text） | `stream {text}` | `stream {chunk}` |
| `tool/call` | `tool-call {name, arguments}` | `tool-call` |
| `tool/result` | `tool-result {content}` | `tool-result` |
| `approval/requested` | `approval-request {kind}` | `approval-request` |
| `turn/end{completed}` + 完成标记 | `done {report}` + courier `message/created`(kind=report) | `done{exitCode:0}` |
| `turn/end{非 completed}` | `error {reason}` + work-state=blocked | `error` / `done{exit≠0}` |
| `image`（如果 harness 出帧） | `image`（透传） | `image` |

## 3. 完成约定（回写看板的核心机制）

1. 编排循环派工时，下行指令末尾追加 `NATIVE_DONE_MARKER`（默认 `<task-done/>`，
   见 `NATIVE_DONE_MARKER` 常量）。
2. agent 收尾回答以该标记结尾 → 运行时把标记后的文本作为报告：
   - 事件层推 `done {turn, sessionId, report}`；
   - 同时经 `ctx.courier.send(hiveId, {kind:'report', …})` 落库并 emit
     `message/created`——编排循环 `handleReport` 据此把任务置 **completed**。
3. `turn/end` 非 completed（error/aborted/blocked/max-tokens/interrupted）→
   事件层推 `error` + 成员 work-state=blocked，**不回 report**；剩余由编排循环
   看门狗走 retry→failed 完成「失败转移」。

## 4. 会话 ↔ 任务可追溯关联（复盘跳转）

- `sessionId` 即 DSH 会话 id（`ctx.agents.create({sessionId})` 生成，与 session
  log 共享单一体面）。
- `done`/`error` 事件的 payload 带 `sessionId`；courier report 的 attachments
  带 `session://<sessionId>` 引用——看板可据此跳转到会话详情复盘。
- `DshAgent.meta` 可落任务元数据（任务 id 等），扩大追溯面。

## 5. 依赖注入与测试性

- `DshAgentsRegistry` / `DshAgent` / `DshSessionEvent` 等是**结构契约**（本文件
  顶部接口），不 import harness 包；真实运行时由 dsh harness 在 `ctx.agents`
  上装配同名形状。
- 单测（`test/native-runtime.test.ts`）用 FakeAgentRegistry + FakeCtx 驱动：
  起会话/发指令/事件回流/完成回写/失败转移/事件映射/close/kill 全覆盖；
  另有一个可选的 live 验证（真 dsh runtime 起 native member 跑真实任务）。

## 6. 边界

- 不碰 `src/connectors/`（ACP 线）、不碰 `orchestration-loop.ts` 主体、
  不碰 `transport/`。
- 与 agent-runtime 统一走 `WorkState`/`RuntimeEvent` 契约，接口不冲突；
  registry 若扩展只加 optional 成员（如 `handle.cancel?()`），本实现零返工。
