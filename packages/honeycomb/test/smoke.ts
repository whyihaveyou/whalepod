/**
 * Smoke test: exercises the full honeycomb core flow.
 * Run with: tsx test/smoke.ts  (or `node --test` after `tsc` build).
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Context,
  apply,
  MessageDroppedError,
  MemoryFactBackend,
  FactStore,
  replay,
} from '../src/index'
import type { MemberRuntime, RuntimeHandle } from '../src/index'

// -- fake runtime (overrides the plugin's native backend) -------------------

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
  // Use a throwaway dir so the smoke test exercises the real jsonl-on-disk
  // persistence end-to-end without touching the user's ~/.dfh/hive.
  const pDir = join(tmpdir(), `dfh-smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await apply(ctx, { persistenceDir: pDir })
  ctx.roster.registerRuntime(fakeRuntime())

  // -- hive ----------------------------------------------------------------
  const hive = await ctx.hive.create({ name: 'A', workspace: '/tmp/a' })
  assert.ok(hive.queenId, 'hive has a queen')
  assert.equal((await ctx.hive.list()).length, 1)
  const queen = await ctx.roster.get(hive.id, hive.queenId)
  assert.ok(queen, 'queen member exists')
  assert.equal(queen!.role, 'queen')

  // -- roster --------------------------------------------------------------
  const worker = await ctx.roster.hatch(hive.id, { name: 'w1', backend: 'native' })
  assert.equal(worker.status, 'idle')
  assert.equal((await ctx.roster.list(hive.id)).length, 2)

  // -- ledger + dependency --------------------------------------------------
  const blocker = await ctx.ledger.create(hive.id, { subject: 'blocker' })
  const dependent = await ctx.ledger.create(hive.id, { subject: 'dependent', blockedBy: [blocker.id] })
  assert.deepEqual(dependent.blockedBy, [blocker.id])
  assert.deepEqual(blocker.blocks, [dependent.id])

  let runnable = await ctx.ledger.list(hive.id, { runnable: true })
  assert.ok(runnable.some((t) => t.id === blocker.id))
  assert.ok(!runnable.some((t) => t.id === dependent.id), 'dependent is blocked until blocker completes')

  await ctx.ledger.setOwner(dependent.id, worker.id)
  await ctx.ledger.update(blocker.id, { status: 'completed' })
  runnable = await ctx.ledger.list(hive.id, { runnable: true })
  assert.ok(runnable.some((t) => t.id === dependent.id), 'dependent becomes runnable after blocker completes')

  // -- mandate --------------------------------------------------------------
  assert.equal(await ctx.mandate.can(queen!.id, 'hive.remove'), true)
  assert.equal(await ctx.mandate.can(worker.id, 'courier.send'), true)
  assert.equal(await ctx.mandate.can(worker.id, 'ledger.create'), false)
  assert.equal(await ctx.mandate.can(worker.id, 'ledger.update', { taskId: dependent.id }), true, 'owner-scoped')
  assert.equal(await ctx.mandate.can(worker.id, 'ledger.update', { taskId: blocker.id }), false, 'not owner')
  await assert.rejects(() => ctx.mandate.assert(worker.id, 'ledger.create'))

  // -- courier --------------------------------------------------------------
  const msg = await ctx.courier.send(hive.id, { from: queen!.id, to: worker.id, kind: 'directive', content: 'do it' })
  let inbox = await ctx.courier.inbox(hive.id, worker.id)
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0]!.id, msg.id)
  await ctx.courier.markRead(hive.id, msg.id)
  inbox = await ctx.courier.inbox(hive.id, worker.id, { unreadOnly: true })
  assert.equal(inbox.length, 0, 'message is read')

  // -- courier/outgoing waterfall: drop message -----------------------------
  const drop = ctx.on('courier/outgoing', () => null)
  await assert.rejects(() => ctx.courier.send(hive.id, { from: queen!.id, to: worker.id, kind: 'note', content: 'x' }), MessageDroppedError)
  drop()

  // -- mandate/decide waterfall: override (deny a queen action) -------------
  const deny = ctx.on('mandate/decide', (grant: any, payload: any) => {
    if (payload.action === 'hive.remove') return { ...grant, verdict: 'denied', reason: 'policy' }
    return undefined
  })
  assert.equal(await ctx.mandate.can(queen!.id, 'hive.remove'), false, 'waterfall override denies queen')
  deny()
  assert.equal(await ctx.mandate.can(queen!.id, 'hive.remove'), true, 'default restored after listener removed')

  // -- dismiss --------------------------------------------------------------
  await ctx.roster.dismiss(hive.id, worker.id)
  const dismissed = await ctx.roster.get(hive.id, worker.id)
  assert.equal(dismissed!.status, 'dormant')
  assert.equal((await ctx.roster.list(hive.id)).length, 1, 'dismissed member leaves active roster')

  // -- feed ----------------------------------------------------------------
  const page = await ctx.courier.feed(hive.id)
  assert.ok(page.items.length >= 2, 'feed merges messages + tasks')

  // -- persistence replay ----------------------------------------------------
  const backend = new MemoryFactBackend()
  const storeA = new FactStore(backend)
  const hid = 'hive_test'
  await storeA.append(hid, {
    type: 'hive-created',
    hive: {
      id: hid,
      name: 'X',
      workspace: '/tmp/x',
      workspaceMode: 'shared',
      queenId: 'm1',
      createdAt: 1,
      updatedAt: 1,
    },
  })
  await storeA.append(hid, { type: 'member-registered', member: { id: 'm1', hiveId: hid, name: 'q', role: 'queen', backend: 'native', status: 'idle', createdAt: 2, updatedAt: 2 }, at: 2 })

  const storeB = new FactStore(backend)
  await storeB.load()
  assert.equal(storeB.hive(hid)?.name, 'X')
  assert.equal(storeB.member('m1')?.role, 'queen')
  assert.equal(storeB.hives().length, 1)

  // replay() pure function
  const records = await backend.replay()
  const snap = replay(records)
  assert.equal(snap.hives.get(hid)?.name, 'X')
  assert.equal(snap.members.get('m1')?.role, 'queen')

  console.log('✅ honeycomb smoke test passed')
}

main().catch((error) => {
  console.error('❌ smoke test failed:', error)
  process.exitCode = 1
})
