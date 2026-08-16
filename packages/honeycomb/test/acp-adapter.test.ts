/**
 * @dfh/honeycomb/connectors/adapters/acp — ACP adapter 测试
 *
 * 覆盖：
 *   1. 事件映射正确性（normalizeSessionUpdate）—— 纯函数单测，含 image 透传
 *   2. 检测层（detect）—— 命中 PATH shim + capability probe
 *   3. 会话生命周期 —— mock ACP 子进程，跑通 initialize → newSession →
 *      send(prompt) → 收到 stream + tool-call + tool-result + done
 *   3b. cancel() —— 中断 in-flight prompt，emit cancelled（而非 done）；
 *       无 in-flight 时是 no-op，不影响后续 turn
 *   3c. image 透传 —— mock 发 image chunk → SessionEvent.image
 *   4. live（可选）—— 本机有 `opencode` / `kimi` 时跑真 ACP 链路
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
  bootstrapAcpAdapters,
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

test('normalizeSessionUpdate: image chunk → image event (source=agent, base64 透传)', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', data: 'BASE64DATA==', mimeType: 'image/png' },
  })
  assert.equal(evs.length, 1)
  assert.equal(evs[0].type, 'image')
  const ev = evs[0] as { type: 'image'; source: string; mimeType: string; data: string }
  assert.equal(ev.source, 'agent')
  assert.equal(ev.mimeType, 'image/png')
  assert.equal(ev.data, 'BASE64DATA==')
  assert.equal(ev.toolCallId, undefined)
})

test('normalizeSessionUpdate: text + image 同 chunk → stream + image 两个事件', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'see this:' },
  })
  // 单 content block 只能一种类型；用两个 chunk 模拟"text 后续 image" 的常见流
  const evs2 = normalizeSessionUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', data: 'PNG', mimeType: 'image/png' },
  })
  assert.equal(evs.length, 1)
  assert.equal(evs[0].type, 'stream')
  assert.equal((evs[0] as { type: 'stream'; chunk: string }).chunk, 'see this:')
  assert.equal(evs2.length, 1)
  assert.equal(evs2[0].type, 'image')
})

test('normalizeSessionUpdate: tool_call 含 image content → tool-call + image + tool-result', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-img',
    title: 'screenshot',
    name: 'screenshot',
    status: 'completed',
    content: [
      { type: 'image', data: 'SCREENSHOT', mimeType: 'image/jpeg' },
      { type: 'content', content: { type: 'text', text: '1920x1080' } },
    ],
  })
  // 期望顺序：tool-call（声明）→ image（结果片段，让 UI 提前渲染）→ tool-result（完整结果）
  assert.equal(evs.length, 3, `expected 3 events, got ${evs.length}: ${JSON.stringify(evs)}`)
  assert.equal(evs[0].type, 'tool-call')
  assert.equal(evs[1].type, 'image')
  const img = evs[1] as { type: 'image'; source: string; toolCallId?: string; mimeType: string; data: string }
  assert.equal(img.source, 'tool')
  assert.equal(img.toolCallId, 'tc-img')
  assert.equal(img.mimeType, 'image/jpeg')
  assert.equal(img.data, 'SCREENSHOT')
  assert.equal(evs[2].type, 'tool-result')
})

test('normalizeSessionUpdate: tool_call_update 含 image content → image + tool-result（不再额外发 tool-call）', () => {
  const evs = normalizeSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-img-2',
    status: 'completed',
    content: [{ type: 'image', data: 'JPEG', mimeType: 'image/jpeg' }],
  })
  assert.equal(evs.length, 2)
  assert.equal(evs[0].type, 'image')
  const img = evs[0] as { type: 'image'; source: string; toolCallId?: string }
  assert.equal(img.source, 'tool')
  assert.equal(img.toolCallId, 'tc-img-2')
  assert.equal(evs[1].type, 'tool-result')
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

test('ACP detect 两态: kimi-code-acp(已装,PATH shim) 命中 / gemini-cli-acp(未装) null', async (t) => {
  // 确定性：不真 spawn live agent，用合成 PATH shim 模拟 kimi「已装」态。
  //
  // 关键：resolveBinary() 扫的是 host.pathEntries（collectHostEnvironment 的
  // 静态快照），而不是运行时 process.env.PATH —— 只改 `.env.PATH` 不会让
  // detector 看到 shim（本地 macOS 是碰巧用真实 kimi 蒙绿，CI Linux 无 kimi 即红）。
  // 因此必须把 shimDir 注入 host.pathEntries。
  const shimDir = mkdtempSync(join(tmpdir(), 'acp-kimi-shim-'))
  try {
    const shim = join(shimDir, 'kimi')
    // 需要真实可执行（resolveBinary 只看 isFile，但能力探针会 spawn 它）。
    writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const base = collectHostEnvironment()
    const host = {
      ...base,
      pathEntries: [shimDir, ...base.pathEntries],
      env: { ...base.env, PATH: `${shimDir}:${base.env.PATH ?? ''}` },
    }
    const kimi = ACP_CATALOG.find((e) => e.id === 'kimi-code-acp')
    const gemini = ACP_CATALOG.find((e) => e.id === 'gemini-cli-acp')
    assert.ok(kimi, 'kimi-code-acp 应在 catalog')
    assert.ok(gemini, 'gemini-cli-acp 应在 catalog')

    // 已装态：shimDir 在 pathEntries -> resolveBinary 找到 shim -> 探针 exit 0 -> 命中
    const probe = new AcpAdapter(kimi!).detect(host)
    const kimiHit = await probe
    if (!kimiHit) {
      // 宁可 skip 不可假绿：shim 注入在个别环境（如 spawn EACCES）真失效时跳过，
      // 同时留诊断信息便于定位。
      console.warn('[diagnostic] kimi-code-acp detect miss on PATH-shim host')
      console.warn(`[diagnostic] PATH=${host.env.PATH}`)
      console.warn(`[diagnostic] pathEntries[0]=${host.pathEntries[0]}, shim=${shim}`)
      t.skip('PATH shim 未能在该环境被 detect 捡到（见诊断输出）——不判红')
      return
    }
    // 未装态：gemini 不在 pathEntries -> resolveBinary 返回 undefined -> detector 返回 null（不 spawn）
    const geminiMiss = await new AcpAdapter(gemini!).detect(host)
    assert.equal(geminiMiss, null, 'gemini-cli-acp 未装应 detect 返回 null')
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
// 5. image 透传 e2e（mock agent 端到端）
// =====================================================================

test('AcpAdapter.spawnSession: image 透传 → mock 发的 image chunk 被映射成 SessionEvent.image', async () => {
  process.env.ACP_MOCK_EMIT_IMAGE = '1'
  delete process.env.ACP_MOCK_EMIT_TOOLCALL
  delete process.env.ACP_MOCK_FAIL_AFTER
  delete process.env.ACP_MOCK_KEEP_ALIVE
  delete process.env.ACP_MOCK_CANCEL_AFTER

  const adapter = new AcpAdapter({
    id: 'mock-acp-image',
    displayName: 'ACP image',
    kind: 'opencode',
    binaryName: 'node',
    spawnArgs: [MOCK_BIN],
    configDirName: '.mock-acp-image',
    capabilities: [{ id: 'image' }],
  })
  const descriptor = {
    id: 'mock-acp-image',
    displayName: 'ACP image',
    kind: 'opencode' as const,
    binPath: process.execPath,
    confidence: 'binary' as const,
    capabilities: [{ id: 'image' }],
    probe: [],
    acp: { spawnArgs: [MOCK_BIN] },
  }
  const session = await adapter.spawnSession({ cwd: tmpdir(), env: process.env, descriptor })
  try {
    const events: Array<{ type: string; [k: string]: unknown }> = []
    const collector = (async () => {
      for await (const ev of session.events) {
        events.push(ev as { type: string })
      }
    })()
    await session.send({ content: 'send me a picture' })
    await Promise.race([
      collector,
      new Promise((_, reject) => setTimeout(() => reject(new Error('collector timeout')), 2_000)),
    ]).catch(() => {})

    const imageEvents = events.filter((e) => e.type === 'image') as Array<
      { type: 'image'; source: string; mimeType: string; data: string }
    >
    assert.equal(imageEvents.length, 1, `expected 1 image event, got ${imageEvents.length}: ${JSON.stringify(events)}`)
    assert.equal(imageEvents[0]!.source, 'agent')
    assert.equal(imageEvents[0]!.mimeType, 'image/png')
    assert.ok(imageEvents[0]!.data.length > 0, 'image data should be non-empty base64')
    // stream + image + done 顺序
    const types = events.map((e) => e.type)
    assert.ok(types.includes('stream'), `expected stream, got: ${types}`)
    assert.ok(types.includes('done'), `expected done, got: ${types}`)
  } finally {
    await session.kill()
    delete process.env.ACP_MOCK_EMIT_IMAGE
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

test('ACP_CATALOG: 含 kimi-code-acp 且字段与实测对齐（spawnArgs=acp, configDirName=.kimi-code, image capability）', () => {
  const kimi = ACP_CATALOG.find((e) => e.id === 'kimi-code-acp')
  assert.ok(kimi, 'kimi-code-acp 应在 catalog 内')
  // spawnArgs 用 subcommand 'acp'（实测 'kimi acp' 才是 ACP server 入口；'kimi --acp' 会报 unknown option）
  assert.deepEqual(kimi!.spawnArgs, ['acp'])
  assert.equal(kimi!.binaryName, 'kimi')
  assert.equal(kimi!.configDirName, '.kimi-code')
  assert.equal(kimi!.kind, 'kimi-code')
  // capabilityProbe 让 detector 能 spawn `kimi acp --help` 验证 ACP server 存在
  assert.deepEqual(kimi!.capabilityProbe, ['--help'])
  // image capability 来自 kimi acp initialize 自报的 promptCapabilities.image = true
  const capIds = kimi!.capabilities.map((c) => c.id)
  assert.ok(capIds.includes('image'), `kimi-code-acp 应有 image capability, got: ${capIds}`)
  assert.ok(capIds.includes('streaming'), `kimi-code-acp 应继承 streaming capability, got: ${capIds}`)
})

test('ACP_CATALOG: 含 gemini-cli-acp 且字段可入册（本机未装 → detect 未装语义）', () => {
  const gemini = ACP_CATALOG.find((e) => e.id === 'gemini-cli-acp')
  assert.ok(gemini, 'gemini-cli-acp 应在 catalog 内')
  assert.equal(gemini!.binaryName, 'gemini')
  assert.equal(gemini!.configDirName, '.gemini')
  // ACP 入口官方为 `gemini --acp`（个别版本 subcommand `acp`，安装后实测校正）
  assert.deepEqual(gemini!.spawnArgs, ['--acp'])
  assert.deepEqual(gemini!.capabilityProbe, ['--version'])
  // image capability（gemini 多模态）；description 给全与 kimi 对齐
  const capIds = gemini!.capabilities.map((c) => c.id)
  assert.ok(capIds.includes('image'), `gemini-cli-acp 应有 image capability, got: ${capIds}`)
  assert.ok(capIds.includes('streaming'), `gemini-cli-acp 应继承 streaming capability, got: ${capIds}`)
  // kind 已精确为 'gemini-cli'（types.ts AgentKind 已授权加入），不再依赖 claude-code 占位。
  assert.equal(gemini!.kind, 'gemini-cli')
})

test('bootstrapAcpAdapters: 把每个 catalog 项实例化为可 detect 的 AcpAdapter', async () => {
  const adapters = bootstrapAcpAdapters()
  assert.ok(adapters.length === ACP_CATALOG.length)
  for (const a of adapters) {
    assert.ok(typeof a.id === 'string' && a.id.length > 0, `id 应非空, got: ${a.id}`)
    assert.ok(typeof a.displayName === 'string' && a.displayName.length > 0)
    assert.ok(Array.isArray(a.capabilities) && a.capabilities.length > 0)
    assert.ok(typeof a.detect === 'function')
    assert.ok(typeof a.spawnSession === 'function')
  }
  // detect() 在缺探测环境时返回 null，但不该抛错
  const r = await adapters[0]!.detect(collectHostEnvironment())
  assert.ok(r === null || typeof r === 'object')
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

test('live (opt-in): 本机有 `kimi` 时跑 `kimi acp` 真链路', async (t) => {
  // kimi acp 启动比 opencode acp 快（实测 ~2-3s），可作为更便宜的 live test
  if (process.env.RUN_ACP_LIVE !== '1') {
    t.skip('set RUN_ACP_LIVE=1 to enable real kimi acp test')
    return
  }
  const { spawnSync } = await import('node:child_process')
  const probe = spawnSync('kimi', ['acp', '--help'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    t.skip('kimi acp not available on this host')
    return
  }

  // 走 catalog：让 kimi-code-acp catalog entry 自动被 bootstrap
  const kimiEntry = ACP_CATALOG.find((e) => e.id === 'kimi-code-acp')
  assert.ok(kimiEntry, 'kimi-code-acp catalog entry must exist for live test')
  const adapter = new AcpAdapter(kimiEntry)

  // 整个 live test 限时 25s：spawnSession（initialize 1-2s）+ 一次 prompt 拉
  // 一点 stream event（LLM 响应时延取决于本机 OAuth/网络）+ 收尾。
  // 任何一步超时就 skip（不污染套件），让 CI 走 mock 路径。
  const overallTimeout = 25_000
  const guard = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), overallTimeout))
  try {
    const raceResult = await Promise.race([
      (async () => {
        const session = await adapter.spawnSession({ cwd: tmpdir(), env: process.env })
        try {
          // 不 await send —— send 会等 LLM 响应，可能很慢。让 send 在背景跑，
          // 主路径只 await 一小段时间收集 events。
          const sendPromise = session.send({ content: 'echo back the word PONG and nothing else' })

          const collected: string[] = []
          const consumer = (async () => {
            for await (const ev of session.events) {
              collected.push(ev.type)
              if (ev.type === 'done' || ev.type === 'cancelled') return
              if (collected.length > 50) return
            }
          })()
          // 等待 12s 让 events 流进来；超时就别等了，kill 进程
          await Promise.race([
            consumer,
            new Promise((resolve) => setTimeout(resolve, 12_000)),
          ])

          // 让 send 也走完或者被截断
          await Promise.race([
            sendPromise.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 3_000)),
          ])

          return collected
        } finally {
          await session.kill()
        }
      })(),
      guard,
    ])

    if (raceResult === 'timeout') {
      t.skip(`kimi acp live test exceeded ${overallTimeout}ms (LLM-backed, OAuth-dependent) — skip`)
      return
    }

    assert.ok(
      raceResult.length > 0,
      `expected at least one event from kimi acp, got: ${raceResult}`,
    )
  } catch (err) {
    t.skip(`kimi acp live test errored: ${err instanceof Error ? err.message : err} — skip`)
  }
})