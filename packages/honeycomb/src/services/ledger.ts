/**
 * LedgerService — 台账服务 (§5.2).
 *
 * 管理任务与依赖边。`blockedBy` / `blocks` 反向边只经 `task-dependency` 单一
 * 写路径维护（§5.2 注），派生查询（`runnable`）不落库。
 *
 * @module @dfh/honeycomb/services/ledger
 */

import type { Context } from '../framework'
import { makeId, now } from '../framework'
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

export function createLedgerService(ctx: Context, deps: { store: FactStore }): LedgerService {
  const { store } = deps

  return {
    async create(hiveId, input) {
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
      await store.append(hiveId, { type: 'task-created', task, at: ts })
      for (const blocker of input.blockedBy ?? []) {
        await store.append(hiveId, {
          type: 'task-dependency',
          taskId: task.id,
          blockedBy: blocker,
          op: 'add',
          at: now(),
        })
      }
      const created = store.task(task.id) ?? task
      ctx.emit('task/created', { task: created })
      return created
    },

    async get(id) {
      return store.task(id)
    },

    async update(id, patch) {
      const existing = store.task(id)
      if (!existing) throw new Error(`task not found: ${id}`)
      await store.append(existing.hiveId, { type: 'task-updated', taskId: id, patch, at: now() })
      const updated = store.task(id) ?? existing
      ctx.emit('task/updated', { task: updated, change: changeOf(patch) })
      return updated
    },

    async addDependency(taskId, blockedBy) {
      const task = store.task(taskId)
      if (!task) throw new Error(`task not found: ${taskId}`)
      await store.append(task.hiveId, { type: 'task-dependency', taskId, blockedBy, op: 'add', at: now() })
      ctx.emit('task/updated', { task: store.task(taskId) ?? task, change: 'dependency' })
    },

    async removeDependency(taskId, blockedBy) {
      const task = store.task(taskId)
      if (!task) throw new Error(`task not found: ${taskId}`)
      await store.append(task.hiveId, { type: 'task-dependency', taskId, blockedBy, op: 'remove', at: now() })
      ctx.emit('task/updated', { task: store.task(taskId) ?? task, change: 'dependency' })
    },

    async setOwner(taskId, owner) {
      const task = store.task(taskId)
      if (!task) throw new Error(`task not found: ${taskId}`)
      await store.append(task.hiveId, {
        type: 'task-updated',
        taskId,
        patch: { owner: owner ?? undefined },
        at: now(),
      })
      ctx.emit('task/updated', { task: store.task(taskId) ?? task, change: 'owner' })
    },

    async list(hiveId, filter) {
      let tasks = store.tasksOf(hiveId)
      if (filter?.status !== undefined) {
        const wanted = Array.isArray(filter.status) ? filter.status : [filter.status]
        tasks = tasks.filter((task) => wanted.includes(task.status))
      }
      if (filter?.owner !== undefined) tasks = tasks.filter((task) => task.owner === filter.owner)
      if (filter?.runnable) {
        tasks = tasks.filter((task) => task.blockedBy.every((blocker) => store.task(blocker)?.status === 'completed'))
      }
      if (filter?.limit !== undefined) tasks = tasks.slice(0, filter.limit)
      return tasks
    },
  }
}
