/**
 * Connector registry service.
 *
 * The registry owns the adapter set, orchestrates discovery (three-layer
 * detection + memoization via the detection cache), and exposes descriptors
 * to the host. It is a Cordis {@link Service}, so its state is scoped to the
 * host context and it participates in the host lifecycle.
 *
 * Events emitted (names are namespaced under `connectors/`):
 *   - `connectors/registered`   — after an adapter is registered.
 *   - `connectors/discovered`   — after an agent is detected.
 *   - `connectors/cache-invalidated` — after the detection cache is cleared.
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentAdapter } from './adapter.ts'
import type { AgentDescriptor, HostEnvironment, TeammateDescriptor } from './types.ts'
import { collectHostEnvironment } from './detect/host-env.ts'
import { DetectionCache } from './detect/cache.ts'

/** Registry service configuration. */
export interface RegistryConfig {
  /** Detection cache TTL in milliseconds. */
  cacheTtlMs: number
}

/** Type of the injected `connectors` service on the Cordis context. */
export interface Connectors {
  /** All registered adapters. */
  readonly adapters: readonly AgentAdapter[]
  /** Detected descriptors, keyed by adapter id. */
  readonly descriptors: ReadonlyMap<string, AgentDescriptor>
  register(adapter: AgentAdapter): void
  resolve(id: string): AgentAdapter | undefined
  /** Re-run detection for every adapter and return all found descriptors. */
  discoverAll(host?: HostEnvironment): Promise<AgentDescriptor[]>
  /** Detect a single adapter by id (memoized). */
  detect(id: string, host?: HostEnvironment): Promise<AgentDescriptor | null>
  /** Invalidate the detection cache (optionally a single adapter). */
  invalidate(id?: string): void
  /** Convert a descriptor into a host-ready teammate descriptor. */
  toTeammate(descriptor: AgentDescriptor): TeammateDescriptor
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectors: Connectors
  }

  interface Events {
    /** Emitted after an adapter is registered. */
    'connectors/registered'(id: string): void
    /** Emitted after an agent is detected. */
    'connectors/discovered'(descriptor: AgentDescriptor): void
    /** Emitted after the detection cache is cleared (optionally one adapter). */
    'connectors/cache-invalidated'(id?: string): void
    /** Inbound signal to invalidate the detection cache (optionally one adapter). */
    'connectors/invalidate'(id?: string): void
  }
}

/**
 * Registry service implementation.
 */
export class ConnectorRegistry extends Service implements Connectors {
  static Config: z<RegistryConfig> = z.object({
    cacheTtlMs: z.number().min(0).default(60_000).description('Detection cache TTL in milliseconds'),
  })

  private readonly adapterMap = new Map<string, AgentAdapter>()
  private readonly descriptorMap = new Map<string, AgentDescriptor>()
  private readonly cache: DetectionCache<AgentDescriptor | null>

  constructor(ctx: Context, config: RegistryConfig) {
    super(ctx, 'connectors')
    this.cache = new DetectionCache<AgentDescriptor | null>(config.cacheTtlMs)

    // Re-discover whenever the host signals configuration changed.
    ctx.on('connectors/invalidate', (id?: string) => this.invalidate(id))
  }

  get adapters(): readonly AgentAdapter[] {
    return [...this.adapterMap.values()]
  }

  get descriptors(): ReadonlyMap<string, AgentDescriptor> {
    return this.descriptorMap
  }

  register(adapter: AgentAdapter): void {
    this.adapterMap.set(adapter.id, adapter)
    this.ctx.emit('connectors/registered', adapter.id)
  }

  resolve(id: string): AgentAdapter | undefined {
    return this.adapterMap.get(id)
  }

  async detect(id: string, host: HostEnvironment = collectHostEnvironment()): Promise<AgentDescriptor | null> {
    const adapter = this.adapterMap.get(id)
    if (!adapter) return null

    const cached = this.cache.get(id)
    if (cached !== undefined) return cached

    const descriptor = await adapter.detect(host)
    this.cache.set(id, descriptor)
    if (descriptor) {
      this.descriptorMap.set(id, descriptor)
      this.ctx.emit('connectors/discovered', descriptor)
    }
    return descriptor
  }

  async discoverAll(host: HostEnvironment = collectHostEnvironment()): Promise<AgentDescriptor[]> {
    const ids = [...this.adapterMap.keys()]
    const results = await Promise.all(ids.map((id) => this.detect(id, host)))
    return results.filter((d): d is AgentDescriptor => d !== null)
  }

  invalidate(id?: string): void {
    this.cache.invalidate(id)
    if (id !== undefined) this.descriptorMap.delete(id)
    else this.descriptorMap.clear()
    this.ctx.emit('connectors/cache-invalidated', id)
  }

  toTeammate(descriptor: AgentDescriptor): TeammateDescriptor {
    return {
      teammateId: `connector:${descriptor.id}`,
      displayName: descriptor.displayName,
      origin: `connector:${descriptor.id}`,
      connectorId: descriptor.id,
      capabilities: descriptor.capabilities,
    }
  }
}
