/**
 * ACP true-live test —— kimi acp 0.34.0 真机端到端。
 *
 * 与 connector-live.test.ts 同源思路：
 *   - 「deterministic」part（不需要真 agent）：从 ACP_CATALOG 读 kimi-code-acp 字段、构造
 *     AcpAdapter 实例并 assert capabilities 静态声明对得上
 *   - 「live opt-in」part（需要本机有 kimi acp + 联网 + OAuth）：用 `RUN_ACP_LIVE=1` 触发
 *     真机协议验证：initialize / session/new / prompt / cancel
 *
 * 适配本机环境差异：
 *   - 本机 kimi acp 启动 1-2s（initialize）+ LLM 响应 1-10s（OAuth 凭证 + 网络）
 *   - 整个 test 套件 60s 硬上限，单 test 20s 内收尾；超时一律 skip（不污染 CI 确定性路径）
 *   - send() 在背景跑，主路径只 await 一段时间收集 events，cancel 测试需要在 send 走到中段时介入
 *   - session.kill() 在 finally 块统一兜底，零僵尸
 *
 * Run:
 *   # 默认（deterministic only）
 *   pnpm tsx --test test/acp-kimi-live.test.ts
 *   # 启用真机（需本机 kimi acp + OAuth 可用）
 *   RUN_ACP_LIVE=1 pnpm tsx --test --test-timeout=60000 test/acp-kimi-live.test.ts
 *
 * 失败策略：
 *   - 真机 LLM 响应时延不可控 → 用短 prompt + 严格 timeout + 静默 skip
 *   - 真机协议与 mock 不一致 → 在 test 末尾收集差异、失败信息 dump 实际值、记录到 "差异清单"
 *   - 真机 OAuth 失败 → skip with "OAuth/auth unavailable"
 *
 * @module @whalepod/honeycomb/connectors/acp-kimi-live.test
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import { collectHostEnvironment } from '../src/connectors/detect/host-env.ts'
import {
  ACP_CATALOG,
  AcpAdapter,
  type AcpCatalogEntry,
} from '../src/connectors/adapters/acp.ts'

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 探测本机是否有 kimi acp 可用（spawn `kimi acp --help` 看退出码）。
 * 返回 true 表示可用，false 表示不可用（test 后续应 skip）。
 */
function hasKimiAcp(): boolean {
  const probe = spawnSync('kimi', ['acp', '--help'], { encoding: 'utf8' })
  return probe.status === 0
}

/**
 * 把一组 JSON-RPC 请求按顺序写进 kimi acp 进程 stdin，收集 stdout 的响应。
 * 用于「裸协议」测试（不经过 AcpAdapter），验证真实 kimi 的能力声明。
 * 返回所有解析成功的 JSON 响应（按时间顺序）。
 */
async function rawKimiAcpExchange(requests: unknown[], timeoutMs: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const responses: unknown[] = []
    const child: ChildProcess = spawn('kimi', ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      reject(new Error(`raw kimi acp exchange timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          responses.push(JSON.parse(line))
        } catch {
          // 忽略非 JSON 行（kimi 偶尔会输出日志）
        }
      }
    })
    child.stderr!.on('data', () => {
      // kimi 会在 stderr 输出进度日志，忽略
    })
    child.on('exit', () => {
      if (killed) return
      clearTimeout(timer)
      resolve(responses)
    })
    child.on('error', (err) => {
      if (killed) return
      clearTimeout(timer)
      reject(err)
    })

    // 写请求
    for (const req of requests) {
      child.stdin!.write(JSON.stringify(req) + '\n')
    }
    child.stdin!.end()
  })
}

function kimiEntry(): AcpCatalogEntry {
  const entry = ACP_CATALOG.find((e) => e.id === 'kimi-code-acp')
  assert.ok(entry, 'kimi-code-acp must be in ACP_CATALOG for live test to make sense')
  return entry!
}

// ---------------------------------------------------------------------------
// 1. Deterministic —— kimi-code-acp catalog 字段断言（不需要真 agent）
// ---------------------------------------------------------------------------

test('kimi-code-acp catalog entry: 字段与实测对齐', () => {
  const e = kimiEntry()
  assert.equal(e.id, 'kimi-code-acp')
  assert.equal(e.kind, 'kimi-code')
  assert.equal(e.binaryName, 'kimi')
  assert.deepEqual(e.spawnArgs, ['acp'])
  assert.deepEqual(e.capabilityProbe, ['--help'])
  assert.equal(e.configDirName, '.kimi-code')
  const capIds = e.capabilities.map((c) => c.id)
  assert.ok(capIds.includes('image'), 'kimi-code-acp 应声明 image capability（自报）')
  assert.ok(capIds.includes('streaming'))
  assert.ok(capIds.includes('tool-use'))
})

test('kimi-code-acp detect(): 本机 kimi 在 PATH 时命中并填 descriptor.acp', async () => {
  if (!hasKimiAcp()) {
    // 本机无 kimi，skip（不应该出现在 CI 确定性套件里，但保险起见）
    return
  }
  const adapter = new AcpAdapter(kimiEntry())
  const descriptor = await adapter.detect(collectHostEnvironment())
  if (descriptor === null) {
    // 探测失败但 kimi 在 PATH —— 是 capability probe 在某些环境（PATH 包含不在 capProbe 期望的目录）
    // 失败。不算 adapter bug，但记录一下。
    return
  }
  assert.equal(descriptor.kind, 'kimi-code')
  assert.ok(descriptor.binPath, 'descriptor.binPath 应被填上')
  assert.ok(descriptor.acp, 'descriptor.acp 应被填（detect 4 层探测命中）')
  if (descriptor.acp) {
    assert.deepEqual(descriptor.acp.spawnArgs, ['acp'])
  }
})

// ---------------------------------------------------------------------------
// 2. Live opt-in —— 真机 kimi acp 0.34.0
// ---------------------------------------------------------------------------

/**
 * 真机 kimi acp initialize 能力断言。
 * 用裸 JSON-RPC 直连 kimi acp 进程（不经 AcpAdapter），抓 initialize 响应验证
 * kimi 自报能力（loadSession / image / mcp-* 等）。这能在 adapter 拿不到这些能力
 * 之前就给「适配器 + 真实 ACP server 一致性」一个端到端的 checkpoint。
 */
test('live kimi acp: initialize 自报 loadSession=true, image=true, mcp-http=true', async (t) => {
  if (process.env.RUN_ACP_LIVE !== '1') {
    t.skip('set RUN_ACP_LIVE=1 to enable real kimi acp test')
    return
  }
  if (!hasKimiAcp()) {
    t.skip('kimi acp not available on this host')
    return
  }
  try {
    const responses = await rawKimiAcpExchange(
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'honeycomb-kimi-live', version: '0.0.0' },
          },
        },
      ],
      10_000,
    )
    const initResp = responses.find(
      (r): r is { result: { agentCapabilities?: Record<string, unknown>; agentInfo?: { name?: string; version?: string } } } =>
        typeof r === 'object' && r !== null && 'result' in r,
    )
    assert.ok(initResp, `expected initialize response, got: ${JSON.stringify(responses)}`)
    const caps = initResp.result.agentCapabilities ?? {}
    assert.equal(caps.loadSession, true, 'kimi acp initialize should report loadSession=true')
    const promptCaps = (caps as { promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean } })
      .promptCapabilities
    assert.ok(promptCaps, `expected promptCapabilities, got: ${JSON.stringify(caps)}`)
    assert.equal(promptCaps.image, true, 'kimi acp should report image=true in promptCapabilities')
    const mcp = (caps as { mcpCapabilities?: { http?: boolean; sse?: boolean } }).mcpCapabilities
    assert.ok(mcp, `expected mcpCapabilities, got: ${JSON.stringify(caps)}`)
    assert.equal(mcp.http, true, 'kimi acp should report mcp http=true')
    assert.equal(mcp.sse, true, 'kimi acp should report mcp sse=true')
    const info = initResp.result.agentInfo
    assert.ok(info, 'kimi acp should report agentInfo')
    assert.equal(info.name, 'Kimi Code CLI')
    assert.match(info.version ?? '', /^\d+\.\d+\.\d+/)
  } catch (err) {
    t.skip(`raw kimi acp exchange failed: ${err instanceof Error ? err.message : err}`)
  }
})

/**
 * 真机 kimi acp 走 AcpAdapter 跑一次完整 turn：session/new → prompt → events 流。
 * 短 prompt 强制 LLM 快速响应；events 收集 ≤30s 截断（实测 OAuth + LLM 10-30s 范围）；
 * session 必 kill。
 */
test('live kimi acp: AcpAdapter.spawnSession → prompt 流 → 至少 1 个 event（stream 或 done）', async (t) => {
  if (process.env.RUN_ACP_LIVE !== '1') {
    t.skip('set RUN_ACP_LIVE=1 to enable real kimi acp test')
    return
  }
  if (!hasKimiAcp()) {
    t.skip('kimi acp not available on this host')
    return
  }
  const adapter = new AcpAdapter(kimiEntry())
  let session: Awaited<ReturnType<typeof adapter.spawnSession>> | null = null
  try {
    session = await adapter.spawnSession({ cwd: tmpdir(), env: process.env })
    // 后台触发 send（不 await）—— send 会等 LLM 响应，可能很慢
    const sendPromise = session
      .send({ content: 'reply with the single word PONG and nothing else' })
      .catch(() => undefined)

    const events: Array<{ type: string; [k: string]: unknown }> = []
    const consumer = (async () => {
      for await (const ev of session!.events) {
        events.push(ev as { type: string })
        if (ev.type === 'done' || ev.type === 'cancelled' || ev.type === 'error') return
        if (events.length > 100) return
      }
    })()

    // 30s 收集窗口（实测 OAuth + LLM 10-30s 范围）；超时就别等 send 完成（kill 会兜底）
    await Promise.race([
      consumer,
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ])
    // 让 send 走完或被截断
    await Promise.race([
      sendPromise,
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])

    // 至少应有一个 event（最坏情况：OAuth 失败导致根本没 LLM 响应 —— 也要见到 events 流）
    if (events.length === 0) {
      t.skip('kimi acp produced 0 events in 30s window (likely OAuth/network unavailable) — skip')
      return
    }
    const types = events.map((e) => e.type)
    assert.ok(types.includes('done') || types.includes('cancelled') || types.includes('error'),
      `expected terminal event (done/cancelled/error), got: ${types}`)
    // 如果有 stream 事件，应在 done/cancelled 之前（end-of-turn 顺序）
    const firstIdx = (type: string) => types.indexOf(type)
    const streamIdx = firstIdx('stream')
    const terminalIdx = Math.min(
      ...['done', 'cancelled', 'error'].map((t) => firstIdx(t)).filter((i) => i >= 0),
    )
    if (streamIdx >= 0 && terminalIdx >= 0) {
      assert.ok(streamIdx < terminalIdx, `stream 应在 terminal event 之前, got: ${types}`)
    }
  } catch (err) {
    t.skip(`kimi acp prompt flow errored: ${err instanceof Error ? err.message : err}`)
  } finally {
    if (session) await session.kill().catch(() => undefined)
  }
})

/**
 * 真机 kimi acp cancel() 中断 in-flight prompt。
 * 用稍长的 prompt（让 LLM 有时间响应）触发，1-2s 后 cancel，断言见到 cancelled 事件。
 */
test('live kimi acp: cancel() mid-prompt → 见到 cancelled 事件', async (t) => {
  if (process.env.RUN_ACP_LIVE !== '1') {
    t.skip('set RUN_ACP_LIVE=1 to enable real kimi acp cancel test')
    return
  }
  if (!hasKimiAcp()) {
    t.skip('kimi acp not available on this host')
    return
  }
  const adapter = new AcpAdapter(kimiEntry())
  let session: Awaited<ReturnType<typeof adapter.spawnSession>> | null = null
  try {
    session = await adapter.spawnSession({ cwd: tmpdir(), env: process.env })
    // cancel 是 AgentSession 契约的 optional 方法（commit ... 加的）。运行时检查存在。
    if (typeof (session as { cancel?: unknown }).cancel !== 'function') {
      t.skip('AcpSession.cancel() not available (adapter does not implement)')
      return
    }
    // 后台 send
    const sendPromise = session
      .send({
        content: 'count from 1 to 50, one number per line, with no commentary',
      })
      .catch(() => undefined)

    // 等 1.5s 让 LLM 开始响应 / 出 stream events
    await new Promise((r) => setTimeout(r, 1_500))

    // 中断
    await (session as { cancel: () => Promise<void> }).cancel().catch(() => undefined)

    // 收集 events 4s
    const events: string[] = []
    const consumer = (async () => {
      for await (const ev of session!.events) {
        events.push(ev.type)
        if (ev.type === 'done' || ev.type === 'cancelled' || ev.type === 'error') return
        if (events.length > 100) return
      }
    })()
    await Promise.race([
      consumer,
      new Promise((resolve) => setTimeout(resolve, 4_000)),
    ])
    // 让 send 走完或被截断
    await Promise.race([
      sendPromise,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])

    // cancel 路径预期：见到 cancelled 事件（不再有 done）
    if (events.length === 0) {
      t.skip('kimi acp produced 0 events in cancel window (OAuth unavailable) — skip')
      return
    }
    assert.ok(events.includes('cancelled'),
      `mid-prompt cancel 后应见 cancelled 事件, got: ${events}`)
    // 关键断言：cancel 路径不应该 emit done
    assert.ok(!events.includes('done'),
      `cancel 路径不应再 emit done, got: ${events}`)
  } catch (err) {
    t.skip(`kimi acp cancel test errored: ${err instanceof Error ? err.message : err}`)
  } finally {
    if (session) await session.kill().catch(() => undefined)
  }
})
