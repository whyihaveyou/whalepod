import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, apply, createNodeTransportServer } from '../src/index'
import { createHoneycombClient } from '../src/transport/client'
import type { NodeTransportServerHandle } from '../src/index'

const guard = (label: string, p: Promise<unknown>, ms = 8000): Promise<unknown> => {
  return Promise.race([
    p.then((v) => ({ ok: true as const, v })),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ])
}

async function main(): Promise<void> {
  console.log('step 0: new Context')
  const ctx = new Context()
  const pDir = join(tmpdir(), `dfh-liveprobe-${Date.now()}`)
  console.log('step 1: apply')
  await guard('apply', apply(ctx, { persistenceDir: pDir }))
  console.log('step 2: createNodeTransportServer')
  const server = (await guard(
    'createNodeTransportServer',
    createNodeTransportServer(ctx, { host: '127.0.0.1', port: 0 }),
  )) as { ok: true; v: NodeTransportServerHandle }
  console.log('step 3: server on', server.v.host, server.v.port)
  const httpUrl = `http://${server.v.host}:${server.v.port}`
  const client = createHoneycombClient({ httpUrl, wsUrl: `ws://${server.v.host}:${server.v.port}/ws` })
  console.log('step 4: client.connect()')
  await guard('client.connect', client.connect())
  console.log('step 5: connected =', client.connected)
  console.log('step 6: REST hive.create')
  const hive = (await guard('hive.create', client.hive.create({ name: 'probe', workspace: '/tmp' }))) as {
    ok: true
    v: { id: string }
  }
  console.log('step 7: hive.id =', hive.v.id)
  console.log('PROBE PASS')
  await client.close().catch(() => {})
  await server.v.close().catch(() => {})
  await ctx.fiber.dispose()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('PROBE FAIL:', error)
    process.exit(1)
  })
