/**
 * router — 把 5 个 service 的方法绑定到 REST 端点（docs/honeycomb-transport-api.md §3）.
 *
 * 本文件是「端点 → 服务方法」的完整翻译层。每个 `registerXxxRoutes(t)` 把某个
 * service 的全部可暴露方法映射成 `GET/POST/PATCH/DELETE` 路由，并注册到
 * `HoneycombTransport`。不实现任何业务逻辑，只做参数搬运与结果包装。
 *
 * @module @dfh/honeycomb/transport
 */

import type { HoneycombTransport } from './port'
import type { HttpRequest, HttpResponse } from './types'
import { fail, ok } from './types'

// ---------------------------------------------------------------------------
// hive — 团队服务（→ HiveService）
// ---------------------------------------------------------------------------

export function registerHiveRoutes(t: HoneycombTransport): void {
  const hive = () => t.services.hive

  t.registerRoute('GET', '/v1/hives', async () => ok(await hive().list()))
  t.registerRoute('GET', '/v1/hives/{id}', async (req) => {
    const id = t.pathParams(req, '/v1/hives/{id}').id
    const h = await hive().get(id)
    return h ? ok(h) : fail('NOT_FOUND', `hive not found: ${id}`, 404)
  })
  t.registerRoute('POST', '/v1/hives', async (req) => {
    const input = req.body
    if (!input || typeof input.name !== 'string') return fail('BAD_REQUEST', 'CreateHiveInput requires name')
    return ok(await hive().create(input))
  })
  t.registerRoute('PATCH', '/v1/hives/{id}/name', async (req) => {
    const id = t.pathParams(req, '/v1/hives/{id}/name').id
    if (typeof req.body?.name !== 'string') return fail('BAD_REQUEST', 'name required')
    await hive().rename(id, req.body.name)
    return ok(true)
  })
  t.registerRoute('PATCH', '/v1/hives/{id}/mode', async (req) => {
    const id = t.pathParams(req, '/v1/hives/{id}/mode').id
    if (!req.body?.mode) return fail('BAD_REQUEST', 'mode required')
    await hive().setMode(id, req.body.mode)
    return ok(true)
  })
  t.registerRoute('PATCH', '/v1/hives/{id}/session-mode', async (req) => {
    const id = t.pathParams(req, '/v1/hives/{id}/session-mode').id
    if (typeof req.body?.sessionMode !== 'string') return fail('BAD_REQUEST', 'sessionMode required')
    await hive().setSessionMode(id, req.body.sessionMode)
    return ok(true)
  })
  t.registerRoute('DELETE', '/v1/hives/{id}', async (req) => {
    const id = t.pathParams(req, '/v1/hives/{id}').id
    await hive().remove(id)
    return ok(true)
  })
}

// ---------------------------------------------------------------------------
// roster — 名册 / 生命周期（→ RosterService）
// ---------------------------------------------------------------------------

export function registerRosterRoutes(t: HoneycombTransport): void {
  const roster = () => t.services.roster

  t.registerRoute('GET', '/v1/hives/{hiveId}/members', async (req) => {
    const { hiveId } = t.pathParams(req, '/v1/hives/{hiveId}/members')
    return ok(await roster().list(hiveId))
  })
  t.registerRoute('GET', '/v1/hives/{hiveId}/members/{id}', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/members/{id}')
    const m = await roster().get(p.hiveId, p.id)
    return m ? ok(m) : fail('NOT_FOUND', `member not found: ${p.id}`, 404)
  })
  t.registerRoute('GET', '/v1/hives/{hiveId}/members/{id}/state', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/members/{id}/state')
    return ok(await roster().state(p.hiveId, p.id))
  })
  t.registerRoute('POST', '/v1/hives/{hiveId}/members', async (req) => {
    const { hiveId } = t.pathParams(req, '/v1/hives/{hiveId}/members')
    return ok(await roster().register(hiveId, req.body))
  })
  t.registerRoute('POST', '/v1/hives/{hiveId}/members/hatch', async (req) => {
    const { hiveId } = t.pathParams(req, '/v1/hives/{hiveId}/members/hatch')
    return ok(await roster().hatch(hiveId, req.body))
  })
  t.registerRoute('POST', '/v1/hives/{hiveId}/members/{id}/dismiss', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/members/{id}/dismiss')
    await roster().dismiss(p.hiveId, p.id)
    return ok(true)
  })
  t.registerRoute('PATCH', '/v1/hives/{hiveId}/members/{id}/name', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/members/{id}/name')
    if (typeof req.body?.name !== 'string') return fail('BAD_REQUEST', 'name required')
    await roster().rename(p.hiveId, p.id, req.body.name)
    return ok(true)
  })
  t.registerRoute('DELETE', '/v1/hives/{hiveId}/members/{id}', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/members/{id}')
    await roster().remove(p.hiveId, p.id)
    return ok(true)
  })
}

// ---------------------------------------------------------------------------
// ledger — 台账（→ LedgerService）
// ---------------------------------------------------------------------------

export function registerLedgerRoutes(t: HoneycombTransport): void {
  const ledger = () => t.services.ledger

  t.registerRoute('GET', '/v1/hives/{hiveId}/tasks', async (req) => {
    const { hiveId } = t.pathParams(req, '/v1/hives/{hiveId}/tasks')
    const filter = t.queryJson(req, 'filter')
    return ok(await ledger().list(hiveId, filter))
  })
  t.registerRoute('GET', '/v1/hives/{hiveId}/tasks/{id}', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/tasks/{id}')
    const task = await ledger().get(p.id)
    return task ? ok(task) : fail('NOT_FOUND', `task not found: ${p.id}`, 404)
  })
  t.registerRoute('POST', '/v1/hives/{hiveId}/tasks', async (req) => {
    const { hiveId } = t.pathParams(req, '/v1/hives/{hiveId}/tasks')
    if (!req.body || typeof req.body.subject !== 'string') {
      return fail('BAD_REQUEST', 'CreateTaskInput requires subject')
    }
    return ok(await ledger().create(hiveId, req.body))
  })
  t.registerRoute('PATCH', '/v1/hives/{hiveId}/tasks/{id}', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/tasks/{id}')
    return ok(await ledger().update(p.id, req.body))
  })
  t.registerRoute('POST', '/v1/hives/{hiveId}/tasks/{id}/owner', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/tasks/{id}/owner')
    const owner = req.body?.owner ?? null
    await ledger().setOwner(p.id, owner)
    return ok(true)
  })
  t.registerRoute('POST', '/v1/hives/{hiveId}/tasks/{id}/dependency', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/tasks/{id}/dependency')
    if (!req.body?.blockedBy) return fail('BAD_REQUEST', 'blockedBy required')
    await ledger().addDependency(p.id, req.body.blockedBy)
    return ok(true)
  })
  t.registerRoute('DELETE', '/v1/hives/{hiveId}/tasks/{id}/dependency', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/tasks/{id}/dependency')
    if (!req.body?.blockedBy) return fail('BAD_REQUEST', 'blockedBy required')
    await ledger().removeDependency(p.id, req.body.blockedBy)
    return ok(true)
  })
}

// ---------------------------------------------------------------------------
// courier — 信使（→ CourierService）
// ---------------------------------------------------------------------------

export function registerCourierRoutes(t: HoneycombTransport): void {
  const courier = () => t.services.courier

  t.registerRoute('POST', '/v1/hives/{hiveId}/messages', async (req) => {
    const { hiveId } = t.pathParams(req, '/v1/hives/{hiveId}/messages')
    return ok(await courier().send(hiveId, req.body))
  })
  t.registerRoute('POST', '/v1/hives/{hiveId}/messages/deliver', async (req) => {
    const { hiveId } = t.pathParams(req, '/v1/hives/{hiveId}/messages/deliver')
    return ok(await courier().deliver(hiveId, req.body))
  })
  t.registerRoute('GET', '/v1/hives/{hiveId}/inbox/{recipient}', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/inbox/{recipient}')
    const filter = t.queryJson(req, 'filter')
    return ok(await courier().inbox(p.hiveId, p.recipient, filter))
  })
  t.registerRoute('POST', '/v1/hives/{hiveId}/messages/{id}/read', async (req) => {
    const p = t.pathParams(req, '/v1/hives/{hiveId}/messages/{id}/read')
    await courier().markRead(p.hiveId, p.id)
    return ok(true)
  })
  t.registerRoute('POST', '/v1/hives/{hiveId}/broadcast', async (req) => {
    const { hiveId } = t.pathParams(req, '/v1/hives/{hiveId}/broadcast')
    return ok(await courier().broadcast(hiveId, req.body?.from, req.body?.content))
  })
  t.registerRoute('GET', '/v1/hives/{hiveId}/activity', async (req) => {
    const { hiveId } = t.pathParams(req, '/v1/hives/{hiveId}/activity')
    const cursor = t.queryJson(req, 'cursor')
    const limit = req.query.limit ? Number(req.query.limit) : undefined
    return ok(await courier().feed(hiveId, cursor, limit))
  })
}

// ---------------------------------------------------------------------------
// mandate — 授权（→ MandateService）
// ---------------------------------------------------------------------------

export function registerMandateRoutes(t: HoneycombTransport): void {
  const mandate = () => t.services.mandate

  t.registerRoute('GET', '/v1/mandate/can', async (req) => {
    const actor = req.query.actor
    const action = req.query.action
    if (!actor || !action) return fail('BAD_REQUEST', 'actor & action required')
    const scope = t.queryJson(req, 'scope')
    return ok(await mandate().can(actor, action as any, scope))
  })
  t.registerRoute('POST', '/v1/mandate/assert', async (req) => {
    const { actor, action, scope } = req.body ?? {}
    if (!actor || !action) return fail('BAD_REQUEST', 'actor & action required')
    try {
      await mandate().assert(actor, action, scope)
      return ok(true)
    } catch {
      return fail('FORBIDDEN', `mandate denied: ${action}`, 403)
    }
  })
  t.registerRoute('GET', '/v1/mandate/grants/{memberId}', async (req) => {
    const { memberId } = t.pathParams(req, '/v1/mandate/grants/{memberId}')
    return ok(await mandate().grants(memberId))
  })
}

/** 注册全部 REST 路由（§3 全部端点）。 */
export function registerAllRoutes(t: HoneycombTransport): void {
  registerHiveRoutes(t)
  registerRosterRoutes(t)
  registerLedgerRoutes(t)
  registerCourierRoutes(t)
  registerMandateRoutes(t)
}
