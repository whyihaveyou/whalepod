/**
 * Unit tests for the append-only jsonl persistence backend: replay across
 * "restarts", corrupted-line tolerance, and append-only semantics.
 *
 * Run with: `npx tsx --test test/persistence.test.ts`
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { FactStore } from '../src/persistence/store'
import { JsonlFactBackend, defaultFactDir } from '../src/persistence/jsonl'

/** Append two facts into a fresh store (as Honeycomb services would). */
async function seedStore(dir: string, hiveId: string): Promise<void> {
  const backend = new JsonlFactBackend({ dir })
  const store = new FactStore(backend)
  await store.load()
  await store.append(hiveId, {
    type: 'hive-created',
    hive: {
      id: hiveId, name: 'A', workspace: '/tmp/a', workspaceMode: 'shared',
      queenId: 'm1', createdAt: 1, updatedAt: 1,
    },
  })
  await store.append(hiveId, {
    type: 'member-registered',
    member: {
      id: 'm1', hiveId, name: 'q', role: 'queen', backend: 'native',
      status: 'idle', createdAt: 2, updatedAt: 2,
    },
    at: 2,
  })
}

test('jsonl: facts survive a restart via disk replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfh-jsonl-replay-'))
  const hiveId = 'hive_restart'

  // "first process" writes facts to disk.
  await seedStore(dir, hiveId)

  // Path convention: ~/.dfh/hive/<hiveId>/facts.ndjson
  const file = join(dir, hiveId, 'facts.ndjson')
  const content = await readFile(file, 'utf8')
  const lines = content.trim().split('\n')
  assert.equal(lines.length, 2, 'append-only: exactly two records on disk')

  // "second process" (fresh store + fresh backend, same dir) replays from disk.
  const backend = new JsonlFactBackend({ dir })
  const store = new FactStore(backend)
  await store.load()

  assert.equal(store.hive(hiveId)?.name, 'A')
  assert.equal(store.member('m1')?.role, 'queen')
  assert.equal(store.hives().length, 1)

  // survive a *second* restart too (append after restart, then restart again)
  await store.append(hiveId, { type: 'hive-renamed', hiveId, name: 'B', at: 3 })

  const store3 = new FactStore(new JsonlFactBackend({ dir }))
  await store3.load()
  assert.equal(store3.hive(hiveId)?.name, 'B', 'append after restart is also persisted')
  assert.equal(store3.member('m1')?.role, 'queen')
})

test('jsonl: replay across multiple hives concatenates deterministically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfh-jsonl-multi-'))
  await seedStore(dir, 'hive_1')
  await seedStore(dir, 'hive_2')

  const backend = new JsonlFactBackend({ dir })
  const store = new FactStore(backend)
  await store.load()
  assert.equal(store.hives().length, 2)
  assert.ok(store.hive('hive_1'))
  assert.ok(store.hive('hive_2'))
})

test('jsonl: corrupted lines are skipped and warned, never abort startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfh-jsonl-corrupt-'))
  const hiveId = 'hive_bad'
  await seedStore(dir, hiveId)

  const file = join(dir, hiveId, 'facts.ndjson')
  const original = await readFile(file, 'utf8')
  // Inject several kinds of corruption between valid lines:
  // ① invalid JSON, ② missing `seq`, ③ unknown fact type, ④ truncated line.
  const corrupted =
    original.split('\n')[0] + '\n' + 'this is not json\n' +
    '{"seq":99,"at":9,"hiveId":"hive_bad","fact":{"type":"task-created","task":{"id":"t"}}}\n' +
    '{"seq":3,"at":3,"hiveId":"hive_bad","fact":{"type":"future-unknown-type","x":1}}\n' +
    '{truncated\n' +
    original.split('\n').filter(Boolean).slice(1).join('\n') + '\n'
  await writeFile(file, corrupted, 'utf8')

  const warnings: string[] = []
  const backend = new JsonlFactBackend({ dir, onWarn: (m) => warnings.push(m) })
  const store = new FactStore(backend)
  await store.load() // must NOT throw despite corrupt lines

  assert.equal(store.hives().length, 1, 'valid records still replayed around corrupt lines')
  assert.equal(store.hive(hiveId)?.name, 'A')
  assert.equal(store.member('m1')?.role, 'queen')
  assert.equal(warnings.length, 1, 'one warning for the single hive file replayed in full, despite 4 corrupt lines')
  assert.ok(warnings[0]!.includes('skipped') && warnings[0]!.includes('4'), 'warning reports the 4 skipped corrupt lines')
})

test('jsonl: missing log file → empty replay (first run)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfh-jsonl-empty-'))
  const backend = new JsonlFactBackend({ dir })
  const store = new FactStore(backend)
  await store.load()
  assert.equal(store.hives().length, 0)

  const records = await backend.replay('never_created_hive')
  assert.deepEqual(records, [])
})

test('jsonl: default dir points under the user home (~/.dfh/hive)', () => {
  assert.ok(defaultFactDir().startsWith(homedir()))
  assert.ok(defaultFactDir().endsWith('.dfh/hive'))
})
