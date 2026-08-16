/**
 * Context augmentation — merges the five honeycomb services (plus `agents`)
 * into cordis's `Context` interface, giving `ctx.hive` / `ctx.ledger` /
 * `ctx.courier` / `ctx.mandate` / `ctx.roster` / `ctx.agents` typed access.
 *
 * On the cordis migration the `declare module` target moved from the legacy
 * `./framework` shim to the real `@deepseek-ai/cordis` package.
 *
 * @module @whalepod/honeycomb/context
 */

import type { HiveService } from './services/hive'
import type { LedgerService } from './services/ledger'
import type { CourierService } from './services/courier'
import type { MandateService } from './services/mandate'
import type { RosterService } from './services/roster'
import type { DshAgentsRegistry } from './runtime/native-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hive: HiveService
    ledger: LedgerService
    courier: CourierService
    mandate: MandateService
    roster: RosterService
    /** 原生 agent runtime（由 harness 装配；未装配时为 undefined）。 */
    agents?: DshAgentsRegistry
  }
}

export {}
