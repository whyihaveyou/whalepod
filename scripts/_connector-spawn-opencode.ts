import { collectHostEnvironment } from '../packages/honeycomb/src/connectors/detect/host-env.ts'
import { OpenCodeAdapter } from '../packages/honeycomb/src/connectors/adapters/opencode.ts'

const WALL = 120_000 // hard overall cap (ms)

function hr(t0: number): string {
  return `${((Date.now() - t0) / 1000).toFixed(1)}s`
}

async function main() {
  const host = collectHostEnvironment()
  const open = new OpenCodeAdapter()
  const d = await open.detect(host)
  if (!d?.binPath) { console.log('opencode not installed; skip live spawn'); return }
  console.log('spawning opencode bin:', d.binPath, new Date().toISOString())
  const t0 = Date.now()

  let session: Awaited<ReturnType<typeof open.spawnSession>> | undefined
  const timer = setTimeout(() => { console.log(`WALL_TIMEOUT at ${hr(t0)}`); try { session?.kill() } catch {} }, WALL)
  try {
    session = await open.spawnSession({ cwd: '/tmp', env: {} })
    console.log('  spawned session id:', session.sessionId, `(${hr(t0)})`)
    await session.send({ content: 'Reply with exactly the single word: OK' })
    console.log('  prompt sent', `(${hr(t0)})`)
    process.stdout.write('  awaiting events...\n')

    const types: string[] = []
    let sawFirst = false
    for await (const ev of session.events) {
      types.push(ev.type)
      if (!sawFirst) { sawFirst = true; console.log(`  FIRST EVENT at ${hr(t0)}: ${ev.type}`) }
      if (ev.type === 'stream') {
        console.log(`  [${hr(t0)}] stream:`, JSON.stringify(ev.chunk))
      } else if (ev.type === 'tool-call') {
        console.log(`  [${hr(t0)}] tool-call name=`, (ev as { name?: string }).name)
      } else if (ev.type === 'tool-result') {
        console.log(`  [${hr(t0)}] tool-result`)
      } else if (ev.type === 'done') {
        console.log(`  [${hr(t0)}] done exitCode=`, (ev as { exitCode?: number }).exitCode)
      } else if (ev.type === 'error') {
        console.log(`  [${hr(t0)}] error msg=`, (ev as { message?: string }).message)
      } else {
        console.log(`  [${hr(t0)}] ${ev.type}`)
      }
      if (ev.type === 'done' || ev.type === 'error') break
    }
    console.log('EVENT TYPES:', JSON.stringify(types), `(total ${hr(t0)})`)
  } finally {
    clearTimeout(timer)
    // fire-and-forget cleanup; never block exit
    session?.close().catch(() => {})
    session?.kill().catch(() => {})
  }
  console.log('CLEANUP done', `(${hr(t0)})`)
  process.exit(0)
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
