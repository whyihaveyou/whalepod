/**
 * Honeycomb core end-to-end integration test.
 *
 * Boots the full plugin on a `Context`, then drives services × persistence ×
 * events across a complete lifecycle:
 *   apply → hive.create → (roster) hatch a mock member → ledger.create →
 *   courier.send
 *
 * Asserts three cross-cutting invariants:
 *   ① facts are written to the JsonlFactBackend AND a fresh store replayed from
 *      the same dir recovers the snapshot ("restart");
 *   ② key events (task/created, member/status, member/work-state, …) fire in order;
 *   ③ hive / roster / ledger / courier views are mutually consistent.
 *
 * Run: `npx tsx --test test/e2e-core.test.ts`
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context, apply } from '../src/index'
import { JsonlFactBackend } from '../src/persistence/jsonl'
import { FactStore } from '../src/persistence/store'
import type { MemberRuntime, RuntimeHandle } from '../src/runtime/registry'

const EVENT_NAMES = [
  'hive/created',
  'hive/renamed',
  'member/hatched',
  'member/status',
  'member/work-state',
  'task/created',
  'task/updated',
  'message/created',
  'message/read',
] as const

/** A scripted member runtime: no real spawn — returns a handle and simulates
 *  the agent-runtime's member/work-state transition on hatch. */
function mockRuntime(ctx: Context): MemberRuntime {
  return {
    id: 'mock',
    async hatch(_c, input): Promise<RuntimeHandle> {
      // mirrors runtime/agent-runtime.ts: emit work-state on transition
      ctx.emit('member/work-state', {
        hiveId: input.member.hiveId,
        memberId: input.member.id,
        state: 'starting',
      })
      return {
        sessionId: `sess_${input.member.id}`,
        async send() {},
        async *events() {},
        async close() {},
        async kill() {},
      }
    },
  }
}

function collectEvents(ctx: Context): { name: string; payload: unknown }[] {
  const seen: { name: string; payload: unknown }[] = []
  for (const name of EVENT_NAMES) {
    ctx.on(name, (payload) => void seen.push({ name, payload }))
  }
  return seen
}

test('e2e: services × persistence × events stay consistent across the lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfh-e2e-'))
  const ctx = new Context()

  await apply(ctx, { persistenceDir: dir })

  // register a mock runtime backend AFTER apply (plugin provides ctx.roster),
  // BEFORE any hatch — members will hatch through 'mock', not the native runtime.
  ctx.roster.registerRuntime(mockRuntime(ctx))

  const events = collectEvents(ctx)

  // -- 1. hive + queen -----------------------------------------------------
  const hive = await ctx.hive.create({
    name: 'crew',
    workspace: '/tmp/crew',
    workspaceMode: 'shared',
    queen: { name: 'queen', role: 'queen', backend: 'mock' },
  })

  // -- 2. register + hatch an extra worker via roster ----------------------
  const registered = await ctx.roster.register(hive.id, { name: 'worker', role: 'worker', backend: 'mock' })
  const worker = await ctx.roster.hatch(hive.id, { name: registered.name, role: 'worker', backend: 'mock' })

  // -- 3. ledger: create a task owned by the worker -------------------------
  const task = await ctx.ledger.create(hive.id, { subject: 'ship the dmg', owner: worker.id })

  // -- 4. courier: queen → worker directive ---------------------------------
  const queenId = hive.queenId
  const msg = await ctx.courier.send(hive.id, {
    from: queenId,
    to: worker.id,
    kind: 'directive',
    content: 'package it',
  })

  /**---- assert ①: persistence — facts on disk, restart replays snapshot ----*/
  const file = join(dir, hive.id, 'facts.ndjson')
  const log = await readFile(file, 'utf8')
  const lineCount = log.trim().split('\n').length
  assert.ok(lineCount >= 8, `facts log accumulated on disk (got ${lineCount} lines)`)

  // "restart": brand-new store + backend over the same dir replays the snapshot
  const fresh = new FactStore(new JsonlFactBackend({ dir }))
  await fresh.load()
  assert.equal(fresh.hive(hive.id)?.name, 'crew', 'hive snapshot recovered after restart')
  assert.ok(fresh.member(hive.queenId), 'queen recovered after restart')
  assert.equal(fresh.member(worker.id)?.status, 'idle', 'worker status recovered (idle after mock hatch)')
  assert.equal(fresh.task(task.id)?.subject, 'ship the dmg', 'task recovered after restart')
  assert.equal(fresh.message(msg.id)?.content, 'package it', 'message recovered after restart')
  assert.equal(fresh.member(worker.id)?.hiveId, hive.id, 'member belongs to the right hive after restart')

  /**---- assert ②: key events emitted (in order) ----*/
  const names = events.map((e) => e.name)
  for (const wanted of ['member/status', 'member/hatched', 'member/work-state', 'hive/created', 'task/created', 'message/created']) {
    assert.ok(names.includes(wanted), `expected event "${wanted}" to be emitted`)
  }
  const idxHive = names.indexOf('hive/created')
  const idxTask = names.indexOf('task/created')
  const idxMsg = names.indexOf('message/created')
  assert.ok(idxHive < idxTask, 'hive creation precedes ledger work')
  assert.ok(idxTask < idxMsg, 'task creation precedes message send')

  const statuses = events.filter((e) => e.name === 'member/status').map((e) => (e.payload as { status: string }).status)
  assert.ok(statuses.includes('hatching') && statuses.includes('idle'), 'member/status goes hatching → idle')

  const ws = events.find((e) => e.name === 'member/work-state')
  assert.ok(ws, 'mock runtime emitted member/work-state')
  assert.equal((ws.payload as { state: string }).state, 'starting')

  /**---- assert ③: cross-service consistency (live stores agree) ----*/
  const roster = await ctx.roster.list(hive.id)
  assert.ok(roster.some((m) => m.id === queenId), 'roster lists the queen')
  assert.ok(roster.some((m) => m.id === worker.id), 'roster lists the worker')

  const tasks = await ctx.ledger.list(hive.id)
  assert.equal(tasks.length, 1, 'exactly one task in ledger')
  assert.equal(tasks[0]!.owner, worker.id, 'task owner == registered worker id')

  const inbox = await ctx.courier.inbox(hive.id, worker.id, { unreadOnly: true })
  assert.equal(inbox.length, 1, 'worker has exactly one unread message')
  assert.equal(inbox[0]!.from, queenId)
  assert.equal(inbox[0]!.to, worker.id)
  assert.equal(inbox[0]!.kind, 'directive')

  const hives = await ctx.hive.list()
  assert.equal(hives.length, 1, 'exactly one hive in scope')
})
