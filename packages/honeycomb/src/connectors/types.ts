/**
 * Shared connector type definitions.
 *
 * Conceptual reimplementation of the external CLI-agent adapter contract.
 * These types are dependency-free so that adapters, the detector, and the
 * bridge can all import them without pulling in Cordis or the runtime host.
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

/** How confident the registry is about a detected or registered agent. */
export type Confidence = 'binary' | 'config-only' | 'manual'

/** Known external CLI-agent kinds. */
export type AgentKind = 'claude-code' | 'codex' | 'kimi-code' | 'opencode' | 'hermes'

/** A capability exposed by a detected agent. */
export interface AgentCapability {
  /** Stable capability id, e.g. `filesystem` or `tool-use`. */
  id: string
  /** Human-readable description of the capability. */
  description?: string
}

/**
 * Result of one detection layer. Kept per-layer so the registry can explain
 * *why* an agent was (or was not) detected and at what confidence.
 */
export interface ProbeResult {
  /** Which detection layer produced this result. */
  layer: 'path' | 'version' | 'config' | 'acp'
  /** Whether this layer matched. */
  matched: boolean
  /** Optional detail: resolved binary path, version string, or config dir. */
  detail?: string
}

/** A detected or manually registered external CLI agent. */
export interface AgentDescriptor {
  /** Stable connector id (matches the owning AgentAdapter id). */
  id: string
  /** Human-readable display name. */
  displayName: string
  /** Coarse agent family. */
  kind: AgentKind
  /** Resolved binary path when detected on PATH. */
  binPath?: string
  /** Reported version string when the version probe succeeded. */
  version?: string
  /** Detected config directory (e.g. `~/.claude`). */
  configDir?: string
  /** Detection confidence. */
  confidence: Confidence
  /** Capabilities this agent exposes. */
  capabilities: AgentCapability[]
  /** Raw per-layer probe results for diagnostics and cache invalidation. */
  probe: ProbeResult[]
  /**
   * ACP capability advertisement. When set, the descriptor can be driven
   * by the generic ACP adapter via `AcpAdapter.spawnSession`.
   */
  acp?: {
    spawnArgs: string[]
    capabilityProbe?: string[]
  }
}

/**
 * A teammate derived from a descriptor, ready to be surfaced to the host.
 * `session` is populated once the agent is actually spawned.
 */
export interface TeammateDescriptor {
  /** Stable teammate id within the host. */
  teammateId: string
  /** Human-readable display name. */
  displayName: string
  /** Provenance, e.g. `connector:claude-code`. */
  origin: string
  /** Owning connector id. */
  connectorId: string
  /** Capabilities inherited from the source descriptor. */
  capabilities: AgentCapability[]
  /** Optional live session handle once spawned. */
  session?: unknown
}

/**
 * Normalized session events crossing the adapter/bridge boundary.
 * Every agent-specific wire format is reduced to this union.
 */
export type SessionEvent =
  | { type: 'stream'; chunk: string }
  | { type: 'tool-call'; id: string; name: string; arguments: unknown }
  | { type: 'tool-result'; id: string; content: unknown }
  | { type: 'approval-request'; id: string; prompt: string }
  | { type: 'cancelled' }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; message: string }

/** Input message shape for `AgentSession.send`. */
export interface SessionInput {
  /** Conversation turn content: plain text or a tool-callable block. */
  content: string | Record<string, unknown>
}

/** Snapshot of the host used by the detection layers. */
export interface HostEnvironment {
  platform: NodeJS.Platform
  arch: string
  home: string
  /** PATH entries in resolution order. */
  pathEntries: string[]
  /** The raw environment for subprocess inheritance and filtering. */
  env: Record<string, string>
}

/** Context required to spawn a live CLI session. */
export interface SpawnContext {
  /** Working directory for the spawned process. */
  cwd?: string
  /** Environment additions/overrides (filtered by the env whitelist). */
  env?: Record<string, string>
  /**
   * 可选：直接传一个 descriptor 来跳过内部 detect（用于测试或已知场景）。
   * 缺省时 adapter 会跑一次 detect()。
   */
  descriptor?: AgentDescriptor
}
