/**
 * Pure-function coverage for the agent-runtime glue's SessionEvent → WorkState
 * mapping (agent-runtime.ts). These are the two exported mapping functions:
 *
 *   - `deriveWorkState(event): DerivedWorkState | null`
 *   - `normalizeSessionEvent(event): RuntimeEvent`
 *
 * This file imports ONLY those two exported pure functions — it does NOT spawn
 * sessions and does NOT touch any runtime/ source. It pins the contract the
 * orchestration loop and the Worker member-status mapping rely on, so an
 * extension to the SessionEvent union has to update these tests (and spawn the
 * "new variant" default cases at the same time).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DerivedWorkState, deriveWorkState, normalizeSessionEvent, RuntimeEvent as AgentRuntimeEvent } from '../src/runtime/agent-runtime.ts'
import type { SessionEvent } from '../src/connectors/types.ts'

// ---------------------------------------------------------------------------
// deriveWorkState
// ---------------------------------------------------------------------------

test('deriveWorkState: working group (stream/tool-call/tool-result/approval-request/image)', () => {
  const working: SessionEvent[] = [
    { type: 'stream', chunk: 'hi' },
    { type: 'tool-call', id: 't1', name: 'bash', arguments: '{"cmd":"ls"}' },
    { type: 'tool-result', id: 't1', content: 'out' },
    { type: 'approval-request', id: 'a1', prompt: 'allow?' },
    { type: 'image', source: 'tool', toolCallId: 't1', mimeType: 'image/png', data: 'AA==' },
  ]
  for (const ev of working) {
    assert.equal(deriveWorkState(ev), 'working', `expected 'working' for ${ev.type}`)
  }
})

test('deriveWorkState: done maps by exitCode (0 → finished, != 0 → failed)', () => {
  assert.equal(deriveWorkState({ type: 'done', exitCode: 0 }), 'finished')
  assert.equal(deriveWorkState({ type: 'done', exitCode: 1 }), 'failed')
  assert.equal(deriveWorkState({ type: 'done', exitCode: -1 }), 'failed')
})

test('deriveWorkState: error → failed', () => {
  assert.equal(deriveWorkState({ type: 'error', message: 'boom' }), 'failed')
})

test('deriveWorkState: cancelled → idle', () => {
  assert.equal(deriveWorkState({ type: 'cancelled' }), 'idle')
})

test('deriveWorkState: unknown future variant → null (loose default)', () => {
  const unknown = { type: 'a-future-variant', whatever: 1 } as unknown as SessionEvent
  assert.equal(deriveWorkState(unknown), null)
})

// ---------------------------------------------------------------------------
// deriveWorkState: type-level exhaustiveness (compiles against the union)
// ---------------------------------------------------------------------------

test('DerivedWorkState values are the four member states (compile-time pin)', () => {
  const all: DerivedWorkState[] = ['working', 'finished', 'failed', 'idle']
  assert.equal(all.length, 4)
  assert.deepEqual([...all].sort(), ['failed', 'finished', 'idle', 'working'])
})

// ---------------------------------------------------------------------------
// normalizeSessionEvent
// ---------------------------------------------------------------------------

function norm(ev: SessionEvent): AgentRuntimeEvent {
  return normalizeSessionEvent(ev)
}

test('normalizeSessionEvent: stream', () => {
  assert.deepEqual(norm({ type: 'stream', chunk: 'hi' }), { type: 'stream', payload: { chunk: 'hi' } })
})

test('normalizeSessionEvent: image', () => {
  assert.deepEqual(
    norm({ type: 'image', source: 'tool', toolCallId: 't9', mimeType: 'image/png', data: 'QUJD' }),
    { type: 'image', payload: { source: 'tool', toolCallId: 't9', mimeType: 'image/png', data: 'QUJD' } },
  )
})

test('normalizeSessionEvent: tool-call / tool-result', () => {
  assert.deepEqual(norm({ type: 'tool-call', id: 't1', name: 'bash', arguments: '{}' }), {
    type: 'tool-call',
    payload: { id: 't1', name: 'bash', arguments: '{}' },
  })
  assert.deepEqual(norm({ type: 'tool-result', id: 't1', content: 'out' }), {
    type: 'tool-result',
    payload: { id: 't1', content: 'out' },
  })
})

test('normalizeSessionEvent: approval-request', () => {
  assert.deepEqual(norm({ type: 'approval-request', id: 'a1', prompt: 'allow?' }), {
    type: 'approval-request',
    payload: { id: 'a1', prompt: 'allow?' },
  })
})

test('normalizeSessionEvent: cancelled → no payload', () => {
  assert.deepEqual(norm({ type: 'cancelled' }), { type: 'cancelled' })
})

test('normalizeSessionEvent: done / error', () => {
  assert.deepEqual(norm({ type: 'done', exitCode: 0 }), { type: 'done', payload: { exitCode: 0 } })
  assert.deepEqual(norm({ type: 'error', message: 'boom' }), { type: 'error', payload: { message: 'boom' } })
})

test('normalizeSessionEvent: unknown future variant → loose passthrough (type+payload=event)', () => {
  const unknown = { type: 'future-thing', note: 'x' } as unknown as SessionEvent
  const out = norm(unknown)
  assert.equal(out.type, 'future-thing')
  assert.deepEqual(out.payload, unknown)
})
