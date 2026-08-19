/**
 * Discovery service (DiscoveryRegistry) — cordis 服务。
 *
 * A3 第二件落地件：发现态快照 + enroll 入口。
 *
 * 分层契约（对齐 docs/agent-discovery-design.md + types.ts 状态模型）：
 *   - L1（probe.ts）：PATH 扫描 + --version 廉价探测，仅证明 presence。
 *     `list`/`refresh(includeHandshake=false)` 只跑 L1。
 *   - L2（本服务惰性触发）：经连接器注册表 `connectors.detect(id)` 跑
 *     ACP 握手 / serverInfo 校验，把 available 从 approximation 落成真值。
 *     `refresh(includeHandshake=true)` / `check` / `enroll` 才跑 L2。
 *   - 铁律①分离：`discovered` 只由 L1 决定；`available` 必须经 L2 握手后才 true。
 *
 * enroll：把发现到的存在且可用的 agent 落成 roster member（insert 形态走
 * `roster.register` → facts 追加的 profile 结构；勿用 packages/bundles 反模式）。
 *
 * @module @dfh/honeycomb/services/discovery
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Connectors } from '../connectors/registry.ts'
import type { RosterService } from './roster.ts'
import type { HiveId, RegisterMemberInput } from '../types.ts'
import type { HostEnvironment } from '../connectors/types.ts'
import {
  DISCOVERY_CATALOG,
  probeAllL1,
  type ProbeCatalogEntry,
  type ProbeOptions,
} from '../connectors/discovery/probe.ts'
import type {
  DiscoveryAgent,
  DiscoveryBackend,
} from '../connectors/discovery/types.ts'
import { collectHostEnvironment } from '../connectors/detect/host-env.ts'

/** enroll 入参。 */
export interface EnrollInput {
  /** catalog agent id（必须已被 L1 discovered）。 */
  agentId: string
  /** 覆盖 roster 显示名（缺省用 agent.displayName）。 */
  name?: string
  /** 角色（缺省 worker）。 */
  role?: RegisterMemberInput['role']
  /** 关联模型（如 claude-sonnet-4-5）。 */
  model?: string
}

/** check/enroll 的返回视图。 */
export interface EnrollResult {
  agent: DiscoveryAgent
  memberId: string | null
  enrolled: boolean
}

export interface DiscoveryConfig {
  /** L2 对未注册 connector 的检测：未注册 connector 一律不可用（默认 true）。 */
  requireConnectorForL2: boolean
}

export const DiscoveryConfigSchema: z<DiscoveryConfig> = z.object({
  requireConnectorForL2: z
    .boolean()
    .default(true)
    .description('L2 要求 agent 已在连接器注册表注册，否则 available 恒 false'),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    discovery: DiscoveryService
  }
  interface Events {
    /** 快照已刷新（L1 探针跑完后 emit）。 */
    'discovery/refreshed'(agents: DiscoveryAgent[]): void
    /** 某 agent 已 enroll 进 roster。 */
    'discovery/enrolled'(agentId: string, memberId: string, hiveId: HiveId): void
  }
}

/**
 * Discovery service — 发现态快照 + enroll 入口。
 */
export class DiscoveryService extends Service implements DiscoveryService {
  static Config = DiscoveryConfigSchema

  /** L1 探测 catalog（缺省内置最小集合）。 */
  readonly catalog: ProbeCatalogEntry[]
  /** 当前发现态快照（agentId -> DiscoveryAgent），纯内存，不落盘。 */
  readonly snapshot: Map<string, DiscoveryAgent>
  /** 记录 enroll 后的 agentId -> memberId 反查表。 */
  readonly enrolled: Map<string, { memberId: string; hiveId: HiveId }>

  private readonly connectors: Connectors
  private readonly roster: RosterService
  private readonly opts: ProbeOptions
  private readonly cfg: DiscoveryConfig

  constructor(
    ctx: Context,
    connectors: Connectors,
    roster: RosterService,
    config: Partial<DiscoveryConfig> = {},
    opts: ProbeOptions = {},
  ) {
    super(ctx, 'discovery')
    this.catalog = DISCOVERY_CATALOG
    this.snapshot = new Map()
    this.enrolled = new Map()
    this.connectors = connectors
    this.roster = roster
    this.opts = opts
    this.cfg = {
      requireConnectorForL2: config.requireConnectorForL2 ?? true,
    }
    void this.refresh(false, collectHostEnvironment())
  }

  /**
   * L1 全量刷新（list 的幂等基础）。缺省 includeHandshake=false 只跑 L1，
   * 输出 discovered 近似态；L2 由 check/refresh(true)/enroll 惰性补齐。
   */
  async refresh(includeHandshake = false, host = collectHostEnvironment()): Promise<DiscoveryAgent[]> {
    const l1 = probeAllL1(this.catalog, host, this.opts, this.#pathSource(host), Date.now())
    this.snapshot.clear()
    for (const agent of l1) this.snapshot.set(agent.id, agent)

    if (includeHandshake) {
      const verified = await Promise.all(
        [...this.snapshot.values()].map((a) => this.check(a.id, host)),
      )
      for (const agent of verified) this.snapshot.set(agent.id, agent)
    }

    // 汇总 enroll 反查，把已编入团队的 agent 标上 enrolledMemberId。
    this.#reconcileEnrolled()
    const all = [...this.snapshot.values()]
    this.ctx.emit('discovery/refreshed', all)
    return all
  }

  /** 返回当前快照（L1 近似态）。 */
  list(): DiscoveryAgent[] {
    this.#reconcileEnrolled()
    return [...this.snapshot.values()]
  }

  /**
   * 单 agent L2 校验（ACP 握手 / serverInfo）。
   * discovered=false 或 connector 未注册 → 直接返回（available 维持 false）。
   */
  async check(agentId: string, host = collectHostEnvironment()): Promise<DiscoveryAgent> {
    const agent = this.snapshot.get(agentId)
    if (!agent) {
      throw new Error(`discovery.check: unknown agentId '${agentId}'`)
    }
    if (!agent.discovered) {
      // 未发现：无需 L2。
      this.snapshot.set(agentId, { ...agent, available: false, status: 'missing' })
      return this.snapshot.get(agentId)!
    }

    const connector = this.connectors.resolve(agentId)
    if (!connector && this.cfg.requireConnectorForL2) {
      // 铁律：connector 未注册 → 无可握手的 adapter，available 不得为真。
      const next: DiscoveryAgent = {
        ...agent,
        available: false,
        status: 'offline',
        error: 'L2: connector not registered in ConnectorRegistry — adapter 未接线',
      }
      this.snapshot.set(agentId, next)
      return next
    }

    // 走连接器注册表的完整检测级联（含 ACP 握手 / serverInfo 校验）。
    const descriptor = connector
      ? await this.connectors.detect(agentId, host)
      : null

    const available = descriptor !== null
    const next: DiscoveryAgent = {
      ...agent,
      available,
      status: available ? 'online' : 'offline',
      version: descriptor?.version ?? agent.version,
      capabilities: (descriptor?.capabilities?.map((c) => String(c)) ??
        agent.capabilities) as string[],
      error: available ? null : 'L2: ACP handshake/serverInfo 未通过',
    }
    this.snapshot.set(agentId, next)
    return next
  }

  /**
   * enroll：把已发现且可用（L2 已确认）的 agent 编入团队。
   * 走 insert 形态 `roster.register`（facts 追加），返回 memberId。
   */
  async enroll(hiveId: HiveId, input: EnrollInput, host = collectHostEnvironment()): Promise<EnrollResult> {
    const agent = await this.check(input.agentId, host)
    if (!agent.discovered) {
      return {
        agent,
        memberId: null,
        enrolled: false,
        // (报错靠 throw 仍在 runAt 语义内)
      }
    }
    if (!agent.available) {
      throw new Error(
        `discovery.enroll: agent '${input.agentId}' not available (L2 未通过) — ` +
          (agent.error ?? 'unknown'),
      )
    }

    // 幂等：已 enroll 则直接返回既有 memberId。
    const existing = this.enrolled.get(input.agentId)
    if (existing) {
      return { agent, memberId: existing.memberId, enrolled: true }
    }

    const regInput: RegisterMemberInput = {
      name: input.name ?? agent.displayName,
      role: input.role ?? 'worker',
      backend: agent.backend as string,
      connectorId: agent.id,
      model: input.model,
    }
    const member = await this.roster.register(hiveId, regInput)
    this.enrolled.set(input.agentId, { memberId: member.id, hiveId })
    this.ctx.emit('discovery/enrolled', input.agentId, member.id, hiveId)
    return { agent, memberId: member.id, enrolled: true }
  }

  /** 关闭：清空快照与反查表（cordis 会在 context 释放时自动调 stop）。 */
  async stop(): Promise<void> {
    this.snapshot.clear()
    this.enrolled.clear()
  }

  #pathSource(host: HostEnvironment): 'shell' | 'app-env' | 'fallback' {
    // PATH 溯源：能区分就来处，否则默认 app-env（详见 discovery/env.ts PathSource）。
    const p = host.env?.PATH ?? ''
    if (/login|\/bin\/(zsh|bash)/.test(process.env.SHELL ?? '')) return 'shell'
    return p ? 'app-env' : 'fallback'
  }

  #reconcileEnrolled(): void {
    for (const agent of this.snapshot.values()) {
      const e = this.enrolled.get(agent.id)
      agent.enrolledMemberId = e ? e.memberId : agent.enrolledMemberId ?? null
    }
  }
}

/** Development helper typing reference (unused at runtime). */
export type { DiscoveryBackend }
