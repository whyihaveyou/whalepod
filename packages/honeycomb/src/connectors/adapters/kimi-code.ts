/**
 * Kimi Code (Moonshot AI) adapter — NDJSON-over-stdio implementation.
 *
 * ## Protocol (measured on host, docs/cli-agent-inventory.md §2)
 *   - Entry:        `kimi` (`~/.kimi-code/bin/kimi`).
 *   - One-shot run: `kimi --output-format stream-json -p "<prompt>"`
 *     - `-p/--prompt <prompt>` takes the prompt as its **value** (measured:
 *       a trailing-positional prompt makes kimi error `unknown command`);
 *       `--output-format stream-json` requests NDJSON. `send()` is deferred so
 *       `-p` is placed last in argv and the first string content becomes its
 *       value when appended.
 *   - Config dir:   `~/.kimi-code/config.toml` — contains two providers:
 *       `managed:kimi-code` (OAuth to `api.kimi.com`) and `ark`
 *       (API-key to `ark.cn-beijing.volces.com`, default `ark/ark-code-latest`).
 *   - Output:       NDJSON event stream on stdout (Kimi CLI-agent protocol).
 *     Frames are JSON objects whose observable fields vary; the parser below
 *     maps message-ish and tool-ish frames tolerantly.
 *
 *   NOTE (measured): both text and stream-json calls timed out on the current
 *   host (ark endpoint slow/rate-limited). This is a documented best-effort
 *   mapping of the documented wire format; validate against live frames when a
 *   responsive provider is available.
 *
 * ## Normalization to SessionEvent
 *   - a frame carrying free assistant text            -> `stream` chunk.
 *   - a frame carrying a `tool_call` array/object     -> `tool-call`.
 *   - a frame carrying a `tool_result`/`tool_output`  -> `tool-result`.
 *   - a frame with `type === 'error'` / `error` field -> `error`.
 *   - any other JSON frame                            -> discarded.
 *   - non-JSON banner lines                           -> discarded.
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

/** kimi stream-json frame (tolerant shape). */
interface KimiFrame {
  type?: string
  error?: { message?: string } | string
  message?: string
  text?: string
  content?: string
  tool_call?: {
    id?: string
    function?: { name?: string; arguments?: string | Record<string, unknown> }
  } | unknown
  tool_calls?: unknown
  tool_result?: unknown
  tool_output?: unknown
}

/** Coerce a tool-call frame into a normalized tool-call event, or null. */
function kimiToolCall(frame: KimiFrame): SessionEvent | null {
  const raw = frame.tool_call ?? frame.tool_calls
  const arr = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : []
  if (arr.length === 0) return null
  const first = arr[0] as { id?: string; function?: { name?: string; arguments?: unknown } }
  const fn = first?.function
  let args: unknown = fn?.arguments ?? {}
  if (typeof args === 'string') {
    args = tryParseJson<Record<string, unknown>>(args) ?? args
  }
  return {
    type: 'tool-call',
    id: first?.id ?? toolSessionId('kimi-tool', 0),
    name: fn?.name ?? 'unknown-tool',
    arguments: args,
  }
}

/** Normalize a single kimi stream-json line into SessionEvents. */
const kimiNormalizer: NormalizeLine = (line) => {
  const frame = tryParseJson<KimiFrame>(line)
  if (!frame) return null

  if (frame.type === 'error' || frame.type === 'error_response') {
    const msg =
      (typeof frame.error === 'string' ? frame.error : frame.error?.message) ??
      frame.message ??
      'kimi error'
    return { type: 'error', message: msg }
  }

  const tool = kimiToolCall(frame)
  if (tool) return tool

  if (frame.tool_result !== undefined || frame.tool_output !== undefined) {
    return {
      type: 'tool-result',
      id: toolSessionId('kimi-result', 0),
      content: frame.tool_result ?? frame.tool_output ?? null,
    }
  }

  const text = frame.text ?? frame.content ?? frame.message
  if (typeof text === 'string' && text.trim()) {
    return { type: 'stream', chunk: text }
  }

  return null
}

export class KimiCodeAdapter extends BaseAgentAdapter {
  readonly id = 'kimi-code'
  readonly displayName = 'Kimi Code'

  readonly capabilities: AgentDescriptor['capabilities'] = [
    { id: 'filesystem', description: 'Read and edit files in the workspace' },
    { id: 'shell', description: 'Run shell commands' },
    { id: 'tool-use', description: 'Invoke MCP tools' },
  ]

  protected readonly spec: DetectSpec = {
    id: this.id,
    displayName: this.displayName,
    kind: 'kimi-code',
    binaryName: 'kimi',
    configDirName: '.kimi-code',
    versionArgs: ['--version'],
    capabilities: this.capabilities,
  }

  /**
   * argv for the one-shot stream-json run; the prompt is appended by `send()`.
   *
   * kimi's non-interactive prompt is the **value of `-p/--prompt <prompt>`**
   * (measured: trailing-positional prompts fail — kimi reports
   * "unknown command"); so `-p` must sit LAST so the deferSpawn-appended
   * prompt becomes its value: `kimi --output-format stream-json -p "<prompt>"`.
   */
  protected override spawnArgs: string[] = ['--output-format', 'stream-json', '-p']

  /**
   * Spawn a live kimi session in deferred mode so `send()` appends the
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
      normalizeLine: kimiNormalizer,
      deferSpawn: true,
    })
  }
}

// Re-export the event type for bridging layers.
export type KimiCodeEvent = SessionEvent
