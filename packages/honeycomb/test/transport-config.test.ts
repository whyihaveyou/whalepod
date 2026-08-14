/**
 * Test: config-driven auto transport server (plugin wiring ③).
 *
 * Verifies: `apply(ctx, { transport: { enabled: true, port } })` starts a real
 * HTTP+WS server automatically, and `ctx.dispose()` shuts it down.
 * Uses a free port to avoid conflicts.
 *
 * Run with: tsx test/transport-config.test.ts
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import { Context, apply } from '../src/index'

/** 找一个空闲端口（起临时服务器→取端口→关）。 */
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
  const pDir = join(tmpdir(), `dfh-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await apply(ctx, {
    persistenceDir: pDir,
    transport: { enabled: true, host: '127.0.0.1', port },
  })

  const base = `http://127.0.0.1:${port}`
  try {
    // config 自动起的 server 应可响应 REST
    const res = await fetch(`${base}/v1/hives`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as any
    assert.equal(body.ok, true)
    assert.ok(Array.isArray(body.data))

    // WS 也应可连
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.once('open', () => { ws.close(); resolve() })
      ws.once('error', reject)
    })

    console.log(`✅ config-driven transport auto-started on :${port} (REST+WS)`)
  } finally {
    await ctx.dispose() // 应自动 close server
  }
}

main().catch((error) => {
  console.error('❌ config-driven transport test failed:', error)
  process.exitCode = 1
})
