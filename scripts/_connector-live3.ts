import { collectHostEnvironment } from '../packages/honeycomb/src/connectors/detect/host-env.ts'
import { HermesAdapter } from '../packages/honeycomb/src/connectors/adapters/hermes.ts'
import { CodexAdapter } from '../packages/honeycomb/src/connectors/adapters/codex.ts'
import { KimiCodeAdapter } from '../packages/honeycomb/src/connectors/adapters/kimi-code.ts'

const WALL = 45_000
function hr(t0: number) { return `${((Date.now() - t0) / 1000).toFixed(1)}s` }

async function runOne(name: string, adapter: { spawnSession: (c: unknown) => Promise<{ sessionId: string; events: AsyncIterable<unknown>; send: (i: unknown) => Promise<void>; close: () => Promise<void>; kill: () => Promise<void> }> }, prompt: string, host: ReturnType<typeof collectHostEnvironment>) {
  console.log(`\n===== ${name} =====`)
  let session: Awaited<ReturnType<typeof adapter.spawnSession>> | undefined
  const t0 = Date.now()
  const hard = new Promise<'timeout'>((resolve) => {
    setTimeout(() => { session?.kill().catch(() => {}); resolve('timeout') }, WALL)
  })
  const attempt = (async () => {
    session = await adapter.spawnSession({ cwd: process.cwd(), env: {} } as never)
    console.log(`spawned ${name} session @ ${hr(t0)}`)
    await session.send({ content: prompt })
    console.log(`sent prompt @ ${hr(t0)}`)
    const types: string[] = []
    for await (const ev of session.events as AsyncIterable<{ type?: string; chunk?: string; message?: string; name?: string; exitCode?: number }>) {
      types.push(ev.type as string)
      if (ev.type === 'stream') console.log(`  [${hr(t0)}] stream:`, JSON.stringify(ev.chunk))
      else if (ev.type === 'tool-call') console.log(`  [${hr(t0)}] tool-call name=`, ev.name)
      else if (ev.type === 'tool-result') console.log(`  [${hr(t0)}] tool-result`)
      else if (ev.type === 'error') console.log(`  [${hr(t0)}] ERROR:`, ev.message)
      else if (ev.type === 'done') console.log(`  [${hr(t0)}] DONE exitCode=`, ev.exitCode)
      if (ev.type === 'done' || ev.type === 'error') break
    }
    console.log(`${name} TYPES:`, JSON.stringify(types), `(${hr(t0)})`)
    if (types.includes('stream')) return 'ok' as const
    return 'no-stream' as const
  })()
  try {
    const r = await Promise.race([attempt, hard])
    console.log(`[${name}] outcome=${r} total=${hr(t0)}`)
  } finally {
    session?.close().catch(() => {})
    session?.kill().catch(() => {})
  }
}

async function main() {
  const host = collectHostEnvironment()
  await runOne('hermes', new HermesAdapter() as never, 'Reply with exactly the two words: HELLO WORLD', host)
  await runOne('codex', new CodexAdapter() as never, 'Reply with exactly: OK', host)
  await runOne('kimi-code', new KimiCodeAdapter() as never, 'Reply with exactly: OK', host)
  console.log('\nALL DONE')
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
