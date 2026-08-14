import { collectHostEnvironment } from '../packages/honeycomb/src/connectors/detect/host-env.ts'
import { KimiCodeAdapter } from '../packages/honeycomb/src/connectors/adapters/kimi-code.ts'

const WALL = 40_000

async function main() {
  const host = collectHostEnvironment()
  const adapter = new KimiCodeAdapter()
  const d = await adapter.detect(host)
  if (!d?.binPath) { console.log('kimi not installed'); return }
  console.log('kimi bin:', d.binPath)
  let session: Awaited<ReturnType<typeof adapter.spawnSession>> | undefined
  const t0 = Date.now()
  const hr = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
  const hard = new Promise<'timeout'>((resolve) => setTimeout(() => { session?.kill().catch(() => {}); resolve('timeout') }, WALL))
  const attempt = (async () => {
    session = await adapter.spawnSession({ cwd: process.cwd(), env: {} })
    console.log(`spawned @ ${hr()}`)
    await session.send({ content: 'Reply with exactly: OK' })
    console.log(`sent @ ${hr()}`)
    const types: string[] = []
    for await (const ev of session.events as AsyncIterable<{ type?: string; chunk?: string; message?: string; exitCode?: number }>) {
      types.push(ev.type as string)
      if (ev.type === 'stream') console.log(`  [${hr()}] stream:`, JSON.stringify(ev.chunk))
      else if (ev.type === 'tool-call') console.log(`  [${hr()}] tool-call`)
      else if (ev.type === 'tool-result') console.log(`  [${hr()}] tool-result`)
      else if (ev.type === 'error') console.log(`  [${hr()}] ERROR:`, ev.message)
      else if (ev.type === 'done') console.log(`  [${hr()}] DONE exitCode=`, ev.exitCode)
      if (ev.type === 'done' || ev.type === 'error') break
    }
    console.log(`KIMI TYPES:`, JSON.stringify(types), `(${hr()})`)
    return types.includes('stream') ? ('ok' as const) : ('no-stream' as const)
  })()
  try {
    const r = await Promise.race([attempt, hard])
    console.log(`outcome=${r} total=${hr()}`)
  } finally {
    session?.close().catch(() => {})
    session?.kill().catch(() => {})
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
