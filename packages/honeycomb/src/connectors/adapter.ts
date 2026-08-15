/**
 * Adapter and session interface contracts.
 *
 * An {@link AgentAdapter} knows how to *detect* one external CLI agent and,
 * eventually, how to *spawn* a live session for it. An {@link AgentSession}
 * is the normalized, agent-agnostic handle over that live process.
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

import type {
  AgentCapability,
  AgentDescriptor,
  HostEnvironment,
  SessionEvent,
  SessionInput,
  SpawnContext,
} from './types.ts'

/**
 * Handle over a live external CLI-agent process, normalized so the host
 * never has to understand a specific wire format.
 */
export interface AgentSession {
  /** Stable session id. */
  readonly sessionId: string
  /** Send one turn to the agent. */
  send(input: SessionInput): Promise<void>
  /** Async iterable of normalized {@link SessionEvent}s. */
  readonly events: AsyncIterable<SessionEvent>
  /**
   * Abort the in-flight prompt turn if any. The session stays alive; the
   * underlying agent should respond to the in-flight turn with a cancelled
   * stopReason, after which a new {@link send} may be issued.
   *
   * Optional: adapters that don't support mid-turn abort (or that have no
   * notion of "current turn") may omit this. Callers should feature-detect
   * and fall back to {@link close}/{@link kill} when absent.
   */
  cancel?(): Promise<void>
  /** Gracefully close stdin and wait for the process to exit. */
  close(): Promise<void>
  /** Forcefully terminate the process. */
  kill(): Promise<void>
}

/**
 * Per-agent adapter contract.
 *
 * Implementations are stateless with respect to live sessions: `detect` and
 * `validate` only probe the host, while `spawnSession` creates a fresh
 * {@link AgentSession} per call.
 */
export interface AgentAdapter {
  /** Stable connector id, also used as the {@link AgentDescriptor.id}. */
  readonly id: string
  /** Human-readable display name. */
  readonly displayName: string
  /** Capabilities this agent exposes when detected. */
  readonly capabilities: AgentCapability[]
  /**
   * Detect whether this agent is installed on the host.
   * @param host - snapshot of the host environment (PATH, home, platform).
   * @returns a descriptor when detected, otherwise `null`.
   */
  detect(host: HostEnvironment): Promise<AgentDescriptor | null>
  /**
   * Spawn a live CLI session.
   *
   * Stub: awaiting the connector-Pro CLI inventory to finalize the exact
   * subprocess argv and wire-format normalization per agent.
   */
  spawnSession(ctx: SpawnContext): Promise<AgentSession>
  /**
   * Validate that a candidate descriptor still points at a runnable agent.
   * @returns `true` when the binary path is present and executable.
   */
  validate(descriptor: AgentDescriptor): Promise<boolean>
}
