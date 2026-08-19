/**
 * Discovery probe chain executor (L1 presence scan).
 *
 * A3 第一件落地件：探测链执行器的 L1 段 —— PATH 扫描 + --version 廉价探测。
 *
 * 分层契约（types.ts 状态模型对齐）：
 *   - L1（本文件）：discover.list/discover.refresh 默认只跑的廉价段。
 *       * 按 catalog 条目对 PATH 做二进制解析（可注入 resolveBinary）。
 *       * 命中后跑 `--version`（短超时、同步、stdout 首行），
 *         产出 binPath + version + discovered=true + status='online'（approximation）。
 *       * 未命中产出 status='missing'、discovered=false。
 *   - L2（由 registry 惰性触发，不在本文件）：ACP 握手 / serverInfo 校验，
 *     把 status 从 approximation 落成真实 'online'/'offline'。
 *       铁律①分离：L1 只证明 presence（discovered），available 必须 L2 握手后才 true。
 *
 * 短名碰撞防护（A2 §1.5）：
 *   两个 catalog entry 可能解析到同一条二进制（如 `kimi` 同时被 kimi-code
 *   与 acp 条目认领，`opencode` 也类似）。本文件以「PATH 全扫描 + 判定表」做
 *   去重：同一二进制路径只产生一条主 entry，其余按 family 归并或标记 collision。
 *   判定表策略见 {@link resolveCollisions}。
 *
 * @module @dfh/honeycomb/connectors/discovery
 */

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import type { HostEnvironment } from '../types.ts'
import type { DiscoveryAgent, DiscoveryBackend } from './types.ts'
import type { PathSource } from './env.ts'
import { collectHostEnvironment, resolveBinary } from '../detect/host-env.ts'

/** catalog 单条探测规格（对齐 DetectSpec 的 L1 子集 + backend）。 */
export interface ProbeCatalogEntry {
  /** 稳定 connector id（同 Agent 多次探测恒定）。 */
  id: string
  /** 显示名。 */
  displayName: string
  /** 家族标签，如 'claude-code' | 'gemini-cli' | 'codex'。 */
  kind: string
  /** 后端形态。 */
  backend: DiscoveryBackend
  /** PATH 上要解析的二进制名。 */
  binaryName: string
  /** --version 探测 argv（缺省 ['--version']）。 */
  versionArgs?: string[]
  /** 该 entry 是否 L1 就能确认可用（false = 必须 L2 握手）。 */
  l1Available?: boolean
}

/**
 * 内置探测 catalog —— discovery 层自持的最小集合。
 * 与 adapters 目录的二进制名对齐（claude/codex/opencode/kimi/gemini/hermes）。
 */
export const DISCOVERY_CATALOG: ProbeCatalogEntry[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    kind: 'claude-code',
    backend: 'stdio',
    binaryName: 'claude',
    versionArgs: ['--version'],
    l1Available: false,
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex',
    kind: 'codex',
    backend: 'acp',
    binaryName: 'codex',
    versionArgs: ['--version'],
    l1Available: false,
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    kind: 'opencode',
    backend: 'acp',
    binaryName: 'opencode',
    versionArgs: ['--version'],
    l1Available: false,
  },
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    kind: 'gemini-cli',
    backend: 'acp',
    binaryName: 'gemini',
    versionArgs: ['--version'],
    l1Available: false,
  },
  {
    id: 'kimi-code',
    displayName: 'Kimi CLI',
    kind: 'kimi-code',
    backend: 'acp',
    binaryName: 'kimi',
    versionArgs: ['--version'],
    l1Available: false,
  },
  {
    id: 'hermes',
    displayName: 'Hermes',
    kind: 'hermes',
    backend: 'stdio',
    binaryName: 'hermes',
    versionArgs: ['--version'],
    l1Available: false,
  },
]

/** 同一条二进制路径的判定：为主 entry 或碰撞标注。 */
export interface PathClaim {
  /** 实际解析到的二进制绝对路径。 */
  binPath: string
  /** 主认领 entry id（该路径的「正主」）。 */
  primaryId: string
  /** 认领同一路径的其他 entry id（碰撞方，由 primary 占位）。 */
  collideIds: string[]
}

/** --version 探测 runner（可注入测试）。 */
export type RunVersionFn = (
  binPath: string,
  args: string[],
) => { ok: boolean; output?: string }

/** L1 探测依赖（可注入）。 */
export interface ProbeOptions {
  resolveBinary?: typeof resolveBinary
  runVersion?: RunVersionFn
}

/** 默认 --version 探测：同步 spawn，短超时，取 stdout 首行。 */
function defaultRunVersion(binPath: string, args: string[]): { ok: boolean; output?: string } {
  try {
    const res = spawnSync(binPath, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (res.error) return { ok: false }
    const output = (res.stdout ?? '').trim()
    return { ok: res.status === 0, output: output || undefined }
  } catch {
    return { ok: false }
  }
}

/**
 * PATH 全扫描：为 catalog 里每个 entry 解析二进制路径。
 * 返回「路径 → 认领集合」的 Map，供碰撞判定使用。
 */
export function scanPathClaims(
  catalog: ProbeCatalogEntry[],
  host: HostEnvironment,
  resolveBin: typeof resolveBinary = resolveBinary,
): Map<string, PathClaim> {
  const claims = new Map<string, PathClaim>()
  for (const entry of catalog) {
    const binPath = resolveBin(entry.binaryName, host)
    if (!binPath) continue
    const existing = claims.get(binPath)
    if (existing) {
      existing.collideIds.push(entry.id)
      // 主 entry 保持首次声明的 id（确定性），碰撞方归并。
      continue
    }
    claims.set(binPath, {
      binPath,
      primaryId: entry.id,
      collideIds: [],
    })
  }
  return claims
}

/**
 * 为单个 entry 做 L1 探测。
 *
 * @param entry - catalog 条目。
 * @param host - 宿主环境快照。
 * @param opts - 可注入依赖。
 * @param pathSource - PATH 溯源（来自 buildProbeEnv）。
 * @param now - 时间戳（测试可注入）。
 * @returns DiscoveryAgent L1 段结果（available 一律 false，待 L2）。
 */
export function probeL1(
  entry: ProbeCatalogEntry,
  host: HostEnvironment,
  opts: ProbeOptions = {},
  pathSource: PathSource = 'app-env',
  now: number = Date.now(),
): DiscoveryAgent {
  const resolveBin = opts.resolveBinary ?? resolveBinary
  const runVersion = opts.runVersion ?? defaultRunVersion

  const binPath = resolveBin(entry.binaryName, host)
  if (!binPath) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      kind: entry.kind,
      backend: entry.backend,
      discovered: false,
      available: false,
      status: 'missing',
      binPath: null,
      version: null,
      authHint: 'unknown',
      capabilities: [],
      pathSource,
      lastCheckAt: now,
      error: null,
    }
  }

  // 命中 → 跑 --version（廉价确认二进制真实存在）。
  const args = entry.versionArgs ?? ['--version']
  const vres = runVersion(binPath, args)
  const version = vres.ok && vres.output ? vres.output.split('\n')[0] : null

  return {
    id: entry.id,
    displayName: entry.displayName,
    kind: entry.kind,
    backend: entry.backend,
    // 铁律①：L1 只证明 presence，available 必须 L2 握手后才 true。
    discovered: true,
    available: false,
    // L1 近似 online：二进制存在且 --version 通过 = 可启动候选。
    status: 'online',
    binPath,
    version,
    authHint: 'unknown',
    capabilities: [],
    pathSource,
    lastCheckAt: now,
    error: vres.ok ? null : 'version probe failed',
  }
}

/**
 * 对 catalog 全量执行 L1 探测（discover.list 的廉价路径）。
 *
 * 碰撞防护：重复二进制让主 entry 认领（保留其探测结果），碰撞方 entry
 * 标记 status='missing'、error_code='collision'、guidance 指向主 entry。
 *
 * @param catalog - 探测 catalog（缺省内置 DISCOVERY_CATALOG）。
 * @param host - 宿主环境（缺省 collectHostEnvironment()）。
 * @param opts - 可注入依赖。
 * @param pathSource - PATH 溯源。
 * @returns 全部 catalog 条目的 L1 结果。
 */
export function probeAllL1(
  catalog: ProbeCatalogEntry[] = DISCOVERY_CATALOG,
  host: HostEnvironment = collectHostEnvironment(),
  opts: ProbeOptions = {},
  pathSource: PathSource = 'app-env',
  now: number = Date.now(),
): DiscoveryAgent[] {
  const claims = scanPathClaims(catalog, host, opts.resolveBinary)
  const primaryByEntry = new Map<string, string>() // entryId -> primaryId

  for (const claim of claims.values()) {
    primaryByEntry.set(claim.primaryId, claim.primaryId)
    for (const cid of claim.collideIds) primaryByEntry.set(cid, claim.primaryId)
  }

  return catalog.map((entry) => {
    const primaryId = primaryByEntry.get(entry.id)
    if (primaryId !== undefined && primaryId !== entry.id) {
      // 碰撞方：二进制已被主 entry 认领，本 entry 标记 collision。
      const claim = [...claims.values()].find((c) => c.primaryId === primaryId)
      const base = probeL1(entry, host, opts, pathSource, now)
      return {
        ...base,
        discovered: false,
        available: false,
        status: 'missing',
        binPath: claim?.binPath ?? null,
        error_code: 'collision',
        guidance: `binPath 被 ${primaryId} 认领（短名碰撞），本条目跳过 L2。`,
        error: `collision: primary=${primaryId}`,
      }
    }
    return probeL1(entry, host, opts, pathSource, now)
  })
}
