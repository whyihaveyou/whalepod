/**
 * Smoke test: real network transport over HTTP (fetch) + WebSocket (ws client).
 *
 * Covers the full loop: boot core → start node transport server → REST create/query
 * hive via fetch → WS subscribe → trigger an event → assert server pushes event frame.
 *
 * Run with: tsx test/transport-http.test.ts
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { Context, apply, createNodeTransportServer } from '../src/index'
import type { NodeTransportServerHandle } from '../src/index'

async function main(): Promise<void> {
  const ctx = new Context()
  const pDir = join(tmpdir(), `dfh-http-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  await apply(ctx, { persistenceDir: pDir })

  // 固定端口可配；此处用随机端口验证「0 = 随机」。
  const server: NodeTransportServerHandle = await createNodeTransportServer(ctx, {
    host: '127.0.0.1',
    port: 0,
  })
  const baseUrl = `http://${server.host}:${server.port}`
  const wsUrl = `ws://${server.host}:${server.port}/ws`
  assert.ok(server.port > 0, 'server bound to a real port')

  try {
    // ---- 1. REST: create hive + query ------------------------------------
    const createRes = await fetch(`${baseUrl}/v1/hives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'panel-hive', workspace: '/tmp/panel' }),
    })
    assert.equal(createRes.status, 200)
    const created = (await createRes.json()) as any
    assert.equal(created.ok, true)
    const hiveId = created.data.id as string
    assert.ok(hiveId)

    const listRes = await fetch(`${baseUrl}/v1/hives`)
    const listed = (await listRes.json()) as any
    assert.ok(listed.data.some((h: any) => h.id === hiveId))

    // ---- 2. WS: subscribe + trigger event + receive push -----------------
    const ws = new WebSocket(wsUrl)
    await onceOpen(ws)

    ws.send(JSON.stringify({ type: 'subscribe', hiveId }))

    // 触发事件：给 hive 建一个 task（内部 emit task/created）。
    const taskRes = await fetch(`${baseUrl}/v1/hives/${hiveId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'blocker' }),
    })
    assert.equal(taskRes.status, 200)

    const frame = await waitForFrame(ws, 'task/created')
    assert.equal(frame.hiveId, hiveId)
    assert.equal(frame.topic, 'task/created')
    assert.equal((frame.payload as any).task.hiveId, hiveId)
    assert.equal((frame.payload as any).task.subject, 'blocker')

    ws.close()
    console.log('✅ real HTTP+WS transport test passed on', baseUrl)
  } finally {
    await server.close()
  }
}

/** 等待 ws 打开。 */
function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
}

/** 等待某个 topic 的 event 帧（含超时保护）。 */
function waitForFrame(ws: WebSocket, topic: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error(`timeout waiting for event "${topic}"`))
    }, timeoutMs)
    function onMsg(data: WebSocket.RawData): void {
      let msg: any
      try {
        msg = JSON.parse(data.toString('utf8'))
      } catch {
        return
      }
      if (msg && msg.type === 'event' && msg.topic === topic) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
  })
}

main().catch((error) => {
  console.error('❌ real transport test failed:', error)
  process.exitCode = 1
})
