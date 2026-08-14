/**
 * Shared base for per-agent adapters.
 *
 * Each adapter supplies a {@link DetectSpec} (binary name, config dir,
 * capabilities) and inherits the three-layer detection and the
 * `spawnSession`/`validate` skeleton. Concrete adapters override only what
 * differs per agent.
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

import type { AgentAdapter, AgentSession } from '../adapter.ts'
import type { AgentDescriptor, HostEnvironment, SpawnContext } from '../types.ts'
import { Detector, type DetectSpec } from '../detect/detector.ts'
import { StdioSession } from '../bridge/stdio-session.ts'
import { collectHostEnvironment } from '../detect/host-env.ts'

/**
 * Base adapter implementing the shared detection + session scaffolding.
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly id: string
  abstract readonly displayName: string
  abstract readonly capabilities: AgentDescriptor['capabilities']

  /** The detection spec driving the three-layer detector. */
  protected abstract readonly spec: DetectSpec

  /** Subprocess argv appended to the binary when spawning (stub). */
  protected spawnArgs: string[] = []

  async detect(host: HostEnvironment): Promise<AgentDescriptor | null> {
    const detector = new Detector(this.spec)
    return detector.detect(host)
  }

  /**
   * Spawn a live session via the stdio bridge.
   *
   * Stub: requires the resolved binary path. Concrete adapters may set
   * `spawnArgs` once the connector-Pro CLI inventory lands.
   */
  async spawnSession(ctx: SpawnContext): Promise<AgentSession> {
    const descriptor = await this.detect(collectHostEnvironment())
    if (!descriptor?.binPath) {
      throw new Error(`${this.displayName} is not installed — cannot spawn a session`)
    }
    return new StdioSession({
      binPath: descriptor.binPath,
      args: this.spawnArgs,
      cwd: ctx.cwd,
      env: ctx.env,
    })
  }

  /** Validate a descriptor by re-confirming the binary resolves on PATH. */
  async validate(descriptor: AgentDescriptor): Promise<boolean> {
    if (!descriptor.binPath) return false
    const detector = new Detector(this.spec)
    const fresh = detector.detect(collectHostEnvironment())
    return fresh?.binPath === descriptor.binPath
  }
}
