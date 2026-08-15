/**
 * LedgerService — 台账服务 (§5.2).
 *
 * 管理任务与依赖边。`blockedBy` / `blocks` 反向边只经 `task-dependency` 单一
 * 写路径维护（§5.2 注），派生查询（`runnable`）不落库。
 *
 * 迁移到真实 cordis：工厂函数 → `Service` 子类（`super(ctx, 'ledger')`）。
 *
 * @module @whalepod/honeycomb/services/ledger
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { makeId, now } from '../util'
import type { FactStore } from '../persistence/store'
import type { CreateTaskInput, HiveId, MemberId, Task, TaskFilter, TaskId, TaskPatch } from '../types'

export interface LedgerService {
  create(hiveId: HiveId, input: CreateTaskInput): Promise<Task>
  get(id: TaskId): Promise<Task | undefined>
  update(id: TaskId, patch: TaskPatch): Promise<Task>
  addDependency(taskId: TaskId, blockedBy: TaskId): Promise<void>
  removeDependency(taskId: TaskId, blockedBy: TaskId): Promise<void>
  setOwner(taskId: TaskId, owner: MemberId | null): Promise<void>
  list(hiveId: HiveId, filter?: TaskFilter): Promise<Task[]>
}

function changeOf(patch: TaskPatch): 'status' | 'owner' | 'description' {
  if ('status' in patch) return 'status'
  if ('owner' in patch) return 'owner'
  return 'description'
}

export class HoneycombLedgerService extends Service implements LedgerService {
  constructor(ctx: Context, private readonly store: FactStore) {
    super(ctx, 'ledger')
  }

  async create(hiveId: HiveId, input: CreateTaskInput): Promise<Task> {
    const ts = now()
    const task: Task = {
      id: makeId('task'),
      hiveId,
      subject: input.subject,
      description: input.description,
      status: 'backlog',
      owner: input.owner,
      blockedBy: [],
      blocks: [],
      createdAt: ts,
      updatedAt: ts,
    }
    await this.store.append(hiveId, { type: 'task-created', task, at: ts })
    for (const blocker of input.blockedBy ?? []) {
      await this.store.append(hiveId, {
        type: 'task-dependency',
        taskId: task.id,
        blockedBy: blocker,
        op: 'add',
        at: now(),
      })
    }
    const created = this.store.task(task.id) ?? task
    this.ctx.emit('task/created', { task: created })
    return created
  }

  async get(id: TaskId): Promise<Task | undefined> {
    return this.store.task(id)
  }

  async update(id: TaskId, patch: TaskPatch): Promise<Task> {
    const existing = this.store.task(id)
    if (!existing) throw new Error(`task not found: ${id}`)
    await this.store.append(existing.hiveId, {
      type: 'task-updated',
      taskId: id,
      patch,
      at: now(),
    })
    const updated = this.store.task(id) ?? existing
    this.ctx.emit('task/updated', { task: updated, change: changeOf(patch) })
    return updated
  }

  async addDependency(taskId: TaskId, blockedBy: TaskId): Promise<void> {
    const task = this.store.task(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    await this.store.append(task.hiveId, {
      type: 'task-dependency',
      taskId,
      blockedBy,
      op: 'add',
      at: now(),
    })
    this.ctx.emit('task/updated', { task: this.store.task(taskId) ?? task, change: 'dependency' })
  }

  async removeDependency(taskId: TaskId, blockedBy: TaskId): Promise<void> {
    const task = this.store.task(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    await this.store.append(task.hiveId, {
      type: 'task-dependency',
      taskId,
      blockedBy,
      op: 'remove',
      at: now(),
    })
    this.ctx.emit('task/updated', { task: this.store.task(taskId) ?? task, change: 'dependency' })
  }

  async setOwner(taskId: TaskId, owner: MemberId | null): Promise<void> {
    const task = this.store.task(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    await this.store.append(task.hiveId, {
      type: 'task-updated',
      taskId,
      patch: { owner: owner ?? undefined },
      at: now(),
    })
    this.ctx.emit('task/updated', { task: this.store.task(taskId) ?? task, change: 'owner' })
  }

  async list(hiveId: HiveId, filter?: TaskFilter): Promise<Task[]> {
    let tasks = this.store.tasksOf(hiveId)
    if (filter?.status !== undefined) {
      const wanted = Array.isArray(filter.status) ? filter.status : [filter.status]
      tasks = tasks.filter((task) => wanted.includes(task.status))
    }
    if (filter?.owner !== undefined) tasks = tasks.filter((task) => task.owner === filter.owner)
    if (filter?.runnable) {
      tasks = tasks.filter((task) =>
        task.blockedBy.every((blocker) => this.store.task(blocker)?.status === 'completed'),
      )
    }
    if (filter?.limit !== undefined) tasks = tasks.slice(0, filter.limit)
    return tasks
  }
}
