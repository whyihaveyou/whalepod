/**
 * Honeycomb plugin 装配入口（§5.5）.
 *
 * `apply(ctx, config)` 装配 5 个服务（hive / ledger / courier / mandate /
 * roster）+ 持久化 + 运行时注册表。原生 `native` 后端在此注册；外部 CLI
 * connector 后端由连接器层通过 `ctx.roster.registerRuntime(...)` 注册。
 *
 * 迁移到真实 cordis：5 个服务改为 `Service` 子类，`super(ctx, name)`
 * 自动注册 `ctx.hive` / `ctx.ledger` / `ctx.courier` / `ctx.mandate` /
 * `ctx.roster`；装配点构造它们即可（不再手动 `ctx.provide`）。定时器/订阅
 * 统一走 `ctx.effect`（含 transport 的 dispose）。
 *
 * @module @whalepod/honeycomb/plugin
 */

import { type Context } from '@deepseek-ai/cordis'
import { resolveHoneycombConfig, type HoneycombConfig, type ResolvedHoneycombConfig } from './config'
import { FactStore, type FactBackend } from './persistence/store'
import { JsonlFactBackend } from './persistence/jsonl'
import { RuntimeRegistry } from './runtime/registry'
import { createNativeRuntime } from './runtime/native-runtime'
import { HoneycombRosterService } from './services/roster'
import { HoneycombHiveService } from './services/hive'
import { HoneycombLedgerService } from './services/ledger'
import { HoneycombCourierService } from './services/courier'
import { HoneycombMandateService } from './services/mandate'
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
  runtimes.register(createNativeRuntime())

  // services (§5.5) —— Service 子类构造即自注册到 ctx。
  const roster = new HoneycombRosterService(ctx, store, runtimes)
  const hive = new HoneycombHiveService(ctx, store, roster, resolved)
  const ledger = new HoneycombLedgerService(ctx, store)
  const courier = new HoneycombCourierService(ctx, store)
  const mandate = new HoneycombMandateService(ctx, store, resolved)

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
    // 迁移：ctx.onDispose(...) → ctx.effect(() => () => ...)
    ctx.effect(
      () => () => {
        void server.close().catch(() => {})
      },
      '@whalepod/honeycomb/transport.dispose',
    )
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
