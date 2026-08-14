/**
 * Claude Code (Anthropic) adapter — NDJSON-over-stdio implementation.
 *
 * ## Protocol (documented, NOT installed on host — see docs/cli-agent-inventory.md §5)
 *   - Entry:        `claude` (installed via `npm i -g @anthropic-ai/claude-code`
 *       or `brew install --cask claude-code`).
 *   - One-shot run: `claude -p <prompt> --output-format stream-json`
 *     - `-p` / `--print` is one-shot mode; `--output-format stream-json` asks
 *       for NDJSON. The prompt is a **trailing argv argument**.
 *   - Config dir:   `~/.claude/` (`settings.json`); auth via `claude login` /
 *       subscription or an `ANTHROPIC_API_KEY`.
 *   - Output:       NDJSON event stream on stdout. Known event types:
 *         {"type":"system","subtype":"init",...}
 *         {"type":"assistant","message":{"content":[{"type":"text","text":...}]}}
 *         {"type":"tool_use","message":{"content":[{"type":"tool_use","id":...,"name":...,"input":{...}}]}}
 *         {"type":"result","subtype":"success",...}
 *
 * ## Status
 *   Claude Code is **not installed** on this host. Per the implementation
 *   contract, `spawnSession` keeps the detect-resolve path but throws an
 *   explicit, actionable error. Because the CLI is absent, no normalizer is
 *   registered (it will never be reached while the binary is missing); wiring
 *   one is straightforward once the CLI is installed and live frames captured.
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

import type { AgentDescriptor, SpawnContext } from '../types.ts'
import type { AgentSession } from '../adapter.ts'
import { BaseAgentAdapter } from './base.ts'
import type { DetectSpec } from '../detect/detector.ts'
import { collectHostEnvironment } from '../detect/host-env.ts'

/** Recommended way to install Claude Code on macOS. */
const INSTALL_HINT =
  'Run `npm install -g @anthropic-ai/claude-code` (or `brew install --cask claude-code`), then `claude login`.'

export class ClaudeCodeAdapter extends BaseAgentAdapter {
  readonly id = 'claude-code'
  readonly displayName = 'Claude Code'

  readonly capabilities: AgentDescriptor['capabilities'] = [
    { id: 'filesystem', description: 'Read and edit files in the workspace' },
    { id: 'shell', description: 'Run shell commands' },
    { id: 'tool-use', description: 'Invoke MCP tools' },
  ]

  protected readonly spec: DetectSpec = {
    id: this.id,
    displayName: this.displayName,
    kind: 'claude-code',
    binaryName: 'claude',
    configDirName: '.claude',
    versionArgs: ['--version'],
    capabilities: this.capabilities,
  }

  /**
   * Claude Code expects a NDJSON session over stdio (`-p <prompt>
   * --output-format stream-json`). The CLI is not installed on this host, so
   * spawning always surfaces a clear, actionable error. Detection remains in
   * place so the adapter correctly reports "not installed" to the caller.
   */
  override async spawnSession(_ctx: SpawnContext): Promise<AgentSession> {
    const descriptor = await this.detect(collectHostEnvironment())
    if (!descriptor?.binPath) {
      throw new Error(
        `${this.displayName} is not installed — cannot spawn a session. ${INSTALL_HINT}`,
      )
    }
    // Binary present: future wiring point for `-p <prompt> --output-format stream-json`.
    throw new Error(
      `${this.displayName} spawn is not yet wired. Expected wire mode: \`claude -p <prompt> --output-format stream-json\` (NDJSON on stdout).`,
    )
  }
}
