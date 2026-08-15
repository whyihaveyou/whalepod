# 外部 CLI Agent 连接器架构设计

> 文档编号：DFH-WS / CONN-001
> 产品：DFH Workstation
> 核心包：`@whalepod/honeycomb`（NPM：`dsh-honeycomb`）
> 责任人：架构-Pro-2
> 状态：设计稿 v1

---

## 1. 目标与定位

### 1.1 要解决的问题

DFH Workstation 的多智能体编排核心（`@whalepod/honeycomb`）需要把"外部已安装的 CLI 编码代理"纳入同一个团队（team）中，让它们像原生 teammate 一样被编排、被对话、被分配任务。

本机常见的 CLI 代理包括：

| 外部 Agent | CLI 入口 | 典型版本（本机实测） | 配置目录 |
| --- | --- | --- | --- |
| Claude Code | `claude` | 未安装（本机 PATH 未命中） | `~/.claude` |
| Codex | `codex` | codex-cli 0.146.0 | `~/.codex/config.toml` |
| Kimi Code | `kimi` | 0.34.0 | `~/.kimi-code/config.toml` |
| OpenCode | `opencode` | 1.18.16 | `~/.config/opencode/opencode.json` |
| Hermes | `hermes` | Hermes Agent v0.20.0 | `~/.hermes/.env` |

### 1.2 设计目标

1. **自动识别（zero-config）**：启动编排核心时，自动扫描本机已安装的 CLI agent，无需用户手工登记。
2. **统一抽象**：把异构的 CLI agent（不同 flags、不同流式输出、不同配置格式）包装成统一的 `Teammate` 模型。
3. **概念级重实现**：不使用 AionUi 的类名 / API 名，全部以 `@whalepod/honeycomb` 自身的命名体系表达，底层落到 DeepSeek Harness 的 Cordis 原语（service / events / lifecycle / config / persistence）。

### 1.3 非目标

- 不实现每个 agent 的完整 CLI 协议解析（细节见任务「CLI 接口实测」，由连接器-Pro 产出）。
- 不处理 agent 的鉴权登录（token 由用户在各 agent 自身配置中完成）。
- 不做跨 agent 的模型路由 / 负载均衡（那是编排层的事）。

---

## 2. 总体架构

### 2.1 分层

```
┌──────────────────────────────────────────────────────────────┐
│                      Team / Roster 层                         │
│        （把外部 agent 注册为 teammate，参与任务板与消息总线）      │
└───────────────────────────────┬──────────────────────────────┘
                                │ 统一 TeammateDescriptor
┌───────────────────────────────▼──────────────────────────────┐
│                   Connector 注册表（Registry）                 │
│    discoverAll() / register() / resolve(id) / descriptors()    │
└───────────────┬───────────────────────────────┬──────────────┘
                │                               │
   ┌────────────▼─────────────┐   ┌─────────────▼──────────────┐
   │  Detector（自动识别）      │   │  Adapter（适配器）           │
   │  which → version → config │   │  Claude / Codex / Kimi /   │
   │  产出 AgentDescriptor      │   │  OpenCode / Hermes ...     │
   └────────────────────────────┘   └─────────────┬──────────────┘
                                                   │ spawn/send/stream
                                     ┌─────────────▼──────────────┐
                                     │ 子进程桥接（spawn + stdio） │
                                     │ 外部 CLI agent 可执行文件    │
                                     └────────────────────────────┘
```

### 2.2 数据流（一次 discover + spawn）

```
discoverAll()
  → 对每个已注册 Detector 执行 detect()
  → 汇总为 AgentDescriptor[]
  → Registry 去重 / 排序 / 缓存
  → honeycomb 消费，映射为 TeammateDescriptor
  → 注册进 Roster（外部 teammate）

spawn(teammateId, cwd)
  → Registry.resolve(id) 拿到 Adapter
  → Adapter.spawnSession(cwd) 拉起子进程（stdio 管道）
  → 外部 agent 的 stdout/stderr → 标准化事件流
  → 推入 honeycomb 消息总线
```

---

## 3. 统一模型：`AgentDescriptor` 与 `TeammateDescriptor`

### 3.1 AgentDescriptor（连接器层的识别结果）

```ts
interface AgentDescriptor {
  /** 全局唯一 id，如 "codex"、"kimi-code" */
  id: string;
  /** 展示名 */
  displayName: string;
  /** 归类：外部 CLI agent */
  kind: "external-cli";
  /** 命中的可执行文件绝对路径 */
  binPath: string | null;
  /** 版本号（若可解析） */
  version: string | null;
  /** 配置目录绝对路径 */
  configDir: string | null;
  /** 识别来源与可信度 */
  confidence: "binary" | "config-only" | "manual";
  /** 识别到的能力标签（流式/工具/审批/思考等） */
  capabilities: AgentCapability[];
  /** 原始探测元数据（供调试） */
  probe: ProbeResult;
}
```

### 3.2 TeammateDescriptor（honeycomb 侧的 teammate 模型）

这是把 `AgentDescriptor` 包装成 teammate 的**统一模型**，编排层只认这一层，不感知外部 CLI 的差异。

```ts
interface TeammateDescriptor {
  /** teammate 在 team 内的唯一 id */
  teammateId: string;
  displayName: string;
  /** 来源：本进程原生 agent 或 外部 CLI */
  origin: "native" | "external-cli";
  /** 回指 connector 里的 adapter id */
  connectorId: string | null;
  /** 能力矩阵（用于任务分配判定） */
  capabilities: {
    tools: boolean;
    approval: boolean;
    streaming: boolean;
    thinking: boolean;
    filesystem: boolean;
  };
  /** 会话元数据 */
  session: {
    spawnable: boolean;
    cwdScoped: boolean;
  };
}
```

---

## 4. Agent Adapter 接口（概念级）

每个外部 CLI agent 对应一个 adapter 实现。接口只定义**语义契约**，不绑定任何 AionUi 命名。

```ts
interface AgentAdapter {
  /** adapter 唯一 id（如 "codex"） */
  readonly id: string;

  /** 探测：本机是否安装了该 agent。返回 null 表示未命中 */
  detect(env: HostEnv): Promise<AgentDescriptor | null>;

  /** 能力声明：该 adapter 支持哪些交互能力 */
  readonly capabilities: AgentCapability[];

  /** 启动一个会话子进程 */
  spawnSession(input: SpawnInput): Promise<AgentSession>;

  /** 校验一个未命中 bin 的 descriptor 是否仍然有效（用于缓存刷新） */
  validate(descriptor: AgentDescriptor): Promise<boolean>;
}

interface AgentSession {
  readonly sessionId: string;
  /** 发送一条用户消息（prompt / 文本） */
  send(message: SessionMessage): Promise<void>;
  /** 订阅标准化事件流（stdout 增量、工具调用、结束、错误） */
  events(): AsyncIterable<SessionEvent>;
  /** 优雅结束会话 */
  close(): Promise<void>;
  /** 强杀 */
  kill(): Promise<void>;
}

interface SpawnInput {
  cwd: string;
  env: Record<string, string>;
  /** 初始系统指令 / 上下文 */
  context?: SessionContext;
}
```

### 4.1 能力标签（AgentCapability）

统一的能力枚举，避免每个 adapter 自造一套：

```
"streaming"    // 支持流式输出增量
"tool-use"     // 支持工具调用
"approval"     // 支持审批/确认交互
"thinking"     // 支持思考链输出
"read-only"    // 只读模式（-p / --print）
"interactive"  // 支持 REPL 交互
```

---

## 5. detect() 自动识别机制

### 5.1 三层探测（由浅入深）

```
Layer 1  PATH 探测（binary）
   → 扫描 PATH 下是否存在可执行文件（claude / codex / kimi / opencode / hermes）
   → 命中 → confidence = "binary"

Layer 2  版本探测（version）
   → 执行 `<bin> --version`（或 -V）
   → 解析版本号，超时保护（如 3s）
   → 版本号作为 descriptor.version

Layer 3  配置目录探测（config）
   → 按约定路径查找配置目录：
       claude   → ~/.claude
       codex    → ~/.codex/config.toml
       kimi     → ~/.kimi-code/config.toml
       opencode → ~/.config/opencode/opencode.json
       hermes   → ~/.hermes/.env
   → 存在 → 补充 configDir，并可读取默认模型/权限等元数据
```

### 5.2 识别优先级与冲突处理

- **bin 命中 > config 命中**：若 `binPath` 存在则 `confidence = "binary"`；只有配置目录而无 bin 时 `confidence = "config-only"`（表示"装了但可能不在 PATH"）。
- **同名冲突**：不同 agent 入口名冲突（如某包装器也提供 `kimi`）时，用 `--version` 输出的特征串二次判定；仍无法判定则降级为 `config-only` 并保留人工确认入口。
- **去重**：同一 agent 多路径命中（如 `/usr/local/bin/codex` 与 `~/.local/bin/codex`）取 PATH 顺序靠前者。

### 5.3 缓存与失效

- 识别结果写入持久化存储（Cordis persistence），带 `probe.ts` 时间戳。
- 失效策略：
  - `TTL`（默认 24h）到期后重新探测；
  - `binPath` 变化（文件 mtime / 消失）触发重探测；
  - 用户手动触发 `rescan`。
- 手动登记（`confidence = "manual"`）永不被自动探测覆盖。

### 5.4 探测接口

```ts
interface HostEnv {
  path: string[];
  home: string;
  platform: "darwin" | "linux" | "win32";
  arch: string;
  shell: string;
}

interface ProbeResult {
  layer: "path" | "version" | "config";
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  durationMs: number;
}
```

---

## 6. 与 honeycomb / Cordis 的映射

| 概念 | 映射目标（Cordis 原语） | 说明 |
| --- | --- | --- |
| Registry | 一个 service | `connector.registry`，提供 discover/resolve |
| Detector / Adapter 注册 | service 注入 | 各 adapter 作为可插拔服务挂到 registry |
| 识别结果 | config / persistence | 缓存 descriptor 列表 |
| spawn/send/stream | events | 外部 agent 输出映射为标准化事件 |
| session 生命周期 | lifecycle / disposables | 子进程随 session 关闭而清理 |

### 6.1 标准化事件（SessionEvent）

外部 agent 千差万别的 stdout 被统一为事件：

```ts
type SessionEvent =
  | { type: "stream"; delta: string }        // 流式增量
  | { type: "tool-call"; name: string; args: unknown }
  | { type: "tool-result"; name: string; ok: boolean }
  | { type: "approval-request"; message: string }
  | { type: "done"; exitCode: number }
  | { type: "error"; message: string };
```

编排层只消费这些事件，不需要知道底层是 Claude 还是 Hermes。

---

## 7. 子进程桥接（stdio）

统一用 `child_process.spawn` 拉起 CLI，约定：

- 首选**非交互模式**：`-p` / `--print`（Claude Code、Codex、OpenCode 均支持），一次性输出，适合任务式编排。
- 需要长会话时用**交互模式**：stdio 管道维持 REPL，按分隔符切分增量。
- 每个 adapter 负责把自己 agent 的 flags 映射到统一的 `SpawnInput`（cwd / env / context）。
- 环境变量白名单透传（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`KIMI_API_KEY`），密钥不落日志。

---

## 8. 安全边界

1. **信任级别**：外部 agent 默认 `trust = "ask"`；在编排层暴露审批事件，由 leader 决定是否授权工具执行。
2. **cwd 隔离**：每个外部 session 默认在任务目录（cwd）内运行，不继承宿主进程的宽权限。
3. **超时与配额**：探测命令 3s 超时；会话设置 idle 超时（如 5min）自动 close。
4. **密钥安全**：识别阶段不读取任何密钥文件内容，只探测路径存在性；透传环境变量时做白名单过滤。

---

## 9. 目录结构（建议）

```
packages/honeycomb/src/connectors/
  registry.ts          // 注册表 service
  types.ts             // AgentDescriptor / TeammateDescriptor / SessionEvent
  adapter.ts           // AgentAdapter / AgentSession 接口契约
  detect/
    detector.ts        // 三层探测通用逻辑
    host-env.ts        // HostEnv 采集（path/home/platform/shell）
    cache.ts           // 探测结果缓存与失效
  adapters/
    claude-code.ts
    codex.ts
    kimi-code.ts
    opencode.ts
    hermes.ts
  bridge/
    stdio-session.ts   // 子进程桥接 + 事件标准化
    env-filter.ts      // 环境变量白名单
```

---

## 10. 本机实测探测结果（作为设计基线）

| Agent | 探测方式 | 结果 |
| --- | --- | --- |
| Claude Code | `command -v claude` | 未命中（无 bin，无 `~/.claude`） |
| Codex | `command -v codex` / `codex --version` | 命中，codex-cli 0.146.0，`~/.codex/config.toml` |
| Kimi Code | `command -v kimi` / `kimi --version` | 命中，0.34.0，`~/.kimi-code/config.toml` |
| OpenCode | `command -v opencode` / `opencode --version` | 命中，1.18.16，`~/.config/opencode/opencode.json` |
| Hermes | `command -v hermes` / `hermes --version` | 命中，Hermes Agent v0.20.0，`~/.hermes/.env` |

---

## 11. 后续衔接

- 连接器-Pro 的「CLI 接口实测」输出（每个 agent 的 flags / 输出格式）将回填到各 `adapters/*` 的协议细节。
- 编排-Pro 的 `@whalepod/honeycomb` 插件设计决定本连接器以何种 service 形态挂载。
- 本设计中的 `TeammateDescriptor` 是连接器层与编排层的**唯一契约面**，后续接口变更需同步两篇文档。
