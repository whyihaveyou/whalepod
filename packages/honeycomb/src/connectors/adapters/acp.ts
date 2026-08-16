/**
 * ACP (Agent Client Protocol) 通用 adapter。
 *
 * 任何「支持 ACP」的外部 CLI agent 都能通过本 adapter 直接接入 honeycomb 编队，
 * 复用既有的 `AgentAdapter` / `AgentSession` 契约与 `agent-runtime` 胶水层。
 *
 * 协议细节：
 *   - JSON-RPC 2.0 over stdio（NDJSON，schema 来自 @agentclientprotocol/sdk）
 *   - 子进程：`<descriptor.binPath> <descriptor.acp.spawnArgs>`
 *   - 客户端能力：session/request_permission
 *   - 服务端能力：initialize / session/new / session/prompt / session/cancel
 *
 * 已知 ACP-capable agent（catalog 由本文件维护）：
 *   - opencode (`opencode acp` 子命令)
 *
 * 接入新 ACP agent：见 `docs/acp-adapter.md` 的「Onboarding 步骤」。
 *
 * 硬边界（与任务一致）：
 *   - 不动 src/services/、src/consumer/、src/transport/、src/runtime/agent-runtime.ts
 *   - 仅依赖 @agentclientprotocol/sdk 的协议层，不耦合具体 agent
 *
 * @module @dfh/honeycomb/connectors/adapters/acp
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  type ContentBlock,
  type NewSessionRequest,
  type PromptRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
  type ToolCallUpdate,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type { AgentAdapter, AgentSession } from '../adapter.ts'
import {
  type AgentCapability,
  type AgentDescriptor,
  type HostEnvironment,
  type SessionEvent,
  type SpawnContext,
} from '../types.ts'
import { BaseAgentAdapter } from './base.ts'
import { Detector, type DetectSpec } from '../detect/detector.ts'
import { collectHostEnvironment } from '../detect/host-env.ts'

// ---------- ACP-capable agent catalog ----------

/** 一个 ACP-capable agent 的最小元数据（驱动 DetectSpec）。 */
export interface AcpCatalogEntry {
  id: string
  displayName: string
  /** 该 agent 的家族（用于 UI 分类）。 */
  kind: AgentDescriptor['kind']
  /** PATH 上的二进制名。 */
  binaryName: string
  /** 触发 ACP 模式的 argv（如 `['acp']`）。 */
  spawnArgs: string[]
  /** 可选的存在性 probe（追加在 spawnArgs 后，exit 0 即视为可用）。 */
  capabilityProbe?: string[]
  /** 配置目录名（如 `.opencode`）。 */
  configDirName: string
  /** 该 adapter 暴露的能力。 */
  capabilities: AgentCapability[]
}

/**
 * 默认权限策略：白名单工具名（read / ls / grep / glob / search）auto-approve，
 * 其它默认拒绝。harness 后续版本可注入 UI 接管。
 */
const ACP_DEFAULT_CAPABILITIES: AgentCapability[] = [
  { id: 'streaming' },
  { id: 'tool-use' },
  { id: 'approval' },
  { id: 'multi-turn' },
  { id: 'session-fork' },
]

/**
 * 内置 catalog。
 *
 * 接入新 agent：在本表追加一行 + 在 `acp-adapter.md` 文档里记录 onboarding 步骤。
 */
export const ACP_CATALOG: readonly AcpCatalogEntry[] = [
  {
    id: 'opencode-acp',
    displayName: 'OpenCode (ACP)',
    kind: 'opencode',
    binaryName: 'opencode',
    spawnArgs: ['acp'],
    capabilityProbe: ['--help'],
    configDirName: '.opencode',
    capabilities: ACP_DEFAULT_CAPABILITIES,
  },
  {
    id: 'kimi-code-acp',
    displayName: 'Kimi Code (ACP)',
    kind: 'kimi-code',
    binaryName: 'kimi',
    // `kimi` 的 ACP 入口是 subcommand `acp`（不是 `--acp` flag），实测确认
    // （kimi 0.34.0，`kimi acp --help` exit 0；`kimi --acp` 报 "unknown option"）。
    spawnArgs: ['acp'],
    capabilityProbe: ['--help'],
    configDirName: '.kimi-code',
    // Kimi acp 自报能力（实测 initialize 响应）：
    //   promptCapabilities.image = true  →  加 image
    //   promptCapabilities.embeddedContext = true
    //   sessionCapabilities.{list, resume, close, delete, fork, additionalDirectories} = true
    //     → resume 即 session/load（catalog 暂不暴露，follow-up #① session/load 实现后加 loadSession 字段）
    //   mcpCapabilities.{http, sse} = true →  暂不暴露，等 MCP 集成落地再补
    capabilities: [...ACP_DEFAULT_CAPABILITIES, { id: 'image', description: 'Accept image content in prompt' }],
  },
  {
    id: 'gemini-cli-acp',
    displayName: 'Gemini CLI (ACP)',
    // ⚠️ kind 现用 placeholder 'claude-code'：AgentKind 联合尚无 'gemini-cli'。
    // 需在 types.ts 的 AgentKind 增加 'gemini-cli' 后再改此字段（超连接器 scope），
    // 否则 dispatch 时可能被误识别为 claude-code 家族。装 gemini 后即可 detect 命中，
    // kind 修正前仅保证「可发现 / 可接入」，能力匹配请以 capabilities 为准。
    kind: 'claude-code',
    binaryName: 'gemini',
    // Google @google/gemini-cli 的 ACP 入口：官方走 `gemini --acp` flag；
    // 个别版本为 subcommand `acp`（对照 kimi）。本机未装，故以下按官方 flag 填，
    // 安装后请实测 `gemini acp --help` vs `gemini --acp --version` 二选一校正。
    spawnArgs: ['--acp'],
    capabilityProbe: ['--version'],
    configDirName: '.gemini',
    // gemini 支持多模态 image 输入；description 与 kimi 对齐（AgentCapability.description 可省，给全更清晰）。
    capabilities: [...ACP_DEFAULT_CAPABILITIES, { id: 'image', description: 'Accept image content in prompt' }],
  },
]

/**
 * 把 `ACP_CATALOG` 里的每一项实例化为 `AcpAdapter`，供 registry.register() 批量接入。
 * 启动时一行 `for (const a of bootstrapAcpAdapters()) registry.register(a)` 即可。
 * 4 家 stdio 适配器（claude-code / codex / kimi-code / opencode / hermes）各有自己的注册路径，不在此处统一 bootstrap。
 */
export function bootstrapAcpAdapters(): AgentAdapter[] {
  return ACP_CATALOG.map((entry) => new AcpAdapter(entry))
}

// ---------- ACP → SessionEvent 规范化 ----------

/** 把单个 ACP `SessionUpdate` 翻译成 0..N 个标准 `SessionEvent`。 */
export function normalizeSessionUpdate(update: SessionUpdate): SessionEvent[] {
  const out: SessionEvent[] = []
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = extractText(update.content)
      if (text !== null) {
        out.push({ type: 'stream', chunk: text })
      }
      // image content 与 text 共存于同一 chunk（ACP 允许 content 是 image 时不带 text）
      for (const img of extractImages(update.content)) {
        out.push({ type: 'image', source: 'agent', mimeType: img.mimeType, data: img.data })
      }
      break
    }
    case 'agent_thought_chunk': {
      // 思考链也以 stream 形式透传；上层可按需展示成 thought block。
      const text = extractText(update.content)
      if (text !== null) {
        out.push({ type: 'stream', chunk: text })
      }
      break
    }
    case 'tool_call': {
      const tc: ToolCall = update
      out.push({
        type: 'tool-call',
        id: tc.toolCallId,
        name: tc.title ?? tc.name ?? tc.toolCallId,
        arguments: tc.rawInput ?? tc.content ?? null,
      })
      // tool_call.content 里的 image 单独 emit image 事件（source='tool'，绑 toolCallId），
      // 让 UI 能直接渲染图，而不必遍历 tool-result 的混合 content 数组。
      for (const img of collectImagesFromArray(tc.content)) {
        out.push({
          type: 'image',
          source: 'tool',
          toolCallId: tc.toolCallId,
          mimeType: img.mimeType,
          data: img.data,
        })
      }
      // 同一个 tool_call 里也可能带 content（早期完成的工具），兜底补一条 result。
      const completed =
        tc.status === 'completed' ||
        tc.status === 'failed' ||
        (tc.content && tc.content.length > 0)
      if (completed) {
        out.push({
          type: 'tool-result',
          id: tc.toolCallId,
          content: tc.rawOutput ?? tc.content ?? null,
        })
      }
      break
    }
    case 'tool_call_update': {
      const tcu: ToolCallUpdate = update
      // 同 tool_call：先 emit image 事件，再 emit tool-result。
      for (const img of collectImagesFromArray(tcu.content)) {
        out.push({
          type: 'image',
          source: 'tool',
          toolCallId: tcu.toolCallId,
          mimeType: img.mimeType,
          data: img.data,
        })
      }
      if (tcu.status === 'completed' || tcu.status === 'failed') {
        out.push({
          type: 'tool-result',
          id: tcu.toolCallId,
          content: tcu.rawOutput ?? tcu.content ?? null,
        })
      }
      break
    }
    case 'plan':
    case 'plan_update':
    case 'plan_removed':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
    case 'user_message_chunk':
      // 暂不向上层暴露，纯展示/状态。
      break
    default: {
      // 未知 update 类型：忽略（forward-compat），未来 schema 扩展不影响本适配器。
      const _exhaustive: never = update
      void _exhaustive
    }
  }
  return out
}

function extractText(content: ContentBlock): string | null {
  if (content.type === 'text') return content.text
  return null
}

/**
 * 从单个 ContentBlock 抽 image 字段。ACP ImageContent 是
 * `{ data: string (base64), mimeType: string, uri?, annotations?, _meta? }`。
 * 拿到的 data 已经是 base64 字符串，透传时不再做 buffer 转换（避免无谓的
 * Uint8Array ↔ Buffer 互转开销，也保留原始字节序）。
 */
function extractImages(content: ContentBlock): Array<{ mimeType: string; data: string }> {
  if (content.type === 'image') {
    return [{ mimeType: content.mimeType, data: content.data }]
  }
  return []
}

/**
 * 工具调用里 content 是 ContentBlock[]（ACP 允许 tool result 里混 text/image/resource），
 * 收集所有 image content 块供 emit。
 */
function collectImagesFromArray(
  blocks: ReadonlyArray<ContentBlock> | undefined,
): Array<{ mimeType: string; data: string }> {
  if (!blocks) return []
  const out: Array<{ mimeType: string; data: string }> = []
  for (const b of blocks) {
    if (b.type === 'image') {
      out.push({ mimeType: b.mimeType, data: b.data })
    }
  }
  return out
}

// ---------- AcpSession + 事件队列 ----------

/**
 * 通用生产者/消费者事件队列。
 *
 * - sessionUpdate 通知（来自 ClientSideConnection 的 handler）调用 `enqueue`
 *   把 SessionEvent 推入；
 * - AgentSession.events() 通过 `dequeue()` 拉取；
 * - close()/kill() 调用 `enqueue(null)` 让所有等待者醒来。
 */
export class SessionEventQueue {
  private readonly eventQueue: SessionEvent[] = []
  private readonly waiters: Array<(ev: SessionEvent | null) => void> = []
  private closed = false

  enqueue(ev: SessionEvent | null): void {
    if (ev === null) {
      const ws = this.waiters.splice(0)
      for (const w of ws) w(null)
      return
    }
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(ev)
    } else {
      this.eventQueue.push(ev)
    }
  }

  dequeue(): Promise<SessionEvent | null> {
    const ev = this.eventQueue.shift()
    if (ev !== undefined) return Promise.resolve(ev)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.enqueue(null)
  }
}

/**
 * 一个 ACP 会话（一次 newSession）的标准 AgentSession 适配。
 *
 * `events` 由 sessionUpdate 通知驱动；`send` 通过 `conn.prompt(...)` 主动发送
 * 用户输入并等待 turn 完成。
 */
export class AcpSession implements AgentSession {
  readonly sessionId: string
  private readonly child: ChildProcess
  private readonly connection: ClientSideConnection
  private readonly queue: SessionEventQueue
  private closed = false
  /**
   * The in-flight {@link ClientSideConnection.prompt} promise, if any.
   * Tracked so that {@link cancel} can decide whether there is a turn to
   * abort and so that {@link send} can mark the turn as `cancelled` (vs
   * `done`) once the prompt response arrives.
   */
  private inflightPrompt: Promise<unknown> | null = null
  private cancelRequested = false

  constructor(args: {
    sessionId: string
    child: ChildProcess
    connection: ClientSideConnection
    queue: SessionEventQueue
  }) {
    this.sessionId = args.sessionId
    this.child = args.child
    this.connection = args.connection
    this.queue = args.queue
  }

  /** AsyncIterable of SessionEvent。包含 stream/tool-call/tool-result/done/cancelled/error。 */
  readonly events: AsyncIterable<SessionEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SessionEvent>> => {
        while (true) {
          const ev = await this.queue.dequeue()
          if (ev === null) return { value: undefined, done: true }
          if (ev.type === 'error') throw new Error(ev.message)
          return { value: ev, done: false }
        }
      },
      return: async () => {
        await this.close()
        return { value: undefined, done: true }
      },
    }),
  }

  /**
   * 推一条 user message 进入 ACP session 并等待 turn 完成。
   * 完成时根据 `cancelRequested` 自动从队列尾插入 `cancelled` 或 `done` SessionEvent。
   */
  async send(input: { content: string | Record<string, unknown> }): Promise<void> {
    if (this.closed) throw new Error('acp session closed')
    const text = typeof input.content === 'string' ? input.content : JSON.stringify(input.content)
    const req: PromptRequest = {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }
    this.cancelRequested = false
    const promptPromise = this.connection.prompt(req)
    this.inflightPrompt = promptPromise
    try {
      await promptPromise
      this.queue.enqueue(this.cancelRequested ? { type: 'cancelled' } : { type: 'done', exitCode: 0 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.queue.enqueue({ type: 'error', message })
      throw err
    } finally {
      this.inflightPrompt = null
      this.cancelRequested = false
    }
  }

  /**
   * Abort the in-flight prompt turn via ACP `session/cancel` notification.
   *
   * The notification is fire-and-forget from ACP's point of view: this method
   * resolves once the JSON-RPC notification has been written to the transport,
   * NOT once the agent has actually stopped. The in-flight
   * {@link ClientSideConnection.prompt} will then resolve with
   * `stopReason: "cancelled"` and {@link send} will enqueue a
   * `{ type: 'cancelled' }` SessionEvent (instead of `done`).
   *
   * No-op when no prompt is in flight or the session is already closed.
   *
   * Callers must NOT issue a new {@link send} before observing the
   * `cancelled` (or `error`/`done`) SessionEvent — ACP forbids overlapping
   * prompts on the same session id.
   */
  async cancel(): Promise<void> {
    if (this.closed) return
    if (!this.inflightPrompt) return
    this.cancelRequested = true
    try {
      await this.connection.cancel({ sessionId: this.sessionId })
    } catch {
      // Cancel is a notification. If the transport is already dead, the
      // in-flight prompt() will reject on its own and send() will surface
      // the error as a SessionEvent 'error'. Nothing to do here.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue.close()
    try {
      this.child.kill('SIGTERM')
    } catch {
      // ignore
    }
  }

  async kill(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue.close()
    try {
      this.child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }
}

// ---------- AcpAdapter ----------

/**
 * 通用 ACP adapter。
 *
 * 复用 `Detector` 跑标准三层（path / version / config）+ 第四层 ACP 能力 probe。
 * spawnSession 把任意 ACP-capable binary 包装成标准 `AgentSession`。
 *
 * 一次实例对应一个 catalog entry；多 agent 共存场景下由注册层为每个 entry
 * 单独 new 一个 AcpAdapter，或以 options 切换 catalog。
 */
export class AcpAdapter extends BaseAgentAdapter implements AgentAdapter {
  readonly id: string
  readonly displayName: string
  readonly capabilities: AgentCapability[]
  protected readonly spec: DetectSpec
  protected readonly spawnArgs: string[]

  constructor(entry: AcpCatalogEntry = ACP_CATALOG[0]) {
    super()
    this.id = entry.id
    this.displayName = entry.displayName
    this.capabilities = entry.capabilities
    this.spec = {
      id: entry.id,
      displayName: entry.displayName,
      kind: entry.kind,
      binaryName: entry.binaryName,
      configDirName: entry.configDirName,
      acp: {
        spawnArgs: entry.spawnArgs,
        capabilityProbe: entry.capabilityProbe,
      },
      capabilities: entry.capabilities,
    }
    this.spawnArgs = entry.spawnArgs
  }

  override async detect(host: HostEnvironment): Promise<AgentDescriptor | null> {
    const detector = new Detector(this.spec)
    return detector.detect(host)
  }

  /**
   * 启动 ACP 子进程并握手。
   *
   * 子进程 argv = `[...descriptor.binPath, ...descriptor.acp.spawnArgs]`；
   * stdin/stdout 通过 ndJsonStream 包成 ACP 协议流；
   * initialize 成功后立即 newSession（cwd = ctx.cwd ?? process.cwd()）。
   */
  override async spawnSession(ctx: SpawnContext): Promise<AgentSession> {
    // ctx.descriptor 可用于测试或已知场景直接跳过 detect。
    const descriptor = ctx.descriptor ?? (await this.detect(collectHostEnvironment()))
    if (!descriptor?.binPath || !descriptor.acp) {
      throw new Error(
        `${this.displayName} is not installed or not ACP-capable — cannot spawn a session`,
      )
    }

    const cwd = ctx.cwd ?? process.cwd()
    const child = spawn(descriptor.binPath, descriptor.acp.spawnArgs, {
      cwd,
      env: ctx.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // 把 stderr 透传给控制台，方便排错（开发期体验）。
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[${this.id}] ${chunk.toString()}`)
    })

    // Node child stdio 流 → Web ReadableStream / WritableStream。
    // ACP SDK 期望 (output, input)：output 是我们写入的（→ agent 的 stdin），
    // input 是我们读取的（← agent 的 stdout）。
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    )

    // 构造客户端：注册默认 permission handler（fail-closed deny，harness 后续
    // 可注入 UI handler 替换）。
    //
    // 使用 deprecated `ClientSideConnection` API：handler 收到 agent 实例，
    // 我们把 sessionUpdate 通知推到 eventQueue（供 events() 消费），
    // send() 直接 await conn.prompt() 完成（prompt 完成时 enqueue done）。
    const sessionQueue = new SessionEventQueue()
    let sessionIdRef = ''
    const conn = new ClientSideConnection(
      () => ({
        requestPermission: () => defaultPermissionResponse(),
        sessionUpdate: (notification: SessionNotification) => {
          for (const ev of normalizeSessionUpdate(notification.update)) {
            sessionQueue.enqueue(ev)
          }
        },
      }),
      stream,
    )

    try {
      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'honeycomb', version: '0.0.1' },
      })
    } catch (err) {
      child.kill('SIGKILL')
      throw new Error(
        `acp initialize failed for ${descriptor.binPath}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const newSessionRequest: NewSessionRequest = {
      cwd,
      mcpServers: [],
    }
    const newSessionResponse = await conn.newSession(newSessionRequest)
    sessionIdRef = newSessionResponse.sessionId

    return new AcpSession({
      sessionId: newSessionResponse.sessionId,
      child,
      connection: conn,
      queue: sessionQueue,
    })
  }

  /**
   * 仅做连通性 + 能力握手 sanity check。
   * 真实实现可以再调一次 initialize 后立刻 cancel；这里保守走探测层结果。
   */
  override async validate(descriptor: AgentDescriptor): Promise<boolean> {
    return Boolean(descriptor.binPath && descriptor.acp)
  }
}

/**
 * 默认的 permission handler：fail-closed —— 未知请求一律 cancel。
 *
 * 未来 harness 可以通过 `ctx.onPermissionRequest` 注入更细的策略
 * （按 tool name 白名单 / 按 optionId 直接放行 / 转发 UI 等）。
 */
export function defaultPermissionResponse(): RequestPermissionResponse {
  const resp: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
  return resp
}