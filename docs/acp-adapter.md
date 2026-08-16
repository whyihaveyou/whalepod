# ACP 适配器（`@dfh/honeycomb/connectors/adapters/acp`）

> 实现位置：`packages/honeycomb/src/connectors/adapters/acp.ts`
> 测试位置：`packages/honeycomb/test/acp-adapter.test.ts` + `test/fixtures/acp-mock-agent.mjs`

## 是什么

`AcpAdapter` 是 honeycomb 的**通用 ACP（Agent Client Protocol）适配器**。任何「支持 ACP」的外部 CLI agent 都能通过它直接接入编队，**无需手写每个 agent 的 stdio 适配器**。

ACP 是 @agentclientprotocol 主导的跨厂商协议（JSON-RPC 2.0 over stdio NDJSON），目前已有：

| Agent              | ACP 入口       | 在 catalog？ |
| ------------------ | -------------- | ------------ |
| OpenCode           | `opencode acp` | ✅           |
| Kimi Code          | `kimi --acp`   | 📌 待 PR     |
| Gemini CLI         | `gemini --acp` | 📌 待 PR     |

接入新 agent 只需要往 `ACP_CATALOG` 数组里追加一行（约 8 行配置），详见下方「Onboarding 步骤」。

## 工作原理

```
┌────────────────────────────────────────────────────────────┐
│ honeycomb orchestration loop                               │
│       ↓                                                    │
│ agent-runtime (胶水层 — 不动)                              │
│       ↓                                                    │
│ AcpAdapter.spawnSession(ctx)                               │
│   ├─ spawn: <binPath> <acp.spawnArgs>                      │
│   ├─ stdio → ndJsonStream(stdout, stdin)                   │
│   ├─ new ClientSideConnection(handler, stream)             │
│   ├─ conn.initialize({ protocolVersion:1, ... })           │
│   ├─ conn.newSession({ cwd, mcpServers: [] })              │
│   └─ returns AcpSession                                   │
│       ├─ events:  AsyncIterable<SessionEvent>              │
│       │     ← sessionUpdate 通知 → normalizeSessionUpdate │
│       │       → stream/tool-call/tool-result/done/error    │
│       └─ send(input):                                       │
│             → conn.prompt({ sessionId, prompt:[...] })      │
│             → 完成时 enqueue 'done' SessionEvent            │
└────────────────────────────────────────────────────────────┘
```

事件映射（`normalizeSessionUpdate`）：

| ACP `SessionUpdate`           | → `SessionEvent`                  |
| ----------------------------- | --------------------------------- |
| `agent_message_chunk` (text)  | `stream` chunk                    |
| `agent_thought_chunk` (text)  | `stream` chunk（透传）） |
| `agent_message_chunk` (image) | `{ type: 'image', source: 'agent', mimeType, data (base64) }` |
| `tool_call` / `tool_call_update` (content 里的 image) | `{ type: 'image', source: 'tool', toolCallId, mimeType, data }`（在 `tool-call`/`tool-result` 事件之间） |
| `tool_call`                   | `tool-call` + `tool-result`（如完成）|
| `tool_call_update`            | `tool-result`（仅 completed/failed）|
| `plan` / `plan_update` / …    | （忽略，纯展示/状态）             |

Permission 请求默认 fail-closed（`{ outcome: 'cancelled' }`）；harness 可在后续版本通过 `ctx.onPermissionRequest` 注入 UI 决策。

### 已接入 ACP agent 清单

`ACP_CATALOG` 当前包含：

| ID                | binary   | spawnArgs  | capabilityProbe  | 关键 capability 来源                          | configDir       |
| ----------------- | -------- | ---------- | ---------------- | --------------------------------------------- | --------------- |
| `opencode-acp`    | `opencode` | `['acp']`  | `['--help']`     | 通用 streaming/tool-use                       | `.opencode`     |
| `kimi-code-acp`   | `kimi`     | `['acp']`  | `['--help']`     | streaming/tool-use/**image**（自报）         | `.kimi-code`    |
| `gemini-cli-acp`  | `gemini`   | `['--acp']`| `['--version']`  | streaming/tool-use,**image**（规划）         | `.gemini`       |

> `gemini-cli-acp` 为 `npx -y @google/gemini-cli` 准备的条目（已启用入册）。本机/CI 未装，
> 按「未装→detect 返回 null」语义处理：装后即可自动检测命中。ACP 入口官方为 `gemini --acp`
> （个别版本 subcommand `acp`，安装后请以 `gemini --help` 实测校正 spawnArgs）。kind 暂为
> placeholder `claude-code` —— AgentKind 联合尚无 `gemini-cli`，需在 `types.ts` 补充后修正
> （不影响「可发现 / 可接入」，只影响能力匹配的家族标签）。

接入的两种姿势：
- **走 catalog**：在 `connectors/adapters/acp.ts` 的 `ACP_CATALOG` 追加 `AcpCatalogEntry`，再 `bootstrapAcpAdapters()` 一键实例化所有 catalog 项。
- **走运行时探测**：detector 跑 `probeAcp` 时会同时探测 catalog 里的每一项，能命中且 `capabilityProbe` 退出码 0 的会出现在 `discoverAll()` 的结果里（`descriptor.acp` 字段被填上）。

> 本机/CI 均未装 `gemini` 时，`gemini-cli-acp` 按「未装→detect 返回 null」语义处理；装 `npx -y @google/gemini-cli` 后自动可检测命中。

## Onboarding 步骤

> 目标：让一个新 ACP-capable agent 在不到 10 分钟内被 honeycomb 识别 + 可驱动。

### Step 1：确认 agent 支持 ACP

跑 `<agent> --acp --help`（或 `<agent> acp --help`），exit 0 表示支持。ACP 协议细节见 https://github.com/agentclientprotocol/agent-client-protocol 。

### Step 2：写一个 1 行的 Catalog 追加

打开 `packages/honeycomb/src/connectors/adapters/acp.ts`，在 `ACP_CATALOG` 里追加（以 `kimi-code-acp` 为真实案例）：

```ts
export const ACP_CATALOG: readonly AcpCatalogEntry[] = [
  // 已有：opencode-acp
  {
    id: 'opencode-acp',
    /* ... */
  },

  // 已有：kimi-code-acp（实测可用 kimi 0.34.0）
  {
    id: 'kimi-code-acp',
    displayName: 'Kimi Code (ACP)',
    kind: 'kimi-code',              // 复用 AgentKind 联合；新增 agent 需要先扩联合
    binaryName: 'kimi',             // PATH 上的二进制名
    spawnArgs: ['acp'],             // kimi 用 subcommand 而非 flag（实测 'kimi --acp' 报 unknown option）
    capabilityProbe: ['--help'],    // 探活：'kimi acp --help' exit 0 即视为可用
    configDirName: '.kimi-code',
    // 从 kimi acp initialize 响应里取自报能力，加上 image（promptCapabilities.image=true）
    capabilities: [...ACP_DEFAULT_CAPABILITIES, { id: 'image' }],
  },

  // ↓ 新接入的 agent ↓
  {
    id: 'my-agent-acp',             // 唯一 ID，会成为 MemberRuntime 后端的字符串
    displayName: 'My Agent (ACP)',  // UI 显示名
    kind: 'claude-code',            // 归类（需先在 AgentKind 联合里加；或复用已有）
    binaryName: 'my-agent',         // PATH 上的二进制名
    spawnArgs: ['acp'],             // 触发 ACP 模式的 argv（subcommand 或 flag 按实测）
    capabilityProbe: ['--help'],    // 可选的存在性 probe（exit 0 视为可用）
    configDirName: '.my-agent',     // 配置目录名（detect 第 3 层）
    capabilities: ACP_DEFAULT_CAPABILITIES,  // 或追加 image/mcp-http 等自报能力
  },
]
```

### Step 3：在 `AgentKind` 里挑一个归类（或扩展 types.ts）

如果 agent 与现有 family 同族（opencode/kimi-code/hermes/claude-code/codex），用对应的 kind 字符串。如果不属于任何一族，编辑 `packages/honeycomb/src/connectors/types.ts` 的 `AgentKind` union 追加你的 kind。

### Step 4（必做）：把新条目 bootstrap 进 registry

把 `ACP_CATALOG` 实例化成 `AcpAdapter` 并注册到 connector registry（这一步是 catalog 真正「活」起来的必要条件）：

```ts
import { bootstrapAcpAdapters } from '@whalepod/honeycomb/connectors/adapters/acp'
for (const adapter of bootstrapAcpAdapters()) {
  registry.register(adapter)  // 或 ctx.roster.registerRuntime / 你的实际注册点
}
```

`bootstrapAcpAdapters()` 是 `acp.ts` 导出的便利函数：把 catalog 每一项 `new AcpAdapter(entry)` 包装好。它默认覆盖 `opencode-acp` 和 `kimi-code-acp`。4 家 stdio 适配器（claude-code/codex/kimi-code/opencode/hermes）各有自己的注册路径，不在此统一 bootstrap（避免越界改他们）。

### Step 5：跑测试

```sh
cd /Users/qzp/aion2dsh/packages/honeycomb
pnpm tsx --test test/acp-adapter.test.ts
```

应自动命中：

- `AcpAdapter.detect: PATH shim + 空 capabilityProbe → descriptor.acp 被填上` —— 验证 DetectSpec 层
- `ACP_CATALOG: 含 opencode-acp 且字段一致` —— 验证你的新条目存在
- **Live test（opt-in）**：

```sh
RUN_ACP_LIVE=1 pnpm tsx --test --test-timeout=30000 test/acp-adapter.test.ts
```

跑本机真 agent 二进制，需要 `my-agent` 在 PATH 上。

### Step 6（可选）：为它写一个 connector-specific override

如果某些 agent 的 argv 形态特殊（例如要传 `--port` 或 `--config`），可在 `ACP_CATALOG` 里 `spawnArgs` 加额外参数；如果要求更细的协议映射（如特殊 plan schema），可以 fork `normalizeSessionUpdate` —— 但通常不需要。

## 设计取舍

### 为什么不直接 import `ClientSideConnection`（新 API）？

新 API（`client({name}).onRequest(...).connectWith(stream, op)`）的 `op` 是**连接生命周期内的回调**，会话结束后连接即关闭。这意味着每发一个 prompt 都要重新建立连接 + newSession，不适合 agent-runtime 这种「长连接多轮对话」场景。

所以我们用 deprecated `new ClientSideConnection(handler, stream)`：它直接暴露 `conn.initialize / newSession / prompt / cancel`，生命周期与子进程对齐。

代价：deprecated 警告。但 `acpClient({name}).onRequest(...).connect(stream)` 这条「只注册 handler、不主动调 op」的新路径无法承载「外部 push prompt」语义，必须选 deprecated 路径。

### 为什么 `events` 用「生产者/消费者队列」而非 ActiveSession？

新 API 的 `ActiveSession.nextUpdate()` 是 pull-based 且依赖 connectWith 的 op 保持运行；与「外部 send 后由 SDK 把事件喂回来」的语义不匹配。

我们的实现是 `ClientSideConnection` 的 handler 收到 `sessionUpdate` 通知时主动 enqueue，外部 `events()` 异步消费 —— push-based，与 `agent-runtime.ts` 现有约定一致。

### 为什么 default permission 是 cancelled？

ACP 的 `session/request_permission` 是「agent 主动问 client 是否可以调用工具」。harness 层目前没有 UI 决策接入点；返回 'cancelled' 是 fail-closed，**禁止未知 agent 写文件 / 跑 shell**。harness 上线 UI 后可以改默认 + 注入白名单。

### 为什么 `descriptor` 字段在 `SpawnContext` 里？

`SpawnContext` 原本只有 `cwd` 和 `env`。给 `AcpAdapter` 加 `descriptor?: AgentDescriptor` 是**可选 + 后向兼容**的扩展：测试可绕过 Detector（Detector 只探测 basename 在 PATH 上），未来已知场景（harness 注入）也能复用。

## 已实现能力

### `image` 事件透传

`SessionEvent` 加 `{ type: 'image', source: 'agent' | 'tool' | 'user', toolCallId?, mimeType, data }` 变体；`normalizeSessionUpdate` 把 ACP `agent_message_chunk` / `tool_call` / `tool_call_update` 里的 image content 拆出来单独 emit。

事件顺序约定（避免 UI 渲染闪烁）：
- `agent_message_chunk` (image) → `image` 事件
- `tool_call` (含 image content) → `tool-call` → `image`（绑 toolCallId）→ `tool-result`
- `tool_call_update` (含 image content) → `image` → `tool-result`

data 字段保留 ACP 原生的 base64 字符串，**不做 buffer 转换**（避免无谓的 Uint8Array ↔ Buffer 互转开销，保留原始字节序）。下游消费者按需解析。

`source` 区分来源：
- `'agent'`：agent 自己发的图（agent_message_chunk）
- `'tool'`：工具调用结果里夹带的图（tool_call / tool_call_update）
- `'user'`：留给未来 harness 注入 prompt 图像的扩展位（当前 adapter 不消费 user_message_chunk）

需要 dispatch 端正确 capability-match：`kimi-code-acp` catalog 已声明 `image` capability，所以 harness 把 image 任务派给它时不会被筛掉。

### `AcpSession.cancel()`：中断 in-flight prompt turn

`AgentSession` 契约里 `cancel?(): Promise<void>` 是**可选**方法（其他 5 个 adapter 暂未实现，调用方需 feature-detect）。AcpSession 的实现：

- 跟踪 `inflightPrompt` 引用 + `cancelRequested` 标志；
- `cancel()` 调 `connection.cancel({ sessionId })`（ACP `session/cancel` 通知）；
- in-flight `connection.prompt()` 收到通知后以 `stopReason: "cancelled"` 返回；
- `send()` 据 `cancelRequested` 把终态事件设为 `{ type: 'cancelled' }`（而不是 `{ type: 'done' }`）；
- 调 cancel 时若无 in-flight prompt，是 no-op，不抛错、不污染 session。

调用约束：cancel 只发了通知，**不**等待 agent 真的停。调用方在观察完 `cancelled` / `error` 事件前不要发起新的 `send()`（ACP 禁止同 session 重叠 prompt）。

测试覆盖：cancel 中断路径（mid-turn）+ idle 路径（no-op 且后续 send 正常）。

## 已知限制

| 限制                                       | 后续工作                                           |
| ------------------------------------------ | -------------------------------------------------- |
| 默认 permission 策略 fail-closed           | harness 提供 `ctx.onPermissionRequest` UI 决策       |
| 不支持 `session/load`（续接已有 session）   | catalog 里设 `loadSession: true` 后接入 `conn.loadSession`（kimi acp 自报 loadSession: true，已为 follow-up 准备） |
| 无 `fs` capability（read_text_file / write_text_file）| harness 通过 ClientCapabilities 协商               |
| audio / resource content 仍未透传          | `normalizeSessionUpdate` 加 audio + resource 类型分支（image 已实现） |
| 其他 5 个 adapter 未实现 `cancel()`        | opencode/codex/kimi/hermes/claude-code 各自按 CLI 协议实现 |

## 测试覆盖

```
test/acp-adapter.test.ts
├─ 1. normalizeSessionUpdate (7 用例)
│     - text → stream
│     - thought → stream
│     - image → skip
│     - tool_call completed → tool-call + tool-result
│     - tool_call_update completed → tool-result
│     - tool_call_update in_progress → skip
│     - plan/plan_update → skip
├─ 2. defaultPermissionResponse (1 用例)
│     - fail-closed cancelled
├─ 3. SessionEventQueue (1 用例)
│     - enqueue/dequeue round-trip + close signal
├─ 4. AcpAdapter.detect (2 用例)
│     - 不存在二进制 → null
│     - PATH shim + capabilityProbe → descriptor.acp 填上
├─ 5. spawnSession 生命周期 (2 用例)
│     - prompt → 4 stream + done（拼起来 = "Hello, world!"）
│     - tool-call emission → stream + tool-call + tool-result + done
├─ 5b. cancel() (2 用例)
│     - mid-turn cancel → stream + cancelled（不再有 done）
│     - idle cancel → no-op，不影响后续 send → done
├─ 5c. image 透传 (1 用例 e2e + 4 用例 normalize)
│     - e2e: mock 发 image chunk → SessionEvent.image(source=agent, mimeType=image/png)
│     - normalize: agent_message_chunk image → 1 image event
│     - normalize: text + image 同 chunk → stream + image
│     - normalize: tool_call 含 image → tool-call + image + tool-result
│     - normalize: tool_call_update 含 image → image + tool-result
├─ 6. ACP_CATALOG sanity (3 用例)
│     - opencode-acp 字段一致
│     - kimi-code-acp 字段与实测对齐（spawnArgs=acp, image capability）
│     - gemini-cli-acp 字段入册（binaryName=gemini, spawnArgs=['--acp'], image capability）
├─ 6b. bootstrapAcpAdapters (1 用例)
│     - ACP_CATALOG 每一项都能实例化为 AcpAdapter
├─ 6c. detect 两态 (1 用例)
│     - PATH shim 模拟 kimi 「已装」→ 命中 descriptor；gemini 未装 → detect 返回 null
└─ 7. live opt-in (2 用例, RUN_ACP_LIVE=1)
      - 本机 opencode acp 真链路
      - 本机 kimi acp 真链路（OAuth-backed, 25s 限时防拖慢套件）
```

跑法：

```sh
# 默认（22 用例 + 2 skip live）
pnpm tsx --test test/acp-adapter.test.ts

# 启用 live 测试（需本机 opencode 和/或 kimi）
RUN_ACP_LIVE=1 pnpm tsx --test --test-timeout=30000 test/acp-adapter.test.ts
```

## 相关

- `packages/honeycomb/src/connectors/adapters/acp.ts` —— 实现
- `packages/honeycomb/src/connectors/detect/detector.ts` —— DetectSpec 的 acp 字段
- `packages/honeycomb/src/connectors/types.ts` —— AgentDescriptor 的 acp 字段 + ProbeResult.layer 扩展到 'acp'
- `packages/honeycomb/test/acp-adapter.test.ts` —— 测试
- `packages/honeycomb/test/fixtures/acp-mock-agent.mjs` —— mock ACP agent 二进制
- `docs/subagent-acp-seam.md` —— 实现-Pro-1 的源码级调研（subagent 命名注册表位置、ACP 进程外后端机制、最小骨架）
- `docs/connector-architecture.md` —— 现有连接器架构总览
- `docs/honeycomb-orchestration-loop.md` —— 编排循环文档（接入点在 §runtime）