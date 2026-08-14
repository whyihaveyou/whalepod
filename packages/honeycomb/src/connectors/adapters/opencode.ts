/**
 * OpenCode adapter — reference NDJSON-over-stdio implementation.
 *
 * ## Protocol (measured on host, docs/cli-agent-inventory.md §3)
 *   - Entry:        `opencode` (npm global, `node_modules/.../bin`).
 *   - One-shot run: `opencode run --format json <prompt>`
 *     - The prompt is a **trailing argv argument**, not read from stdin.
 *     - `send()` therefore runs in deferred mode: the first string content is
 *       appended as the final argv element before the process spawns.
 *   - Config dir:   `~/.config/opencode/opencode.json` (model/provider: e.g.
 *     `deepseek/deepseek-chat`). Must already be configured + logged in.
 *   - Output:       NDJSON event stream on stdout. Confirmed event shapes:
 *       {"type":"step_start", "part":{"type":"step-start"}, ...}
 *       {"type":"text",       "part":{"type":"text","text":"<increment>"}, ...}
 *       {"type":"step_finish","part":{"type":"step-finish","tokens":{...},"finishReason":"..."}, ...}
 *     Agentic runs additionally carry tool parts:
 *       {"type":"tool-start", "part":{"type":"tool-start","state":{"input":{...},...}}}
 *       {"type":"result",     "part":{"type":"result","state":{"output":{...}}}}
 *     Top-level `{"type":"error", ...}` frames signal failures.
 *
 * ## Normalization to SessionEvent
 *   - `text` part        -> `stream` chunk (assistant text increment).
 *   - `reasoning` part   -> `stream` chunk (prefixed marker).
 *   - `tool-start` part  -> `tool-call`.
 *   - `tool` (ask) part  -> `approval-request`.
 *   - `result` part      -> `tool-result`.
 *   - `step-start`/`step-finish`/unknowns -> discarded.
 *   - top-level `type === 'error'` -> `error`.
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

/** opencode event frame as documented in the protocol comment above. */
interface OpenCodeFrame {
  type?: string
  part?: {
    type?: string
    text?: string
    state?: {
      input?: unknown
      output?: unknown
      title?: string
    }
  }
  error?: { message?: string } | string
  message?: string
}

/** Whether an object has a `tool` key (used to name opencode tool-calls). */
function inputToolName(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const tool = (input as { tool?: unknown }).tool
  return typeof tool === 'string' ? tool : null
}

/** Normalize a single opencode NDJSON stdout line into SessionEvents. */
const openCodeNormalizer: NormalizeLine = (line) => {
  const frame = tryParseJson<OpenCodeFrame>(line)
  if (!frame) return null // banner / non-JSON line

  if (frame.type === 'error') {
    const msg =
      (typeof frame.error === 'string' ? frame.error : frame.error?.message) ??
      frame.message ??
      'opencode error'
    return { type: 'error', message: msg }
  }

  const partType = frame.part?.type

  if (partType === 'text') {
    const text = frame.part?.text ?? ''
    return text ? { type: 'stream', chunk: text } : null
  }

  if (partType === 'reasoning') {
    const text = frame.part?.text ?? ''
    return text ? { type: 'stream', chunk: `[reasoning] ${text}` } : null
  }

  if (partType === 'tool-start') {
    const state = frame.part?.state
    const input = state?.input
    const name = inputToolName(input) ?? state?.title ?? 'unknown-tool'
    return { type: 'tool-call', id: toolSessionId('opencode-tool', 0), name, arguments: input ?? {} }
  }

  if (partType === 'tool') {
    // opencode "tool" ask part — a pending tool/approval boundary.
    return {
      type: 'approval-request',
      id: toolSessionId('opencode-ask', 0),
      prompt: String(frame.part?.state?.title ?? 'Agent tool action requested'),
    }
  }

  if (partType === 'result') {
    return {
      type: 'tool-result',
      id: toolSessionId('opencode-result', 0),
      content: frame.part?.state?.output ?? frame.part?.state ?? null,
    }
  }

  // step-start / step-finish / other meta frames — discard.
  return null
}

export class OpenCodeAdapter extends BaseAgentAdapter {
  readonly id = 'opencode'
  readonly displayName = 'OpenCode'

  readonly capabilities: AgentDescriptor['capabilities'] = [
    { id: 'filesystem', description: 'Read and edit files in the workspace' },
    { id: 'shell', description: 'Run shell commands' },
    { id: 'tool-use', description: 'Invoke MCP tools' },
  ]

  protected readonly spec: DetectSpec = {
    id: this.id,
    displayName: this.displayName,
    kind: 'opencode',
    binaryName: 'opencode',
    configDirName: '.config/opencode',
    versionArgs: ['--version'],
    capabilities: this.capabilities,
  }

  /**
   * argv for the reference one-shot run; the prompt is appended by `send()`.
   *
   * `--pure` disables opencode's external plugins/MCP bootstrap. Measured on
   * host: without it, opencode launches configured MCP servers (e.g.
   * `sciverse-survey-gates`, which carries no token) and can silently
   * hang >120s before emitting anything; with `--pure` it starts in ~11s and
   * answers deterministically. As a host-driven connector we pass the prompt
   * via argv and read standardized events, so opencode's own MCP servers are
   * unnecessary — `--pure` keeps the link reliable. (If MCP tool access is
   * later required, gate `--pure` behind a config option.)
   */
  protected override spawnArgs: string[] = ['run', '--format', 'json', '--pure']

  /**
   * Spawn a live opencode session in deferred mode so `send()` appends the
   * prompt as a trailing argv argument before the process actually launches.
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
      normalizeLine: openCodeNormalizer,
      deferSpawn: true,
    })
  }
}

// SessionEvent import is re-exported for bridging layers that want the shape.
export type OpenCodeEvent = SessionEvent
