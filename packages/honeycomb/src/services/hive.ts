/**
 * HiveService — 团队服务 (§5.1).
 *
 * 管理 Hive 生命周期（创建/重命名/模式/移除）。`create` 同时孵化首任 queen
 * （委托 RosterService）。
 *
 * 迁移到真实 cordis：工厂函数 → `Service` 子类（`super(ctx, 'hive')` 注册
 * `ctx.hive`），公开接口与行为不变。
 *
 * @module @dfh/honeycomb/services/hive
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { makeId, now } from '../util'
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

export class HoneycombHiveService extends Service implements HiveService {
  constructor(
    ctx: Context,
    private readonly store: FactStore,
    private readonly roster: RosterService,
    private readonly config: ResolvedHoneycombConfig,
  ) {
    super(ctx, 'hive')
  }

  async create(input: CreateHiveInput): Promise<Hive> {
    const hiveId = makeId('hive')
    const queenInput: HatchMemberInput =
      input.queen ?? { name: 'queen', role: 'queen', backend: 'native' }
    // 孵化首任 queen（此时 hive 尚未落库，显式传 cwd）
    const queen = await this.roster.hatch(hiveId, {
      ...queenInput,
      role: 'queen',
      cwd: queenInput.cwd ?? input.workspace,
    })

    const ts = now()
    const hive: Hive = {
      id: hiveId,
      name: input.name,
      workspace: input.workspace,
      workspaceMode: input.workspaceMode ?? this.config.defaultWorkspaceMode,
      queenId: queen.id,
      sessionMode: input.sessionMode,
      createdAt: ts,
      updatedAt: ts,
    }
    await this.store.append(hiveId, { type: 'hive-created', hive })
    this.ctx.emit('hive/created', { hive })
    return hive
  }

  async list(): Promise<Hive[]> {
    return this.store.hives()
  }

  async get(id: HiveId): Promise<Hive | undefined> {
    return this.store.hive(id)
  }

  async rename(id: HiveId, name: string): Promise<void> {
    if (!this.store.hive(id)) throw new Error(`hive not found: ${id}`)
    await this.store.append(id, { type: 'hive-renamed', hiveId: id, name, at: now() })
    this.ctx.emit('hive/renamed', { hiveId: id, name })
  }

  async setMode(id: HiveId, mode: HiveWorkspaceMode): Promise<void> {
    if (!this.store.hive(id)) throw new Error(`hive not found: ${id}`)
    await this.store.append(id, {
      type: 'hive-updated',
      hiveId: id,
      patch: { workspaceMode: mode },
      at: now(),
    })
  }

  async setSessionMode(id: HiveId, mode: string): Promise<void> {
    if (!this.store.hive(id)) throw new Error(`hive not found: ${id}`)
    await this.store.append(id, {
      type: 'hive-updated',
      hiveId: id,
      patch: { sessionMode: mode },
      at: now(),
    })
  }

  async remove(id: HiveId): Promise<void> {
    await this.store.append(id, { type: 'hive-removed', hiveId: id, at: now() })
    this.ctx.emit('hive/removed', { hiveId: id })
  }
}
