/**
 * Live connector verification harness (manual run, not a unit test).
 * Drives the real external CLI agents end-to-end:
 *   detect -> spawn -> normalized event stream.
 *
 * Run:  cd packages/honeycomb && node_modules/.bin/tsx ../../scripts/_connector-live-run.ts
 * (or place under this package and run with its local tsx).
 */

import { collectHostEnvironment } from '../packages/honeycomb/src/connectors/detect/host-env.ts'
import { OpenCodeAdapter } from '../packages/honeycomb/src/connectors/adapters/opencode.ts'
import { CodexAdapter } from '../packages/honeycomb/src/connectors/adapters/codex.ts'
import { KimiCodeAdapter } from '../packages/honeycomb/src/connectors/adapters/kimi-code.ts'
import { HermesAdapter } from '../packages/honeycomb/src/connectors/adapters/hermes.ts'
import { ClaudeCodeAdapter } from '../packages/honeycomb/src/connectors/adapters/claude-code.ts'

async function main() {
const host = collectHostEnvironment()

console.log('=== LIVE DETECTION (real host) ===')
const adapters = [
  new OpenCodeAdapter(),
  new CodexAdapter(),
  new KimiCodeAdapter(),
  new HermesAdapter(),
  new ClaudeCodeAdapter(),
]
for (const a of adapters) {
  const d = await a.detect(host)
  if (d) {
    console.log(`[${a.id}] HIT  version=${d.version ?? 'n/a'} confidence=${d.confidence} bin=${d.binPath ?? '-'} config=${d.configDir ?? '-'}`)
  } else {
    console.log(`[${a.id}] miss (not detected)`)
  }
}

// --- opencode live spawn + event stream ---
console.log('\n=== OPENCODE LIVE SPAWN ===')
const open = new OpenCodeAdapter()
let session
try {
  session = await open.spawnSession({ cwd: process.cwd(), env: {} })
} catch (e) {
  console.log('SPAWN FAILED:', (e as Error).message)
  process.exit(1)
}

console.log('sessionId:', session.sessionId)
await session.send({ content: 'Reply with exactly the single word: OK' })

const events: string[] = []
try {
  for await (const ev of session.events) {
    events.push(`${ev.type}`)
    console.log(`  event: ${ev.type}`, ev.type === 'stream' ? JSON.stringify(ev.chunk) : '')
    if (ev.type === 'done' || ev.type === 'error') break
  }
} finally {
  await session.close().catch(() => {})
  await session.kill().catch(() => {})
}
console.log('\nEVENT TYPES SEEN:', JSON.stringify(events))
}

main().catch((e) => { console.error(e); process.exit(1) })
