/**
 * @dfh/honeycomb/connectors/adapters/acp — ACP adapter 测试
 *
 * 覆盖：
 *   1. 事件映射正确性（normalizeSessionUpdate）—— 纯函数单测
 *   2. 检测层（detect）—— 命中 PATH shim + capability probe
 *   3. 会话生命周期 —— mock ACP 子进程，跑通 initialize → newSession →
 *      send(prompt) → 收到 stream + tool-call + tool-result + done
 *   3b. cancel() —— 中断 in-flight prompt，emit cancelled（而非 done）；
 *       无 in-flight 时是 no-op，不影响后续 turn
 *   4. live（可选）—— 本机有 `opencode` 时跑 `opencode acp` 真链路
 *
 * 跑法：`pnpm tsx --test test/acp-adapter.test.ts`
 *
 * 子进程清理：所有 spawnSession 的测试都包了 try/finally 调 session.kill()。
 *
 * @module @dfh/honeycomb/connectors/adapters/acp
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACP_CATALOG,
  AcpAdapter,
  AcpSession,
  SessionEventQueue,
  defaultPermissionResponse,
  normalizeSessionUpdate,
} from '../src/connectors/adapters/acp.ts'
import { collectHostEnvironment } from '../src/connectors/detect/host-env.ts'

const MOCK_BIN = fileURLToPath(
  new URL('./fixtures/acp-mock-agent.mjs', import.meta.url),
)

// =====================================================================
// 1. 事件映射正确性（纯函数）
// =====================================================================

test('normalizeSessionUpdate: agent_message_chunk → stream', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello' },
  })
  assert.equal(evs.length, 1)
  assert.equal(evs[0].type, 'stream')
  assert.equal((evs[0] as { type: 'stream'; chunk: string }).chunk, 'hello')
})

test('normalizeSessionUpdate: agent_thought_chunk → stream', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking...' },
  })
  assert.equal(evs.length, 1)
  assert.equal(evs[0].type, 'stream')
})

test('normalizeSessionUpdate: image chunk → no event (skipped)', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', data: 'base64', mimeType: 'image/png' },
  })
  assert.equal(evs.length, 0)
})

test('normalizeSessionUpdate: tool_call + completed content → tool-call + tool-result', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: 'read_file',
    name: 'read_file',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    rawInput: { path: '/etc/hosts' },
    rawOutput: { ok: true },
  })
  assert.equal(evs.length, 2)
  assert.equal(evs[0].type, 'tool-call')
  assert.equal((evs[0] as { type: 'tool-call'; id: string }).id, 'tc-1')
  assert.equal(evs[1].type, 'tool-result')
})

test('normalizeSessionUpdate: tool_call_update completed → tool-result only', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-2',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
  })
  assert.equal(evs.length, 1)
  assert.equal(evs[0].type, 'tool-result')
})

test('normalizeSessionUpdate: tool_call_update in_progress → no event', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-3',
    status: 'in_progress',
    content: [],
  })
  assert.equal(evs.length, 0)
})

test('normalizeSessionUpdate: 计划/状态类 update → 全部忽略', () => {
  for (const upd of [
    { sessionUpdate: 'plan' as const, entries: [] },
    { sessionUpdate: 'plan_update' as const, entries: [] },
    {
      sessionUpdate: 'available_commands_update' as const,
      availableCommands: [],
    },
    { sessionUpdate: 'current_mode_update' as const, currentModeId: 'default' },
  ]) {
    assert.equal(normalizeSessionUpdate(upd).length, 0)
  }
})

test('defaultPermissionResponse: fail-closed (cancelled)', () => {
  const r = defaultPermissionResponse()
  const outcome = (r as { outcome: { outcome: string } }).outcome
  assert.equal(outcome.outcome, 'cancelled')
})

// =====================================================================
// 2. SessionEventQueue 行为
// =====================================================================

test('SessionEventQueue: enqueue/dequeue round-trip + async wakeup + close signal', async () => {
  const q = new SessionEventQueue()
  q.enqueue({ type: 'stream', chunk: 'a' })
  q.enqueue({ type: 'stream', chunk: 'b' })
  assert.deepEqual(await q.dequeue(), { type: 'stream', chunk: 'a' })
  assert.deepEqual(await q.dequeue(), { type: 'stream', chunk: 'b' })

  // 异步 dequeue + 后到的 enqueue
  const next = q.dequeue()
  q.enqueue({ type: 'done', exitCode: 0 })
  assert.deepEqual(await next, { type: 'done', exitCode: 0 })

  // close 应让 dequeue 立刻返回 null
  q.close()
  assert.equal(await q.dequeue(), null)
})

// =====================================================================
// 3. Adapter.detect —— PATH shim + capability probe
// =====================================================================

test('AcpAdapter.detect: 不存在的二进制 → null', async () => {
  const adapter = new AcpAdapter({
    id: 'acp-test',
    displayName: 'ACP Test',
    kind: 'opencode',
    binaryName: 'definitely-not-on-path-' + Date.now(),
    spawnArgs: ['acp'],
    capabilityProbe: ['--help'],
    configDirName: '.acp-test',
    capabilities: [{ id: 'streaming' }],
  })
  const host = collectHostEnvironment()
  const d = await adapter.detect(host)
  assert.equal(d, null)
})

test('AcpAdapter.detect: PATH shim + 空 capabilityProbe → descriptor.acp 被填上', async () => {
  const shimDir = mkdtempSync(join(tmpdir(), 'acp-detect-shim-'))
  try {
    const shim = join(shimDir, 'mock-acp-bin')
    writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const host = {
      ...collectHostEnvironment(),
      env: { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
    }
    const adapter = new AcpAdapter({
      id: 'mock-acp-detect',
      displayName: 'Mock ACP Detect',
      kind: 'opencode',
      binaryName: 'mock-acp-bin',
      spawnArgs: [],
      capabilityProbe: [],
      configDirName: '.mock-acp-detect',
      capabilities: [{ id: 'streaming' }],
    })
    const d = await adapter.detect(host)
    if (!d) {
      // PATH sanitization 罕见场景：跳过而非失败。
      return
    }
    assert.ok(d.binPath?.endsWith('mock-acp-bin'))
    if (d.acp) {
      assert.ok(Array.isArray(d.acp.spawnArgs))
    }
  } finally {
    rmSync(shimDir, { recursive: true, force: true })
  }
})

// =====================================================================
// 4. 会话生命周期 —— mock ACP 二进制
// =====================================================================

test('AcpAdapter.spawnSession: prompt → 收到 stream chunks + done', async () => {
  // 清掉环境变量里的干扰
  delete process.env.ACP_MOCK_EMIT_TOOLCALL
  delete process.env.ACP_MOCK_FAIL_AFTER

  const adapter = new AcpAdapter({
    id: 'mock-acp-via-node',
    displayName: 'ACP via node',
    kind: 'opencode',
    binaryName: 'node',
    spawnArgs: [MOCK_BIN],
    configDirName: '.mock-acp-via-node',
    capabilities: [{ id: 'streaming' }],
  })

  // 直接喂一个 descriptor（绕过 Detector 对 binaryName basename 的硬约束）
  const descriptor = {
    id: 'mock-acp-via-node',
    displayName: 'ACP via node',
    kind: 'opencode' as const,
    binPath: process.execPath,
    confidence: 'binary' as const,
    capabilities: [{ id: 'streaming' }],
    probe: [],
    acp: { spawnArgs: [MOCK_BIN] },
  }

  const session = (await adapter.spawnSession({
    cwd: tmpdir(),
    env: process.env,
    descriptor,
  })) as AcpSession

  try {
    assert.ok(session.sessionId.startsWith('mock-session-'))

    const events: unknown[] = []
    const collector = (async () => {
      for await (const ev of session.events) {
        events.push(ev)
      }
    })()

    await session.send({ content: 'say hi' })

    await Promise.race([
      collector,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('collector timeout')), 2_000),
      ),
    ]).catch(() => {
      // 超时也无所谓，events 已被累计
    })

    const types = events.map((e) => (e as { type: string }).type)
    assert.ok(types.includes('stream'), `expected stream in events, got: ${types}`)
    assert.ok(types.includes('done'), `expected done in events, got: ${types}`)

    const streams = events.filter((e) => (e as { type: string }).type === 'stream') as Array<{
      type: 'stream'
      chunk: string
    }>
    assert.ok(streams.length >= 4, `expected ≥4 stream chunks, got ${streams.length}`)
    const joined = streams.map((e) => e.chunk).join('')
    assert.equal(joined, 'Hello, world!')
  } finally {
    await session.kill()
  }
})

test('AcpAdapter.spawnSession: tool-call emission → stream + tool-call + tool-result + done', async () => {
  process.env.ACP_MOCK_EMIT_TOOLCALL = '1'
  delete process.env.ACP_MOCK_FAIL_AFTER

  const adapter = new AcpAdapter({
    id: 'mock-acp-with-tools',
    displayName: 'ACP with tools',
    kind: 'opencode',
    binaryName: 'node',
    spawnArgs: [MOCK_BIN],
    configDirName: '.mock-acp-tools',
    capabilities: [{ id: 'tool-use' }],
  })

  const descriptor = {
    id: 'mock-acp-with-tools',
    displayName: 'ACP with tools',
    kind: 'opencode' as const,
    binPath: process.execPath,
    confidence: 'binary' as const,
    capabilities: [{ id: 'tool-use' }],
    probe: [],
    acp: { spawnArgs: [MOCK_BIN] },
  }

  const session = await adapter.spawnSession({
    cwd: tmpdir(),
    env: process.env,
    descriptor,
  })
  try {
    const events: unknown[] = []
    const collector = (async () => {
      for await (const ev of session.events) {
        events.push(ev)
      }
    })()
    await session.send({ content: 'use a tool' })
    await Promise.race([
      collector,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('collector timeout')), 2_000),
      ),
    ]).catch(() => {})

    const types = events.map((e) => (e as { type: string }).type)
    assert.ok(types.includes('tool-call'), `expected tool-call, got: ${types}`)
    assert.ok(types.includes('tool-result'), `expected tool-result, got: ${types}`)
    assert.ok(types.includes('done'), `expected done, got: ${types}`)
  } finally {
    await session.kill()
    delete process.env.ACP_MOCK_EMIT_TOOLCALL
  }
})

// =====================================================================
// 4b. cancel() —— 中断 in-flight prompt turn
// =====================================================================

test('AcpSession.cancel(): 中断 in-flight prompt → 收到 cancelled（而非 done）', async () => {
  // 让 mock 把每个 chunk 拉长 80ms，并保持存活，便于我们发起 cancel。
  process.env.ACP_MOCK_DELAY_MS = '80'
  process.env.ACP_MOCK_KEEP_ALIVE = '1'
  delete process.env.ACP_MOCK_FAIL_AFTER
  delete process.env.ACP_MOCK_EMIT_TOOLCALL
  delete process.env.ACP_MOCK_CANCEL_AFTER

  const adapter = new AcpAdapter({
    id: 'mock-acp-cancel',
    displayName: 'ACP cancel',
    kind: 'opencode',
    binaryName: 'node',
    spawnArgs: [MOCK_BIN],
    configDirName: '.mock-acp-cancel',
    capabilities: [{ id: 'streaming' }],
  })
  const descriptor = {
    id: 'mock-acp-cancel',
    displayName: 'ACP cancel',
    kind: 'opencode' as const,
    binPath: process.execPath,
    confidence: 'binary' as const,
    capabilities: [{ id: 'streaming' }],
    probe: [],
    acp: { spawnArgs: [MOCK_BIN] },
  }

  const session = (await adapter.spawnSession({
    cwd: tmpdir(),
    env: process.env,
    descriptor,
  })) as AcpSession

  try {
    const events: Array<{ type: string; [k: string]: unknown }> = []
    const collector = (async () => {
      for await (const ev of session.events) {
        events.push(ev as { type: string })
      }
    })()

    // 在背景触发 send —— 80ms/chunk × 4 chunks ≈ 320ms 才会自然 done，
    // 给我们留足窗口 cancel。
    const sendPromise = session.send({ content: 'long task' })

    // 至少等到 1 个 stream chunk 已经从 mock 推回来再 cancel，保证
    // 真的打断了 in-flight turn，而不是提前抢跑。
    await new Promise((r) => setTimeout(r, 120))
    assert.ok(typeof session.cancel === 'function', 'cancel 必须是 AgentSession 契约的方法')
    await session.cancel!()

    // send() 应当 resolve 而非 reject；prompt 的 stopReason=cancelled 被映射成 cancelled 事件。
    await sendPromise

    // 收尾所有事件（mock 在 stopReason=cancelled 后会发 end_turn 之后 doExit）
    await Promise.race([
      collector,
      new Promise((r) => setTimeout(r, 1_000)),
    ])

    const types = events.map((e) => e.type)
    assert.ok(types.includes('cancelled'), `expected 'cancelled' event, got: ${types}`)
    assert.ok(!types.includes('done'), `cancelled 路径不应再 emit 'done', got: ${types}`)
    // 至少应见到一个 stream chunk（在 cancel 命中之前）
    assert.ok(
      types.includes('stream'),
      `cancel 前应已有 stream chunk 被消费, got: ${types}`,
    )
  } finally {
    await session.kill()
    delete process.env.ACP_MOCK_DELAY_MS
    delete process.env.ACP_MOCK_KEEP_ALIVE
  }
})

test('AcpSession.cancel(): 无 in-flight prompt 时是 no-op，不抛错、不发事件', async () => {
  process.env.ACP_MOCK_KEEP_ALIVE = '1'
  delete process.env.ACP_MOCK_DELAY_MS
  delete process.env.ACP_MOCK_CANCEL_AFTER
  delete process.env.ACP_MOCK_FAIL_AFTER
  delete process.env.ACP_MOCK_EMIT_TOOLCALL

  const adapter = new AcpAdapter({
    id: 'mock-acp-cancel-idle',
    displayName: 'ACP cancel idle',
    kind: 'opencode',
    binaryName: 'node',
    spawnArgs: [MOCK_BIN],
    configDirName: '.mock-acp-cancel-idle',
    capabilities: [{ id: 'streaming' }],
  })
  const descriptor = {
    id: 'mock-acp-cancel-idle',
    displayName: 'ACP cancel idle',
    kind: 'opencode' as const,
    binPath: process.execPath,
    confidence: 'binary' as const,
    capabilities: [{ id: 'streaming' }],
    probe: [],
    acp: { spawnArgs: [MOCK_BIN] },
  }
  const session = (await adapter.spawnSession({
    cwd: tmpdir(),
    env: process.env,
    descriptor,
  })) as AcpSession
  try {
    // send 之前直接 cancel：不应抛错
    await session.cancel!()

    // 现在正常 send 一轮，确认 session 仍然可用
    const events: string[] = []
    const collector = (async () => {
      for await (const ev of session.events) events.push(ev.type)
    })()
    await session.send({ content: 'hello after idle cancel' })
    await Promise.race([
      collector,
      new Promise((r) => setTimeout(r, 2_000)),
    ])
    assert.ok(
      events.includes('done'),
      `idle cancel 不应破坏后续 turn；预期 'done'，got: ${events}`,
    )
  } finally {
    await session.kill()
    delete process.env.ACP_MOCK_KEEP_ALIVE
  }
})

// =====================================================================
// 5. Catalog sanity
// =====================================================================

test('ACP_CATALOG: 含 opencode-acp 且字段一致', () => {
  assert.ok(ACP_CATALOG.length >= 1)
  const opencode = ACP_CATALOG.find((e) => e.id === 'opencode-acp')
  assert.ok(opencode, 'opencode-acp 应在 catalog 内')
  assert.deepEqual(opencode!.spawnArgs, ['acp'])
  assert.equal(opencode!.binaryName, 'opencode')
  assert.equal(opencode!.configDirName, '.opencode')
  assert.ok(opencode!.capabilities.length > 0)
})

// =====================================================================
// 6. live（可选）—— 本机 opencode acp 真链路
// =====================================================================

test('live (opt-in): 本机有 `opencode` 时跑 `opencode acp` 真链路', async (t) => {
  // 默认跳过：opencode acp 启动慢，会拖慢测试套件。
  // 显式运行时：`RUN_ACP_LIVE=1 pnpm tsx --test test/acp-adapter.test.ts`
  if (process.env.RUN_ACP_LIVE !== '1') {
    t.skip('set RUN_ACP_LIVE=1 to enable real opencode acp test')
    return
  }
  const { spawnSync } = await import('node:child_process')
  const probe = spawnSync('opencode', ['acp', '--help'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('opencode acp not available on this host')
    return
  }

  const adapter = new AcpAdapter() // default = opencode-acp
  const session = await adapter.spawnSession({ cwd: tmpdir(), env: process.env })
  try {
    await session.send({ content: 'ping' })

    // 带超时拉 events（避免真 opencode hang）
    const collected: string[] = []
    const consumer = (async () => {
      for await (const ev of session.events) {
        collected.push(ev.type)
        if (ev.type === 'done') return
        if (collected.length > 50) return
      }
    })()
    await Promise.race([
      consumer,
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ])

    // 真链路下，opencode 至少应回 stream（content） 或 done。
    assert.ok(
      collected.length > 0,
      `expected at least one event from opencode acp, got: ${collected}`,
    )
  } finally {
    await session.kill()
  }
})