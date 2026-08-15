/**
 * @whalepod/honeycomb public entry.
 *
 * Importing this module pulls in the `Events` / `Context` augmentations
 * (`events.ts`, `context.ts`) so `ctx.hive`, `ctx.emit('hive/created', ...)`
 * etc. type-check for consumers.
 *
 * @module @whalepod/honeycomb
 */

import './context'

// 真实 cordis Context（构造即可得独立根上下文）。framework.ts shim 已迁移删除。
export { Context, Service } from '@deepseek-ai/cordis'
export * from './types'
export * from './config'
export * from './events'
export * from './persistence/facts'
export * from './persistence/store'
export * from './persistence/jsonl'
export * from './services/hive'
export * from './services/ledger'
export * from './services/courier'
export * from './services/mandate'
export * from './services/roster'
export * from './runtime/registry'
export * from './runtime/native-runtime'
export * from './runtime/fiber'
export * from './transport'
export * from './plugin'
export * from './consumer/orchestration-loop'
