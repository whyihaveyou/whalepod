/**
 * Codex (OpenAI CLI) adapter — NDJSON-over-stdio implementation.
 *
 * ## Protocol (measured on host, docs/cli-agent-inventory.md §1)
 *   - Entry:        `codex` (npm-distributed Rust binary, `codex-cli`).
 *   - One-shot run: `codex exec --json <prompt>`
 *     - The prompt is a **trailing argv argument**; `--json` selects raw
 *       NDJSON event output. `send()` runs deferred so the first string
 *       content is appended to argv before spawn.
 *   - Config dir:   `~/.codex/` (`config.toml`, `auth.json`). Auth is OAuth
 *       to the ChatGPT backend, or an `OPENAI_API_KEY`/`CODEX_API_KEY` env.
 *   - Output:       NDJSON event stream on stdout. Known event types
 *       (from `codex exec --json`):
 *         {"type":"thread.started", ...}
 *         {"type":"turn.started", ...}
 *         {"type":"item.completed","item":{"type":"reasoning","content":[{"text":...}]}}
 *         {"type":"item.completed","item":{"type":"tool_use","id":...,"tool_use":{"name":...,"input":{...}}}}
 *         {"type":"item.completed","item":{"type":"text","text":...}}
 *         {"type":"error","code":...,"message":...}
 *
 *   NOTE (measured): on the current host the ChatGPT backend returns HTTP 403
 *   (Cloudflare geographic block) so `exec` hangs then fails until a proxy or
 *   VPN is provided. The parser is still correct; runtime requires network.
 *
 * ## Normalization to SessionEvent
 *   - `item.completed` with item `text`        -> `stream` chunk.
 *   - `item.completed` with item `reasoning`   -> `stream` chunk (marked).
 *   - `item.completed` with item `tool_use`    -> `tool-call`.
 *   - `item.completed` with item `tool_result` -> `tool-result`.
 *   - other meta events (`thread.started`, `turn.started`, ...) -> discarded.
 *   - `type === 'error'` -> `error`.
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

import type { AgentDescriptor, SessionEvent, SpawnContext } from '../types.ts'
import type { AgentSession } from '../adapter.ts'
import { BaseAgentAdapter } from './base.ts'
import type { DetectSpec } from '../detect/detector.ts'
import type { NormalizeLine } from '../bridge/stdio-session.ts'
import { StdioSession } from '../bridge/stdio-session.ts'
import { collectHostEnvironment } from '../detect/host-env.ts'
import { tryParseJson, toolSessionId } from './parse.ts'

/** codex exec --json event frame. */
interface CodexFrame {
  type?: string
  item?: {
    type?: string
    text?: string
    content?: Array<{ type?: string; text?: string }>
    id?: string
    tool_use?: { name?: string; input?: unknown }
    tool_result?: unknown
  }
  code?: string
  message?: string
}

/** Extract text from a codex `content` array of content parts. */
function contentToText(content: Array<{ text?: string }> | undefined): string {
  if (!Array.isArray(content)) return ''
  return content.map((c) => c.text ?? '').join('')
}

/** Normalize a single codex exec NDJSON line into SessionEvents. */
const codexNormalizer: NormalizeLine = (line) => {
  const frame = tryParseJson<CodexFrame>(line)
  if (!frame) return null

  if (frame.type === 'error') {
    return { type: 'error', message: frame.message ?? frame.code ?? 'codex error' }
  }

  if (frame.type !== 'item.completed' || !frame.item) return null

  const itemType = frame.item.type

  if (itemType === 'text') {
    const text = frame.item.text ?? ''
    return text ? { type: 'stream', chunk: text } : null
  }

  if (itemType === 'reasoning') {
    const text = contentToText(frame.item.content)
    return text ? { type: 'stream', chunk: `[reasoning] ${text}` } : null
  }

  if (itemType === 'tool_use') {
    const tool = frame.item.tool_use
    return {
      type: 'tool-call',
      id: frame.item.id ?? toolSessionId('codex-tool', 0),
      name: tool?.name ?? 'unknown-tool',
      arguments: tool?.input ?? {},
    }
  }

  if (itemType === 'tool_result') {
    return {
      type: 'tool-result',
      id: frame.item.id ?? toolSessionId('codex-result', 0),
      content: frame.item.tool_result ?? frame.item.content ?? null,
    }
  }

  return null
}

export class CodexAdapter extends BaseAgentAdapter {
  readonly id = 'codex'
  readonly displayName = 'Codex'

  readonly capabilities: AgentDescriptor['capabilities'] = [
    { id: 'filesystem', description: 'Read and edit files in the workspace' },
    { id: 'shell', description: 'Run shell commands' },
    { id: 'tool-use', description: 'Invoke MCP tools' },
  ]

  protected readonly spec: DetectSpec = {
    id: this.id,
    displayName: this.displayName,
    kind: 'codex',
    binaryName: 'codex',
    configDirName: '.codex',
    versionArgs: ['--version'],
    capabilities: this.capabilities,
  }

  /** argv for the one-shot JSON run; the prompt is appended by `send()`. */
  protected override spawnArgs: string[] = ['exec', '--json', '--skip-git-repo-check']

  /**
   * Spawn a live codex session in deferred mode so `send()` appends the
   * prompt as a trailing argv argument before the process launches.
   */
  override async spawnSession(ctx: SpawnContext): Promise<AgentSession> {
    const descriptor = await this.detect(collectHostEnvironment())
    if (!descriptor?.binPath) {
      throw new Error(`${this.displayName} is not installed — cannot spawn a session`)
    }
    return new StdioSession({
      binPath: descriptor.binPath,
      args: this.spawnArgs,
      cwd: ctx.cwd,
      env: ctx.env,
      normalizeLine: codexNormalizer,
      deferSpawn: true,
    })
  }
}

// Re-export the event type for bridging layers.
export type CodexEvent = SessionEvent
