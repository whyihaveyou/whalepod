/**
 * Smoke test: drift-proof the memory transport (REST + WS) on top of the core.
 * Run with: tsx test/transport-smoke.ts
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, apply } from '../src/index'
import type { MemberRuntime, RuntimeHandle } from '../src/index'
import { createMemoryTransport, MemoryWsConn } from '../src/transport'
import type { WsConn } from '../src/transport'

function fakeRuntime(): MemberRuntime {
  return {
    id: 'native',
    async hatch(_ctx, input): Promise<RuntimeHandle> {
      return {
        sessionId: `sess_${input.member.id}`,
        async send() {},
        events() {
          return (async function* () {})()
        },
        async close() {},
        async kill() {},
      }
    },
  }
}

async function main(): Promise<void> {
  const ctx = new Context()
  const pDir = join(tmpdir(), `dfh-transport-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await apply(ctx, { persistenceDir: pDir })
  ctx.roster.registerRuntime(fakeRuntime())

  const t = createMemoryTransport(ctx)

  // -- REST: hive ----------------------------------------------------------
  let res = await t.http.dispatch('POST', '/v1/hives', {}, { name: 'A', workspace: '/tmp/a' })
  assert.equal(res.status, 200)
  const hive = res.body.data
  assert.ok(hive.id)

  res = await t.http.dispatch('GET', `/v1/hives/${hive.id}`)
  assert.equal(res.body.data.id, hive.id)

  res = await t.http.dispatch('GET', '/v1/hives')
  assert.ok(res.body.data.length >= 1)

  // -- REST: member ---------------------------------------------------------
  res = await t.http.dispatch('POST', `/v1/hives/${hive.id}/members/hatch`, {}, { name: 'w1', backend: 'native' })
  assert.equal(res.status, 200)
  const worker = res.body.data
  assert.equal(worker.status, 'idle')

  res = await t.http.dispatch('GET', `/v1/hives/${hive.id}/members`)
  assert.equal(res.body.data.length, 2) // queen + worker

  res = await t.http.dispatch('GET', `/v1/hives/${hive.id}/members/${worker.id}/state`)
  assert.equal(res.status, 200)

  // -- REST: task + dependency ----------------------------------------------
  res = await t.http.dispatch('POST', `/v1/hives/${hive.id}/tasks`, {}, { subject: 'blocker' })
  const blocker = res.body.data
  res = await t.http.dispatch(
    'POST',
    `/v1/hives/${hive.id}/tasks`,
    {},
    { subject: 'dependent', blockedBy: [blocker.id] },
  )
  const dependent = res.body.data
  assert.deepEqual(dependent.blockedBy, [blocker.id])

  res = await t.http.dispatch('GET', `/v1/hives/${hive.id}/tasks`, { filter: JSON.stringify({ runnable: true }) })
  const runnable = res.body.data
  assert.ok(runnable.some((x: any) => x.id === blocker.id))
  assert.ok(!runnable.some((x: any) => x.id === dependent.id))

  res = await t.http.dispatch('PATCH', `/v1/hives/${hive.id}/tasks/${blocker.id}`, {}, { status: 'completed' })
  assert.equal(res.status, 200)

  // -- REST: message ---------------------------------------------------------
  const queen = (await t.http.dispatch('GET', `/v1/hives/${hive.id}/members`)).body.data.find(
    (m: any) => m.role === 'queen',
  )
  res = await t.http.dispatch(
    'POST',
    `/v1/hives/${hive.id}/messages`,
    {},
    { from: queen.id, to: worker.id, kind: 'directive', content: 'do it' },
  )
  assert.equal(res.status, 200)

  res = await t.http.dispatch('GET', `/v1/hives/${hive.id}/inbox/${worker.id}`)
  assert.equal(res.body.data.length, 1)

  // -- REST: mandate ---------------------------------------------------------
  res = await t.http.dispatch('GET', '/v1/mandate/can', { actor: worker.id, action: 'ledger.create' })
  assert.equal(res.body.data, false)

  // -- WS: subscribe + event push -------------------------------------------
  const conn = new MemoryWsConn()
  t.ws.on(conn)
  t.ws.onClientMessage(conn, { type: 'subscribe', hiveId: hive.id })

  await t.http.dispatch(
    'POST',
    `/v1/hives/${hive.id}/messages`,
    {},
    { from: queen.id, to: worker.id, kind: 'note', content: 'pushed?' },
  )

  const pushed = conn.sent.filter((m) => m.topic === 'message/created')
  assert.ok(pushed.length >= 1, 'WS received message/created for subscribed hive')
  const frame = pushed[pushed.length - 1] as any
  assert.equal(frame.payload.message.hiveId, hive.id)

  t.ws.off(conn.id)
  t.dispose()
  console.log('✅ honeycomb transport smoke test passed')
}

main().catch((error) => {
  console.error('❌ transport smoke test failed:', error)
  process.exitCode = 1
})
