/**
 * Context augmentation — merges the five honeycomb services (plus `agents`)
 * into the framework's `Context` interface, giving `ctx.hive` / `ctx.ledger` /
 * `ctx.courier` / `ctx.mandate` / `ctx.roster` / `ctx.agents` typed access
 * (same idiom as Cordis).
 *
 * @module @dfh/honeycomb/context
 */

import type { HiveService } from './services/hive'
import type { LedgerService } from './services/ledger'
import type { CourierService } from './services/courier'
import type { MandateService } from './services/mandate'
import type { RosterService } from './services/roster'
import type { AgentsRuntime } from './runtime/native-runtime'

declare module './framework' {
  interface Context {
    hive: HiveService
    ledger: LedgerService
    courier: CourierService
    mandate: MandateService
    roster: RosterService
    /** 原生 agent runtime（由 harness 装配；未装配时为 undefined）。 */
    agents?: AgentsRuntime
  }
}

export {}
