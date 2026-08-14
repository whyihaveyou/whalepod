/**
 * Hermes Agent adapter — plain-text one-shot implementation.
 *
 * ## Protocol (measured on host, docs/cli-agent-inventory.md §4)
 *   - Entry:        `hermes` (`~/.local/bin/hermes`, `hermes` on PATH).
 *   - One-shot run: `hermes -z <prompt>`
 *     - `-z` / `--oneshot` prints only the final answer as **plain text on
 *       stdout** (no NDJSON/event framing). The prompt is a **trailing argv
 *       argument**; `send()` is deferred so the first string content is
 *       appended to argv before spawn.
 *   - Config dir:   `~/.hermes/config.yaml` — default model
 *       `deepseek-v4-flash`, provider `opencode-go` at
 *       `opencode.ai/zen/go/v1`. Must already be configured + authed.
 *   - Output:       one free-form text blob on stdout; optionally a usage
 *       report when `--usage-file <path>` is passed.
 *
 * ## Normalization to SessionEvent
 *   - each stdout line -> `stream` chunk (concatenated by the consumer it
 *     forms the assistant's final answer).
 *   - non-JSON so no structured error frames; process-level failures surface
 *     via the bridge's `error`/`done` events.
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

/** Hermes `-z` prints plain text; every non-empty line is a stream chunk. */
const hermesNormalizer: NormalizeLine = (line) => {
  const trimmed = line.replace(/\s+$/, '')
  return trimmed ? { type: 'stream', chunk: trimmed + '\n' } : null
}

export class HermesAdapter extends BaseAgentAdapter {
  readonly id = 'hermes'
  readonly displayName = 'Hermes'

  readonly capabilities: AgentDescriptor['capabilities'] = [
    { id: 'filesystem', description: 'Read and edit files in the workspace' },
    { id: 'shell', description: 'Run shell commands' },
    { id: 'tool-use', description: 'Invoke MCP tools' },
  ]

  protected readonly spec: DetectSpec = {
    id: this.id,
    displayName: this.displayName,
    kind: 'hermes',
    binaryName: 'hermes',
    configDirName: '.hermes',
    versionArgs: ['--version'],
    capabilities: this.capabilities,
  }

  /** argv for the one-shot plain-text run; the prompt is appended by `send()`. */
  protected override spawnArgs: string[] = ['-z']

  /**
   * Spawn a live hermes session in deferred mode so `send()` appends the
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
      normalizeLine: hermesNormalizer,
      deferSpawn: true,
    })
  }
}

// Re-export the event type for bridging layers.
export type HermesEvent = SessionEvent
