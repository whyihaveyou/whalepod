/**
 * Honeycomb plugin 装配入口（§5.5）.
 *
 * `apply(ctx, config)` 装配 5 个服务（hive / ledger / courier / mandate /
 * roster）+ 持久化 + 运行时注册表。原生 `native` 后端在此注册；外部 CLI
 * connector 后端由连接器层通过 `ctx.roster.registerRuntime(...)` 注册。
 *
 * 注：文档 §0/§13 写「6 个服务」，但 §5/§6 只定义了 5 个。第 6 个候选是
 * `MemberRuntime` 命名注册表（§6.2），本实现按 §6.2 以 `ctx.roster
 * .registerRuntime(...)` 暴露，而非独立顶层服务 —— 详见 README 交付说明。
 *
 * @module @dfh/honeycomb/plugin
 */

import type { Context } from './framework'
import { resolveHoneycombConfig, type HoneycombConfig, type ResolvedHoneycombConfig } from './config'
import { FactStore, type FactBackend } from './persistence/store'
import { JsonlFactBackend } from './persistence/jsonl'
import { RuntimeRegistry } from './runtime/registry'
import { createNativeRuntime } from './runtime/native-runtime'
import { createRosterService } from './services/roster'
import { createHiveService } from './services/hive'
import { createLedgerService } from './services/ledger'
import { createCourierService } from './services/courier'
import { createMandateService } from './services/mandate'
import { createNodeTransportServer } from './transport/server'

export const name = 'honeycomb'

export async function apply(ctx: Context, config?: HoneycombConfig): Promise<void> {
  const resolved = resolveHoneycombConfig(config)

  // persistence (§9): 默认 jsonl 后端写磁盘（~/.dfh/hive/<hiveId>/facts.ndjson），
  // 启动即重放日志重建派生快照；sqlite 尚未实现，回退用内存后端保持行为。
  const store = new FactStore(buildFactBackend(resolved))
  // 启动重放：从磁盘重建快照；损坏行由后端跳过并告警，绝不中断启动。
  await store.load()

  // runtime registry (§6.2): native 后端恒注册；connector 后端后续注册。
  const runtimes = new RuntimeRegistry()
  runtimes.register(createNativeRuntime(ctx))

  // services (§5.5)
  const roster = createRosterService(ctx, { store, runtimes })
  const hive = createHiveService(ctx, { store, roster, config: resolved })
  const ledger = createLedgerService(ctx, { store })
  const courier = createCourierService(ctx, { store })
  const mandate = createMandateService(ctx, { store, config: resolved })

  ctx.provide('hive', hive)
  ctx.provide('ledger', ledger)
  ctx.provide('courier', courier)
  ctx.provide('mandate', mandate)
  ctx.provide('roster', roster)

  // 可选 transport 网络服务（§transport）：config.transport.enabled = true 时
  // 在 127.0.0.1 起真实 HTTP+WS 监听，前端可直接连接。
  if (resolved.transport.enabled) {
    await startTransportServer(ctx, resolved)
  }
}

/**
 * 启动真实 transport server 并绑定到 ctx 生命周期（ctx.dispose() 时自动 close）。
 * 失败仅告警不中断（核心服务已就绪；接入端可在之后手动调用 createNodeTransportServer）。
 */
async function startTransportServer(ctx: Context, resolved: ResolvedHoneycombConfig): Promise<void> {
  try {
    const server = await createNodeTransportServer(ctx, {
      host: resolved.transport.host,
      port: resolved.transport.port,
    })
    ctx.onDispose(() => {
      void server.close().catch(() => {})
    })
    console.log(
      `[honeycomb] transport listening on http://${server.host}:${server.port} (WS: /ws)`,
    )
  } catch (error) {
    console.warn('[honeycomb] transport server failed to start:', error)
  }
}

/** Pick the fact-log backend for a resolved config. */
function buildFactBackend(resolved: ResolvedHoneycombConfig): FactBackend {
  if (resolved.persistence === 'sqlite') {
    // §9.3: sqlite 后端尚未实现 —— 暂回退到内存后端 + 告警，保证不破坏现有行为。
    console.warn('[honeycomb] persistence=sqlite 尚未实现，回退到 jsonl 落盘后端')
    return new JsonlFactBackend({ dir: resolved.persistenceDir })
  }
  return new JsonlFactBackend({ dir: resolved.persistenceDir })
}
