# subagent / ACP 接入点 —— 源码级详解 + 最小示例

> 调研对象：已 clone 的 `deepseek-harness`（路径 `/Users/qzp/aion2dsh/deepseek-harness`）。
> 本文聚焦"具体怎么接"的机制，不重复架构-Pro-1 的高层设计。
> 所有路径均相对仓库根 `deepseek-harness/` 缩写为 `packages/...`。

---

## 0. 结论速览

| 关注点 | 位置 | 一句话 |
|---|---|---|
| 命名注册表 | `packages/subagent/subagent/src/index.ts` → `class SubagentRuntime extends Service`（`ctx.subagents`） | `registerProvider(provider)` 按名注册；重复名抛 `DUPLICATE_PROVIDER` |
| Provider 契约 | `packages/subagent/subagent/src/types.ts` → `SubagentProvider` | `{ name, capabilities, inheritsParentContext, start(), prepareContinuable? }` |
| ACP 进程外后端 | `packages/subagent/subagent-acp/src/{index,run}.ts` | `ctx.subprocess.spawn` 起外部进程 → `@agentclientprotocol/sdk` 的 `ClientSideConnection` 走 NDJSON over stdio |
| ACP 子进程侧 SDK | `@agentclientprotocol/sdk@0.25.1` → `AgentSideConnection` + `ndJsonStream` | 外部 agent 只需实现 `Agent` 接口（initialize/newSession/prompt/cancel） |
| 面向模型委派入口 | `packages/subagent/tool-subagent/src/index.ts` | `subagent` 工具，`config.provider` 指定委派到哪个 provider |
| 可继续子 agent | `startContinuable()` + `SubagentActivationSetupRegistry.register()` | 持久化子 agent + 能力注入，是编排层的长期运行入口 |
| 最小示例 | `packages/subagent/subagent-acp/tests/mock-acp-server.ts` | 一个 ~40 行、无模型无网络的 ACP agent 子进程 |

---

## 1. ① 命名注册表：`ctx.subagents`（SubagentRuntime）

### 1.1 定义位置

- **服务类**：`packages/subagent/subagent/src/index.ts:171`
  ```ts
  export class SubagentRuntime extends Service {
    private readonly providers = new Map<string, SubagentProvider>()   // ← 命名注册表本体
    // ...
  }
  ```
  通过 Cordis `Service` 基类以名字 `'subagents'` 注册，故 `ctx.subagents` 即该实例（`declare module '@deepseek-ai/cordis' { interface Context { subagents: SubagentRuntime } }`）。

- **Provider 契约**：`packages/subagent/subagent/src/types.ts:285`
  ```ts
  export interface SubagentProvider {
    readonly name: string                                  // 注册名（唯一键）
    readonly capabilities: SubagentCapabilities            // outputSchema/depthLimit/toolFilter/persona
    readonly inheritsParentContext: boolean                // 仅描述：子 agent 能否看到父历史
    start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>   // 一次性委派（所有权转移边界）
    prepareContinuable?(request): Promise<ContinuableCreateSpec>         // 可选：支持可继续子 agent
  }
  ```
  能力声明 `SubagentCapabilities`（`types.ts:86`）四布尔：`outputSchema` / `depthLimit` / `toolFilter` / `persona`。
  服务在创建子 agent 前据此拒绝不支持的一次性请求。

- **结果/运行**：`SubagentResult`（`types.ts:219`，`{ output, structured?, stopReason }`）、`SubagentRun`（`types.ts:249`，`{ id, localAgent, result, dispose }`）。

### 1.2 关键 API

`SubagentRuntime` 的对外操作（`index.ts`）：

| 成员 | 行号 | 含义 |
|---|---|---|
| `registerProvider(provider)` | `:369` | 按名注册，effect 作用域约束（返回 disposer），重复名抛 `DUPLICATE_PROVIDER`；emit `subagent/provider-added` / `subagent/provider-removed` |
| `getProvider(name)` | — | 返回 provider，不存在返回 `undefined` |
| `list()` | — | 按插入顺序返回 provider 名 |
| `start(name, request)` | — | 校验→解析一次性描述符→`provider.start()`→返回 `SubagentRun` |
| `startContinuable(spec)` | — | 建立持久化可继续子 agent（要求 `ctx.agents` + 会话持久化 + `prepareContinuable`） |
| `followup / interrupt / reportFrom` | — | 可继续子 agent 的后续消息/中断/上报 |
| `registerContinuableSetup(contribution)` | — | 把部署能力组合进每个可继续 child 的未发布作用域（见 §4） |
| `listChildren / listDescendants` | — | 子 agent 树枚举（供 UI/账本） |

### 1.3 如何注册一个新 subagent（三步）

1. `import type { SubagentProvider, SubagentCapabilities, ... } from '@deepseek-ai/dsh-subagent'`
2. 实现一个类：
   ```ts
   class MyProvider implements SubagentProvider {
     readonly name = 'my-agent'                              // 唯一名
     readonly capabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
     readonly inheritsParentContext = false
     async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> { /* 起进程/跑任务 */ }
   }
   ```
3. 在插件 `apply()` 里注册（插件 `inject = ['subagents']`）：
   ```ts
   export function apply(ctx: Context, config: Config): void {
     ctx.subagents.registerProvider(new MyProvider(ctx, config))
   }
   ```

真实参考实现：`packages/subagent/subagent-claude-code/src/index.ts`（`ClaudeCodeProvider`，`name = 'claude-code'`，`inject = ['subagents', 'subprocess']`，`apply()` 末尾 `ctx.subagents.registerProvider(...)`）。

---

## 2. ② ACP 进程外后端：`subagent-acp`

包：`@deepseek-ai/dsh-subagent-acp`（`packages/subagent/subagent-acp/`），`dependencies` 含 `@agentclientprotocol/sdk@0.25.1`。

### 2.1 配置（`src/index.ts:27`）

```ts
export interface Config {
  providerName?: string          // 注册名，默认 'acp'
  command: string                // 外部 agent 可执行文件
  args?: string[]                // 命令行参数
  cwd?: string                   // 子进程工作目录
  permission?: 'allow' | 'reject'  // 子进程 requestPermission 的自动应答策略，默认 reject（fail-closed）
  env?: Record<string, string>   // 额外环境变量
  disposeEofGraceMs?: number     // EOF 优雅窗口
  disposeGraceMs?: number        // SIGTERM 宽限
}
```

`apply()` 里 `inject = ['subagents', 'subprocess']`，实例化 `AcpProvider implements SubagentProvider`（`index.ts:146`，`capabilities` 全 `false`、`inheritsParentContext = false`），并 `ctx.subagents.registerProvider(acpProvider)`。

### 2.2 启动外部 agent 的完整流程（`src/run.ts:199` `startAcpRun`）

1. **造父命名空间 SessionId**：`randomUUID()`（子 agent 无本地会话，用父作用域 id 做生命周期标识）。
2. **spawn 子进程**（`run.ts` 内部）：
   ```ts
   ctx.subprocess.spawn({
     argv: [command, ...args], cwd,
     stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },  // stdout 专供 ACP 协议
     graceMs: disposeGraceMs, env,
   })
   ```
3. **建 ACP 客户端连接**（`run.ts:266`）：
   ```ts
   const conn = new ClientSideConnection(ndJsonStream, makeClient(...))   // @agentclientprotocol/sdk
   ```
   `ndJsonStream` 把子进程 stdin/stdout 包装成 NDJSON 帧流。
4. **握手 → 建会话 → 发提示**（`run.ts:297/303/329`）：
   ```ts
   await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
   const session = await conn.newSession({ cwd: spec.cwd, mcpServers: [] })   // → sessionId
   const promptResult = await conn.prompt({ sessionId: remoteSessionId, prompt: toAcpPrompt(request.prompt) })
   ```
5. **收集子进程流式输出**：client 的 `sessionUpdate` 回调把 `agent_message_chunk` 文本折叠进 `AssistantOutputFold`；`agent_thought_chunk` 等非消息更新消费但不累积。
6. **权限自动应答**：子进程若发 `session/request_permission`，按 `config.permission` 自动回 allow_once / reject（fail-closed）。
7. **返回 `SubagentRun`**：`{ id, localAgent: undefined, result, dispose }`；`stopReason` 经 `acpStopReason` 映射（见下表）。
8. **dispose 阶梯**（`run.ts:114` `disposeAcpChild`）：`stdin.end()`（EOF 优雅窗口）→ `disposeGraceMs` 后 SIGTERM → 再宽限后 SIGKILL。每级可观测、可升级，保证不配合的子进程也会被终结。

### 2.3 ACP StopReason → harness 映射（`run.ts:137`）

| ACP `StopReason` | harness `SubagentResult.stopReason` |
|---|---|
| `end_turn` | `completed` |
| `max_tokens` | `max-tokens` |
| `refusal` | `refusal` |
| `cancelled` | `aborted` |
| `max_turn_requests` | `error`（无直接对应） |
| 其他未知 | `error` |

---

## 3. ③ 最小可运行示例

### 3.1 外部 ACP agent 子进程（服务器侧，~40 行）

精简自 `packages/subagent/subagent-acp/tests/mock-acp-server.ts`（去掉测试环境脚本）：

```ts
// my-acp-agent.ts —— 外部 CLI agent 的 ACP 服务器骨架，经 stdio 走 NDJSON
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import {
  AgentSideConnection, ndJsonStream, PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest, type InitializeResponse,
  type NewSessionRequest, type NewSessionResponse,
  type PromptRequest, type PromptResponse,
  type CancelNotification,
} from '@agentclientprotocol/sdk'

function makeAgent(conn: AgentSideConnection): Agent {
  return {
    initialize(_p: InitializeRequest): Promise<InitializeResponse> {
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
      })
    },
    async newSession(_p: NewSessionRequest): Promise<NewSessionResponse> {
      return { sessionId: randomUUID() }                 // 会话身份由子进程自己定
    },
    async prompt(params: PromptRequest): Promise<PromptResponse> {
      // ① 可选：请求宿主审批
      // const decision = await conn.requestPermission({ sessionId, toolCall, options })
      // ② 流式回传文本（可多次）
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'subagent 的回答…' } },
      })
      // ③ 结束并报告 stopReason
      return { stopReason: 'end_turn' }
    },
    cancel(_p: CancelNotification): Promise<void> { return Promise.resolve() },
  }
}

new AgentSideConnection(
  makeAgent,
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin)  as ReadableStream<Uint8Array>,
  ),
)
```

要点：子进程 **stdout 专供 ACP 协议**（禁止打日志到 stdout，诊断走 stderr）。

### 3.2 宿主侧接线（cordis.yml + apply）

`cordis.yml`（把上面的 agent 挂成 `acp` provider）：

```yaml
plugins:
  '@deepseek-ai/dsh-subagent-acp':
    providerName: acp
    command: tsx
    args: [./my-acp-agent.ts]
    permission: reject            # 默认 fail-closed；子进程 requestPermission 才需要 allow
```

或在宿主插件 `apply()` 里显式加载（等价）：

```ts
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(SubagentAcp, { command: 'tsx', args: ['./my-acp-agent.ts'], permission: 'reject' })
}
```

### 3.3 调用它

- **面向模型**（`tool-subagent`，`packages/subagent/tool-subagent/src/index.ts`）：`config.provider: 'acp'` 后，模型即可通过 `subagent` 工具委派。
- **程序化直调**：
  ```ts
  const run = await ctx.subagents.start('acp', {
    parent, signal, prompt: '帮我做 X',
    // label / model / outputSchema / maxDepth / toolFilter / persona 可选
  })
  const { output, stopReason } = await run.result
  await run.dispose()
  ```

### 3.4 非 ACP 的 CLI 怎么接（B 方案）

如果外部 CLI **不说 ACP**（如某个闭源 CLI 有自己的 JSON 协议），就照 `subagent-claude-code` 的路子**直写一个 `SubagentProvider`**：
`ctx.subprocess.spawn` 起进程 → 用它的原生协议交互 → 自己把输出/退出码收敛成 `SubagentResult` → 返回 `SubagentRun`（`localAgent: undefined`）。同一套 `registerProvider` 入口，无需 ACP。骨架见 §1.3，跑进程/收尾可参考 `subagent-claude-code/src/run.ts` 与 `subagent-acp` 的 dispose 阶梯。

---

## 4. ④ 与 `@whalepod/honeycomb` 编排层对接的插入点

`@whalepod/honeycomb` **不在本仓库**（全仓 grep 无命中），是外部命名空间（DeepSeek Honeycomb 产品的编排层）。deepseek-harness 为它预留的对接面如下：

### 插入点 1 —— `ctx.subagents.registerProvider()`（主入口）
Honeycomb 编排层把自己实现为一个 `SubagentProvider`，注册一个具名 provider（如 `name: 'honeycomb'`），即成为 harness 的一个标准 subagent 后端。一次性委派走 `start()`；长生命周期子 agent 走 `prepareContinuable()` + `startContinuable()`。

### 插入点 2 —— 复用 `subagent-acp`（进程外，推荐）
若 Honeycomb 编排逻辑跑在**独立进程**（自身也是一个 harness/agent 进程，像 `packages/examples/acp-demo` 那样 `dsh-acp` bridge 起 stdio ACP server），宿主只需：
```yaml
plugins:
  '@deepseek-ai/dsh-subagent-acp':
    providerName: honeycomb
    command: dsh-honeycomb-agent      # 指向 honeycomb 编排进程
    args: ['--config', './honeycomb.cordis.yml']
```
这样 harness ↔ honeycomb 之间就是标准的 ACP NDJSON over stdio，权限经 `requestPermission` 回传、取消经 `session/cancel`、进程生命周期经 dispose 阶梯统一管理。`acp-demo` 的 `src/index.ts`（`ctx.plugin(acp, { provider, model })`）就是"把一个 harness 变成 ACP 子 agent"的现成范式。

### 插入点 3 —— `tool-subagent` 的 `provider` 配置（模型委派入口）
`@deepseek-ai/dsh-tool-subagent` 的 `config.provider` 决定模型看到的 `subagent` 工具委派到谁。Honeycomb 接入后把它指到 `honeycomb`（或 `acp`），即可让模型直接触发 honeycomb 编排，无需改任何模型侧逻辑。

### 插入点 4 —— `registerContinuableSetup()`（能力注入 + 长期运行）
`SubagentActivationSetupRegistry.register(contribution)`（`packages/subagent/subagent/src/activation-setup-registry.ts:72`）把部署能力组合进每个"可继续子 agent"的未发布作用域。Honeycomb 若要给子 agent 注入自己的工具/权限/persona 装配，走这里，而不是硬编码进 provider。

### 插入点 5 —— `subagent/descriptor` 事件 + `delegationDepth`（账本/审计）
每次本地会话支撑的启动都会追加 `subagent/descriptor` 会话事件（provider 名 + `mode` + 标签），`SessionHeader.delegationDepth` 单调记录委派深度。Honeycomb 的编排账本、UI 的"子 agent 树"（`listChildren`/`listDescendants`）、跨进程恢复都依赖这套词汇。

### 建议的对接形态
1. **最省事**：honeycomb 编排进程实现 ACP agent（照 `acp-demo` + §3.1），宿主用 `subagent-acp` 挂接（插入点 2），模型经 `tool-subagent.provider` 触发（插入点 3）。
2. **需要同进程细粒度控制**：honeycomb 直写 `SubagentProvider`（插入点 1），并用 `registerContinuableSetup`（插入点 4）注入能力。
3. 两条路都复用同一套 `subagent/descriptor` + `delegationDepth` 账本（插入点 5），不另造轮子。

---

## 附：关键文件/行号速查

| 符号 | 文件 | 行 |
|---|---|---|
| `class SubagentRuntime extends Service` | `packages/subagent/subagent/src/index.ts` | 171 |
| `registerProvider(provider)` | 同上 | 369 |
| `SubagentCapabilities` | `packages/subagent/subagent/src/types.ts` | 86 |
| `SubagentStartRequest` | 同上 | 100 |
| `SubagentResult` | 同上 | 219 |
| `SubagentRun` | 同上 | 249 |
| `SubagentProvider` | 同上 | 285 |
| `SubagentActivationSetupRegistry.register()` | `packages/subagent/subagent/src/activation-setup-registry.ts` | 72 |
| `Config`（ACP 后端） | `packages/subagent/subagent-acp/src/index.ts` | 27 |
| `class AcpProvider` | 同上 | 146 |
| `disposeAcpChild()` | `packages/subagent/subagent-acp/src/run.ts` | 114 |
| `startAcpRun()` | 同上 | 199 |
| `new ClientSideConnection` | 同上 | 266 |
| `conn.initialize / newSession / prompt` | 同上 | 297 / 303 / 329 |
| ACP StopReason 映射 `acpStopReason` | 同上 | 137 |
| `ClaudeCodeProvider`（直写 Provider 范式） | `packages/subagent/subagent-claude-code/src/index.ts` | 52 |
| ACP demo（harness 变 ACP agent） | `packages/examples/acp-demo/src/index.ts` | 113 |
| 最小 ACP agent 子进程 | `packages/subagent/subagent-acp/tests/mock-acp-server.ts` | 全文件 |
