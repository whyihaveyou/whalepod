/**
 * Honeycomb configuration + StandardSchema (§10).
 *
 * The config is validated/normalised once at plugin apply time. The schema
 * object is a structural `StandardSchemaV1`-compatible value so it can be
 * swapped for a real schemastery/standard-schema instance at integration time.
 *
 * @module @whalepod/honeycomb/config
 */

import type { HiveWorkspaceMode } from './types'
import { defaultFactDir } from './persistence/jsonl'

export type PersistenceBackend = 'jsonl' | 'sqlite'

/** 可选 transport 网络服务（§transport）——真实 HTTP/WS 适配器。 */
export interface TransportServerOptions {
  /** 是否在插件 boot 后启动网络服务；默认 false。 */
  enabled?: boolean
  /** 监听 host；默认 127.0.0.1。 */
  host?: string
  /** 监听端口；0 = 随机可用端口（启动后经 handle.port 读取）。默认 8765。 */
  port?: number
}

/** User-facing config (all optional — defaults applied in `resolve`). */
export interface HoneycombConfig {
  defaultWorkspaceMode?: HiveWorkspaceMode
  /** 成员空闲超时（ms）；0 = 永不自动休眠。 */
  idleTimeoutMs?: number
  mandate?: {
    /** false = 忽略 mandate/decide waterfall 里的第三方覆盖，只用默认策略。 */
    allowOverrides?: boolean
  }
  /** 名册里预注册的成员运行时后端 id（原生后端恒为 `native`）。 */
  runtimes?: string[]
  persistence?: PersistenceBackend
  /** 追加只读事实日志的根目录（默认 `~/.dfh/hive`）；每个 hive 对应 `<dir>/<hiveId>/facts.ndjson`。 */
  persistenceDir?: string
  /** 真实网络 transport（HTTP+WS）开关与监听参数；缺省不启动。 */
  transport?: TransportServerOptions
  /**
   * 开箱自举（WhalePod OOB）：插件装配完成后若当前没有任何 hive，
   * 自动创建一个默认团队（hive.create 自带首任 queen 孵化）。
   * 解决 fresh 安装打开团队面板报「未找到 hive: hive-dev」的缺口——
   * 面板默认按 name='hive-dev' 解析、兜底 hives[0]，自举保证两者必中。
   * 缺省不开启（库消费方默认不应有业务数据副作用）。
   */
  bootstrap?: {
    /** 要创建的默认 hive 名；默认 'hive-dev'（与团队面板默认解析名对齐）。 */
    hiveName?: string
    /** 默认 hive 的 workspace 路径；缺省用进程 cwd。 */
    workspace?: string
  }
}

/** 默认 transport HTTP 端口（config + server 共享）。 */
export const DEFAULT_TRANSPORT_PORT = 8765
/** 默认 transport host。 */
export const DEFAULT_TRANSPORT_HOST = '127.0.0.1'

/** Fully-resolved config. */
export interface ResolvedHoneycombConfig {
  defaultWorkspaceMode: HiveWorkspaceMode
  idleTimeoutMs: number
  mandate: { allowOverrides: boolean }
  runtimes: string[]
  persistence: PersistenceBackend
  persistenceDir: string
  transport: {
    enabled: boolean
    host: string
    port: number
  }
  bootstrap: {
    hiveName: string
    workspace?: string
  } | undefined
}

export const DEFAULT_HONEYCOMB_CONFIG: ResolvedHoneycombConfig = {
  defaultWorkspaceMode: 'shared',
  idleTimeoutMs: 0,
  mandate: { allowOverrides: true },
  runtimes: ['native'],
  persistence: 'jsonl',
  persistenceDir: '',
  transport: { enabled: false, host: DEFAULT_TRANSPORT_HOST, port: DEFAULT_TRANSPORT_PORT },
  bootstrap: undefined,
}

/** Default persistence directory, resolved lazily so it is stable per process. */
export function defaultPersistenceDir(): string {
  return defaultFactDir()
}

/** Normalise + validate raw config, throwing on invalid values. */
export function resolveHoneycombConfig(input?: HoneycombConfig): ResolvedHoneycombConfig {
  const value = input ?? {}

  if (
    value.defaultWorkspaceMode !== undefined &&
    value.defaultWorkspaceMode !== 'shared' &&
    value.defaultWorkspaceMode !== 'isolated'
  ) {
    throw new TypeError(`invalid defaultWorkspaceMode: ${String(value.defaultWorkspaceMode)}`)
  }
  if (value.idleTimeoutMs !== undefined && (typeof value.idleTimeoutMs !== 'number' || value.idleTimeoutMs < 0)) {
    throw new TypeError('idleTimeoutMs must be a non-negative number')
  }
  if (value.persistence !== undefined && value.persistence !== 'jsonl' && value.persistence !== 'sqlite') {
    throw new TypeError(`invalid persistence: ${String(value.persistence)}`)
  }

  return {
    defaultWorkspaceMode: value.defaultWorkspaceMode ?? DEFAULT_HONEYCOMB_CONFIG.defaultWorkspaceMode,
    idleTimeoutMs: value.idleTimeoutMs ?? DEFAULT_HONEYCOMB_CONFIG.idleTimeoutMs,
    mandate: { allowOverrides: value.mandate?.allowOverrides ?? DEFAULT_HONEYCOMB_CONFIG.mandate.allowOverrides },
    runtimes: value.runtimes ?? DEFAULT_HONEYCOMB_CONFIG.runtimes,
    persistence: value.persistence ?? DEFAULT_HONEYCOMB_CONFIG.persistence,
    persistenceDir: value.persistenceDir ?? defaultPersistenceDir(),
    transport: {
      enabled: value.transport?.enabled ?? DEFAULT_HONEYCOMB_CONFIG.transport.enabled,
      host: value.transport?.host ?? DEFAULT_HONEYCOMB_CONFIG.transport.host,
      port: value.transport?.port ?? DEFAULT_HONEYCOMB_CONFIG.transport.port,
    },
    bootstrap:
      value.bootstrap === undefined
        ? undefined
        : {
            hiveName: value.bootstrap.hiveName ?? 'hive-dev',
            ...(value.bootstrap.workspace !== undefined ? { workspace: value.bootstrap.workspace } : {}),
          },
  }
}

// -- StandardSchema-compatible surface (§10) --------------------------------

/** Structural subset of the Standard Schema v1 interface. */
export interface StandardSchemaV1<Output = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    validate(value: unknown): StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>
  }
}

export namespace StandardSchemaV1 {
  export type Result<Output> = { readonly value: Output } | { readonly issues: readonly Issue[] }
  export interface Issue {
    readonly message: string
    readonly path?: readonly (string | number)[]
  }
}

/** StandardSchema-compatible validator for {@link HoneycombConfig}. */
export const HoneycombConfigSchema: StandardSchemaV1<ResolvedHoneycombConfig> = {
  '~standard': {
    version: 1,
    vendor: '@whalepod/honeycomb',
    validate(value) {
      try {
        return { value: resolveHoneycombConfig(value as HoneycombConfig | undefined) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
}
