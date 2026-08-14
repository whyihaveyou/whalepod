import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import { Context, apply } from '../src/index'

const guard = (label: string, p: Promise<unknown>, ms = 8000): Promise<unknown> => {
  return Promise.race([
    p.then((v) => ({ ok: true as const, v })),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ])
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port as number
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function main(): Promise<void> {
  const port = await freePort()
  const ctx = new Context()
  const pDir = join(tmpdir(), `dfh-probe3-${Date.now()}`)
  console.log('step 0: apply with transport on fixed port', port)
  await guard(
    'apply+transport',
    apply(ctx, { persistenceDir: pDir, transport: { enabled: true, host: '127.0.0.1', port } }),
  )
  console.log('step 1: apply ok')
  const base = `http://127.0.0.1:${port}`
  console.log('step 2: GET /v1/hives')
  const res = (await guard('fetch /v1/hives', fetch(`${base}/v1/hives`))) as { ok: true; v: Response }
  console.log('step 3: status', res.v.status)
  const body = await res.v.text()
  console.log('step 4: body =', body.slice(0, 200))
  console.log('step 5: WS connect')
  await guard('ws open', new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    ws.once('open', () => { ws.close(); resolve() })
    ws.once('error', reject)
  }))
  console.log('step 6: ws ok')
  await ctx.fiber.dispose()
  console.log('PROBE PASS')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('PROBE FAIL:', error)
    process.exit(1)
  })
