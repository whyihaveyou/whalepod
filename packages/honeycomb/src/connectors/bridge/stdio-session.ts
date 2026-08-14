/**
 * stdio subprocess bridge.
 *
 * Implements {@link AgentSession} over a spawned CLI-agent process using
 * stdin/stdout pipes. Raw stdout is normalized into the {@link SessionEvent}
 * union by an injectable per-agent normalizer (see {@link NormalizeLine}).
 *
 * Two ownership modes are supported:
 *   - **immediate** (default): the subprocess is spawned in the constructor.
 *   - **deferred** (`deferSpawn: true`): the process is only spawned on the
 *     first {@link send}, so a one-shot CLI agent (opencode `run`, codex
 *     `exec`, kimi `-p`, hermes `-z`) can receive its leading prompt as a
 *     trailing argv argument — which is how those CLIs actually take the
 *     prompt, rather than reading it from stdin.
 *
 * stdout is buffered line-by-line (JSON objects may straddle buffer chunks)
 * and each complete line is handed to the normalizer. stderr is surfaced as
 * `stream` chunks (a later pass may classify per-agent error frames).
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AgentSession } from '../adapter.ts'
import type { SessionEvent, SessionInput, SpawnContext } from '../types.ts'
import { filterEnv } from './env-filter.ts'

/**
 * A per-agent stdout normalizer: turn one raw stdout line into zero or more
 * normalized {@link SessionEvent}s. Return `null` for lines that should be
 * discarded entirely (e.g. known non-payload frames).
 */
export type NormalizeLine = (line: string) => SessionEvent | SessionEvent[] | null

/** Default normalizer: treat every non-empty line as a free-form stream chunk. */
const passthrough: NormalizeLine = (line) => ({ type: 'stream', chunk: line })

/** Options for spawning a stdio-bridged agent session. */
export interface StdioSessionOptions extends SpawnContext {
  /** Resolved binary path of the agent CLI. */
  binPath: string
  /** argv appended to the binary. */
  args?: string[]
  /**
   * Per-agent stdout normalizer. Defaults to surfacing each line as a
   * `stream` event.
   */
  normalizeLine?: NormalizeLine
  /**
   * When `true`, defer spawning until the first {@link send}. On that first
   * send a string `SessionInput.content` is appended as a trailing argv
   * argument before spawning. Use for one-shot CLI agents whose prompt is a
   * positional argument rather than a stdin frame.
   */
  deferSpawn?: boolean
}

/**
 * A live stdio session bridging the host to an external CLI agent.
 */
export class StdioSession implements AgentSession {
  readonly sessionId = randomUUID()

  private readonly opts: StdioSessionOptions
  private readonly normalize: NormalizeLine

  private child?: ChildProcessWithoutNullStreams
  private spawned = false
  private stdoutBuf = ''
  private readonly queue: SessionEvent[] = []
  private readonly waiters: Array<(event: SessionEvent) => void> = []
  private ended = false

  constructor(options: StdioSessionOptions) {
    this.opts = options
    this.normalize = options.normalizeLine ?? passthrough
    if (!options.deferSpawn) this.ensureSpawned()
  }

  /** Lazily spawn the subprocess (immediately, or on first send in deferred mode). */
  private ensureSpawned(): void {
    if (this.spawned) return
    this.spawned = true

    this.child = spawn(this.opts.binPath, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: filterEnv(process.env, undefined, this.opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const child = this.child

    // Buffer stdout line-by-line so JSON objects that straddle buffers are
    // still parsed as a single normalizer input.
    child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString('utf8')
      let nl: number
      while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
        const raw = this.stdoutBuf.slice(0, nl)
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
        const line = raw.replace(/\r$/, '')
        if (line.trim()) this.emit(this.normalize(line))
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      this.emit({ type: 'stream', chunk: chunk.toString('utf8') })
    })

    child.on('close', (code) => {
      // Flush any trailing line without a newline.
      if (this.stdoutBuf.trim()) this.emit(this.normalize(this.stdoutBuf))
      this.emit({ type: 'done', exitCode: code ?? 0 })
      this.ended = true
    })

    child.on('error', (err) => {
      this.emit({ type: 'error', message: err.message })
      this.ended = true
    })
  }

  /** Normalize one line (possibly to zero/many events) and enqueue each. */
  private emit(events: SessionEvent | SessionEvent[] | null): void {
    if (events === null) return
    const list = Array.isArray(events) ? events : [events]
    for (const event of list) this.push(event)
  }

  /** Enqueue an event, waking the next waiting consumer if any. */
  private push(event: SessionEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(event)
    else this.queue.push(event)
  }

  /** Pull the next event from the queue or await one. */
  private next(): Promise<SessionEvent> {
    this.ensureSpawned()
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.ended) return Promise.resolve({ type: 'done', exitCode: this.child?.exitCode ?? 0 })
    return new Promise<SessionEvent>((resolve) => this.waiters.push(resolve))
  }

  get events(): AsyncIterable<SessionEvent> {
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const event = await self.next()
          yield event
          if (event.type === 'done' || event.type === 'error') return
        }
      },
    }
  }

  /**
   * Send one turn to the agent.
   *
   * In deferred one-shot mode the first string content is appended as a
   * trailing argv argument before the process spawns, matching how
   * `opencode run <prompt>` / `codex exec <prompt>` / `kimi -p <prompt>` /
   * `hermes -z <prompt>` actually receive their prompt. Subsequent sends (or
   * non-string content) are written to stdin as newline-terminated JSON
   * frames per the baseline contract.
   */
  async send(input: SessionInput): Promise<void> {
    if (this.opts.deferSpawn && !this.spawned) {
      const prompt = typeof input.content === 'string' ? input.content : ''
      if (prompt) this.opts.args = [...(this.opts.args ?? []), prompt]
      this.ensureSpawned()
      return
    }
    this.ensureSpawned()
    this.child!.stdin.write(JSON.stringify(input) + '\n')
  }

  /** Gracefully close stdin and wait for exit. */
  async close(): Promise<void> {
    if (!this.spawned) {
      this.ended = true
      return
    }
    const child = this.child!
    child.stdin.end()
    if (!this.ended) {
      await new Promise<void>((resolve) => child.once('close', () => resolve()))
    }
  }

  /** Forcefully terminate the process. */
  async kill(): Promise<void> {
    if (!this.spawned) {
      this.ended = true
      return
    }
    const child = this.child!
    child.kill()
    if (!this.ended) {
      await new Promise<void>((resolve) => child.once('close', () => resolve()))
    }
  }
}
