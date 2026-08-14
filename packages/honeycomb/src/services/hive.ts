/**
 * HiveService — 团队服务 (§5.1).
 *
 * 管理 Hive 生命周期（创建/重命名/模式/移除）。`create` 同时孵化首任 queen
 * （委托 RosterService）。
 *
 * @module @dfh/honeycomb/services/hive
 */

import type { Context } from '../framework'
import { makeId, now } from '../framework'
import type { ResolvedHoneycombConfig } from '../config'
import type { FactStore } from '../persistence/store'
import type { CreateHiveInput, HatchMemberInput, Hive, HiveId, HiveWorkspaceMode } from '../types'
import type { RosterService } from './roster'

export interface HiveService {
  create(input: CreateHiveInput): Promise<Hive>
  list(): Promise<Hive[]>
  get(id: HiveId): Promise<Hive | undefined>
  rename(id: HiveId, name: string): Promise<void>
  setMode(id: HiveId, mode: HiveWorkspaceMode): Promise<void>
  setSessionMode(id: HiveId, mode: string): Promise<void>
  remove(id: HiveId): Promise<void>
}

export interface HiveServiceDeps {
  store: FactStore
  roster: RosterService
  config: ResolvedHoneycombConfig
}

export function createHiveService(ctx: Context, deps: HiveServiceDeps): HiveService {
  const { store, roster, config } = deps

  return {
    async create(input) {
      const hiveId = makeId('hive')
      const queenInput: HatchMemberInput = input.queen ?? { name: 'queen', role: 'queen', backend: 'native' }
      // 孵化首任 queen（此时 hive 尚未落库，显式传 cwd）
      const queen = await roster.hatch(hiveId, { ...queenInput, role: 'queen', cwd: queenInput.cwd ?? input.workspace })

      const ts = now()
      const hive: Hive = {
        id: hiveId,
        name: input.name,
        workspace: input.workspace,
        workspaceMode: input.workspaceMode ?? config.defaultWorkspaceMode,
        queenId: queen.id,
        sessionMode: input.sessionMode,
        createdAt: ts,
        updatedAt: ts,
      }
      await store.append(hiveId, { type: 'hive-created', hive })
      ctx.emit('hive/created', { hive })
      return hive
    },

    async list() {
      return store.hives()
    },

    async get(id) {
      return store.hive(id)
    },

    async rename(id, name) {
      if (!store.hive(id)) throw new Error(`hive not found: ${id}`)
      await store.append(id, { type: 'hive-renamed', hiveId: id, name, at: now() })
      ctx.emit('hive/renamed', { hiveId: id, name })
    },

    async setMode(id, mode) {
      if (!store.hive(id)) throw new Error(`hive not found: ${id}`)
      await store.append(id, { type: 'hive-updated', hiveId: id, patch: { workspaceMode: mode }, at: now() })
    },

    async setSessionMode(id, mode) {
      if (!store.hive(id)) throw new Error(`hive not found: ${id}`)
      await store.append(id, { type: 'hive-updated', hiveId: id, patch: { sessionMode: mode }, at: now() })
    },

    async remove(id) {
      await store.append(id, { type: 'hive-removed', hiveId: id, at: now() })
      ctx.emit('hive/removed', { hiveId: id })
    },
  }
}
