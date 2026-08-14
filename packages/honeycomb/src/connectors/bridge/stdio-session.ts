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
 * **stdin-EOF note (measured on host):** one-shot agents that take the prompt
 * from argv (e.g. `opencode run "<prompt>"`) block waiting for `stdin` EOF if
 * a piped stdin is left open — measured: 60s+ with zero stdout, versus ~9s and
 * a full NDJSON reply once stdin is closed. Deferred spawn therefore calls
 * `child.stdin.end()` immediately on spawn.
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

    // Deferred one-shot agents deliver their prompt as a trailing argv
    // argument rather than via stdin. Measured on host: leaving the piped
    // stdin open makes agents like `opencode run` block waiting for stdin EOF
    // (no output for 60s+). Close stdin immediately so the process runs its
    // one-shot command without waiting for a stdin prompt.
    if (this.opts.deferSpawn) child.stdin.end()

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
   * trailing argv argument before the process spawns, and stdin is closed
   * immediately on spawn (see {@link StdioSessionOptions.deferSpawn}) — that
   * is how `opencode run <prompt>` / `codex exec <prompt>` / `kimi -p
   * <prompt>` / `hermes -z <prompt>` receive their prompt: via argv, not
   * stdin. Such one-shot agents consume exactly one leading prompt; a
   * subsequent send to the already-closed stdin is a no-op.
   *
   * Non-deferred (interactive) agents keep stdin open and receive
   * newline-terminated JSON frames per the baseline contract.
   */
  async send(input: SessionInput): Promise<void> {
    if (this.opts.deferSpawn) {
      if (!this.spawned) {
        const prompt = typeof input.content === 'string' ? input.content : ''
        if (prompt) this.opts.args = [...(this.opts.args ?? []), prompt]
        this.ensureSpawned()
      }
      // One-shot agent: stdin is closed at spawn; further sends are no-ops.
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
