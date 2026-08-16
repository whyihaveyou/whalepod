/**
 * cancel ⑦ E2E 共享装配基座（docs/cancel-e2e-plan.md §6 ⑦a）。
 *
 * 与 src/plugin.ts 同构的手工装配（同一批服务类、同一构造顺序），目的：
 * 拿到 apply() 内部隐藏的 FactStore 句柄（loop 的 appendFact 依赖需要真实落盘），
 * 并注册 E2E fixture 后端（ACP mock 真子进程 / native 模拟注册表 / stdio 脚本化会话）。
 *
 * 铁律容器（方案 §6）：
 * - poll/waiter 同步原语（waitFor/wsTap.next），严禁 sleep 猜时序；
 * - 断言钩子一律显式超时失败（labelled），无穷等待禁止；
 * - 全经 REST/WS 面驱动业务动作；装配层观察点仅读副作用计数
 *   （fake agent cancelCalls、观察帧），不回看私有字段。
 */
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FactStore } from '../../src/persistence/store'
import { JsonlFactBackend } from '../../src/persistence/jsonl'
import { resolveHoneycombConfig } from '../../src/config'
import { RuntimeRegistry } from '../../src/runtime/registry'
import { AgentSessionRuntime } from '../../src/runtime/agent-runtime'
import { createNativeRuntime } from '../../src/runtime/native-runtime'
import { HoneycombLedgerService } from '../../src/services/ledger'
import { HoneycombCourierService } from '../../src/services/courier'
import { HoneycombMandateService } from '../../src/services/mandate'
import { HoneycombRosterService } from '../../src/services/roster'
import { HoneycombHiveService } from '../../src/services/hive'
import { createOrchestrationLoop, type OrchestrationLoop } from '../../src/consumer/orchestration-loop'
import { createNodeTransportServer } from '../../src/transport/server'
import { AcpAdapter } from '../../src/connectors/adapters/acp'
import type { AgentAdapter, AgentSession } from '../../src/connectors/adapter'
import type { AgentDescriptor } from '../../src/connectors/types'
import type { TaskId } from '../../src/types'

export type Frame = { type: string; data?: unknown }

/** WS 任务帧载荷解包：真实形状为 {task:{...}}（部分路径可能直挂字段）——pred/断言统一走此。 */
export function digTask(data: unknown): { id?: string; status?: string; owner?: string; updatedAt?: number } {
  const d = data as Record<string, unknown> | undefined
  const inner = (d?.task ?? d) as Record<string, unknown> | undefined
  return (inner ?? {}) as { id?: string; status?: string; owner?: string; updatedAt?: number }
}

export interface ScriptedSession extends AgentSession {
  /** 装配层观察点：send 进入次数（= 真实派工到达会话层的证据）。 */
  readonly sendCount: number
  /** 脚本化完成在途 prompt：enqueue done(exitCode) 并放行 send。 */
  finish(exitCode?: number): void
}

/** 可脚本化的无 cancel 会话：send 挂起直到 finish()/close()，事件由脚本注入。 */
export class ScriptedNoCancelSession implements ScriptedSession {
  readonly sessionId = 'scripted-stdio'
  private readonly queue: Array<{ type: string } & Record<string, unknown>> = []
  private waiters: Array<() => void> = []
  private ended = false
  private releaseSend: (() => void) | undefined
  private sendN = 0
  private closeN = 0

  get sendCount(): number {
    return this.sendN
  }

  get closedCount(): number {
    return this.closeN
  }

  private enqueue(event: { type: string } & Record<string, unknown>): void {
    if (this.ended) return
    this.queue.push(event)
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  readonly events: AsyncIterable<{ type: string } & Record<string, unknown>> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<{ type: string } & Record<string, unknown>>> => {
        while (this.queue.length === 0 && !this.ended) await new Promise<void>((r) => this.waiters.push(r))
        const value = this.queue.shift()
        if (!value) return { done: true, value: undefined }
        return { done: false, value }
      },
    }),
  }

  async send(): Promise<void> {
    this.sendN += 1
    // 在途挂起：直到 finish()/close() 放行——模拟长 prompt。
    await new Promise<void>((r) => {
      this.releaseSend = r
    })
  }

  finish(exitCode = 0): void {
    this.enqueue({ type: 'done', exitCode })
    this.releaseSend?.()
    this.releaseSend = undefined
  }

  async close(): Promise<void> {
    // 降级路径脚本（方案 §2.2）：close() → done(exitCode 143)，协议无 cancelled 事件。
    this.closeN += 1
    this.enqueue({ type: 'done', exitCode: 143 })
    this.releaseSend?.()
    this.releaseSend = undefined
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  async kill(): Promise<void> {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter()
  }
}

export function scriptedNoCancelAdapter(session: ScriptedNoCancelSession): AgentAdapter {
  return {
    id: 'fixture-stdio',
    displayName: 'Fixture stdio (no cancel)',
    capabilities: [],
    async detect() {
      return null
    },
    async spawnSession() {
      return session as unknown as AgentSession
    },
    validate() {
      return null
    },
  } as unknown as AgentAdapter
}

const MOCK_BIN = fileURLToPath(new URL('../fixtures/acp-mock-agent.mjs', import.meta.url))

export function acpFixtureAdapterEntry(extraEnv: Record<string, string>): { adapter: AgentAdapter; descriptor: AgentDescriptor } {
  const adapter = new AcpAdapter({
    id: 'fixture-acp',
    displayName: 'Fixture ACP agent',
    kind: 'opencode',
    binaryName: 'node',
    spawnArgs: [MOCK_BIN],
    configDirName: '.fixture-acp-e2e',
    capabilities: [{ id: 'streaming' }],
  })
  const descriptor: AgentDescriptor = {
    id: 'fixture-acp',
    displayName: 'Fixture ACP agent',
    kind: 'opencode',
    binPath: process.execPath,
    confidence: 'high',
    capabilities: [{ id: 'streaming' }],
    probe: [],
    acp: { spawnArgs: [MOCK_BIN] },
  }
  return { adapter: adapter as unknown as AgentAdapter, descriptor }
}

export interface E2EBootOptions {
  /** 装配 cancel orchestration 并挂进 transport（REST 层所需）；false → cancel 全 503。 */
  orchestration?: boolean
  /** 看门狗快超时（默认 700ms）；场景 A 用 2.5× 静默窗断言 A7。 */
  dispatchTimeoutMs?: number
  /** 注册 fixture-acp 连接器后端 + 注入 mock 进程 env。 */
  acpFixtureEnv?: Record<string, string>
  /** 追加连接器 adapter（如 fixture-stdio 脚本会话）。 */
  extraAdapters?: AgentAdapter[]
  /** 注册 native 后端 + 装配 ctx.agents 模拟注册表（⑤ 驱动法）。 */
  nativeAgentsRegistry?: unknown
}

export interface WsTap {
  readonly frames: Frame[]
  next(type: string, pred?: (data: unknown) => boolean, timeoutMs?: number): Promise<Frame>
  close(): void
}

export interface E2EBoot {
  readonly ctx: Context
  readonly store: FactStore
  readonly ledger: HoneycombLedgerService
  readonly roster: HoneycombRosterService
  readonly runtimes: RuntimeRegistry
  readonly loop: OrchestrationLoop | undefined
  readonly persistenceDir: string
  readonly port: number
  readonly hiveId: string
  readonly memberStatuses: Array<{ hiveId: string; memberId: string; status: string }>
  readonly memberWorkStates: Array<{ hiveId: string; memberId: string; state: string }>
  readonly hatchedMemberIds: readonly string[]
  post(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  patch(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  get(path: string): Promise<{ status: number; body: Record<string, unknown> }>
  wsFacts(): Promise<WsTap>
  /** 读 jsonl 落盘事实行（A6 证据源）；{seq,at,hiveId,fact:{...}} 完整封装行。 */
  factRows(): Array<Record<string, unknown>>
  countFact(type: string): number
  /** 解包后的事实载荷（row.fact）。 */
  factPayloads(type: string): Array<Record<string, unknown>>
  /** 解散已 hatch 成员（dispose 会话/子进程）并关 transport。 */
  close(): Promise<void>
}

export async function waitFor<T>(probe: () => T | false | null | undefined | Promise<T | false | null | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) assert.fail(`timeout waiting for ${label} after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

export async function bootE2ECancel(options: E2EBootOptions = {}): Promise<E2EBoot> {
  const persistenceDir = mkdtempSync(join(tmpdir(), 'honeycomb-cancel-e2e-'))
  const resolved = resolveHoneycombConfig({ persistenceDir })
  const store = new FactStore(new JsonlFactBackend({ dir: persistenceDir }))
  await store.load()
  const ctx = new Context()
  const runtimes = new RuntimeRegistry()
  // 与 src/plugin.ts apply() 同构装配：Service 子类构造即自注册（super(ctx, name)）。
  const ledger = new HoneycombLedgerService(ctx, store)
  const courier = new HoneycombCourierService(ctx, store)
  const mandate = new HoneycombMandateService(ctx, store, resolved)
  const roster = new HoneycombRosterService(ctx, store, runtimes)
  const hive = new HoneycombHiveService(ctx, store, roster, resolved)
  void hive

  const memberStatuses: E2EBoot['memberStatuses'] = []
  const memberWorkStates: E2EBoot['memberWorkStates'] = []
  ctx.on('member/status', (p) => memberStatuses.push(p as { hiveId: string; memberId: string; status: string }))
  ctx.on('member/work-state', (p) => memberWorkStates.push(p as { hiveId: string; memberId: string; state: string }))

  const adapters = new Map<string, { adapter: AgentAdapter; descriptor?: AgentDescriptor; extraEnv?: Record<string, string> }>()
  if (options.acpFixtureEnv) {
    const entry = acpFixtureAdapterEntry(options.acpFixtureEnv)
    adapters.set('fixture-acp', { ...entry, extraEnv: options.acpFixtureEnv })
  }
  for (const adapter of options.extraAdapters ?? []) adapters.set(adapter.id, { adapter })

  if (adapters.size > 0) {
    const connectorRuntime = new AgentSessionRuntime({
      resolveAdapter: (connectorId) => {
        const entry = adapters.get(connectorId)
        if (!entry) throw new Error(`e2e fixture: unknown connector '${connectorId}'`)
        return entry.adapter
      },
      createSession: (adapter, config) => {
        const entry = [...adapters.values()].find((candidate) => candidate.adapter === adapter)
        return adapter.spawnSession({
          cwd: config.cwd ?? tmpdir(),
          env: { ...process.env, ...entry?.extraEnv },
          descriptor: entry?.descriptor,
        })
      },
    })
    await roster.registerRuntime(connectorRuntime)
  }
  if (options.nativeAgentsRegistry) {
    await roster.registerRuntime(createNativeRuntime())
    ;(ctx as unknown as { agents: unknown }).agents = options.nativeAgentsRegistry
  }

  const withOrchestration = options.orchestration ?? true
  let loop: OrchestrationLoop | undefined
  if (withOrchestration) {
    loop = createOrchestrationLoop({
      ctx,
      roster,
      ledger,
      // 当前 applyTask 签名：(hiveId, {taskId, status?, owner?: string|null})。
      // 归一化纪律：owner 键按「在不在」区分——缺席=不动 owner；null→undefined=清空
      // （fold 为 Object.assign，键在才会清；null 值会破坏 facts/snapshot 一致性）。
      applyTask: (_hiveId, patch) =>
        ledger.update(patch.taskId as TaskId, {
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.owner === undefined ? {} : { owner: patch.owner === null ? undefined : patch.owner }),
        } as Parameters<HoneycombLedgerService['update']>[1]),
      appendFact: (hiveId, fact) => store.append(hiveId, fact as never),
      config: {
        dispatchTimeoutMs: options.dispatchTimeoutMs ?? 700,
        maxDispatchAttempts: 1,
        idleTimeoutMs: 0,
      },
    })
  }

  const server = await createNodeTransportServer(ctx, {
    host: '127.0.0.1',
    port: 0,
    transport: withOrchestration ? { orchestration: loop } : {},
  })
  const port = server.port

  const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  const hiveRes = await request('POST', '/v1/hives', { name: 'cancel-e2e' })
  assert.equal(hiveRes.status, 200, `create hive should be 200, got ${hiveRes.status}: ${JSON.stringify(hiveRes.body)}`)
  const hiveId = (hiveRes.body.data as { id: string }).id
  if (loop) loop.start([hiveId])

  const hatchedMemberIds: string[] = []

  const boot: E2EBoot = {
    ctx,
    store,
    ledger,
    roster,
    runtimes,
    loop,
    persistenceDir,
    port,
    hiveId,
    memberStatuses,
    memberWorkStates,
    hatchedMemberIds,
    async post(path, body) {
      const res = await request('POST', path, body)
      if (path.endsWith('/members/hatch') && res.status === 200) hatchedMemberIds.push((res.body.data as { id: string }).id)
      return res
    },
    patch: (path, body) => request('PATCH', path, body),
    get: (path) => request('GET', path),
    async wsFacts(): Promise<WsTap> {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      const buffered: Frame[] = []
      const waiters: Array<{
        type: string
        pred?: (data: unknown) => boolean
        resolve: (frame: Frame) => void
        reject: (err: Error) => void
        timer: NodeJS.Timeout
      }> = []
      // 载荷归一化：事实帧载体在 frame.data；控帧（subscribed 等）字段在顶层——pred 收到 data ?? frame。
      const payloadOf = (frame: Frame): unknown => (frame.data === undefined ? (frame as unknown) : frame.data)
      const deliver = (frame: Frame): boolean => {
        const i = waiters.findIndex((w) => w.type === frame.type && (!w.pred || w.pred(payloadOf(frame))))
        if (i < 0) return false
        const [w] = waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.resolve(frame)
        return true
      }
      ws.addEventListener('message', (event) => {
        // 帧归一化：业务帧为 {type:'event', topic:'task/updated', payload:{...}}
        // （→ Frame{type:topic, data:payload}）；控帧 {type:'subscribed', ...} 原样保留。
        const raw = JSON.parse(String(event.data)) as { type?: string; topic?: string; payload?: unknown }
        const frame: Frame =
          raw.type === 'event' && typeof raw.topic === 'string'
            ? { type: raw.topic, data: raw.payload }
            : (raw as unknown as Frame)
        if (!deliver(frame)) buffered.push(frame)
      })
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true })
        ws.addEventListener('error', () => reject(new Error('wsFacts: socket error before open')), { once: true })
      })
      ws.send(JSON.stringify({ type: 'subscribe', hiveId }))
      const tap: WsTap = {
        frames: buffered,
        next(type, pred, timeoutMs = 4000) {
          const i = buffered.findIndex((f) => f.type === type && (!pred || pred(payloadOf(f))))
          if (i >= 0) {
            const [frame] = buffered.splice(i, 1)
            return Promise.resolve(frame)
          }
          return new Promise<Frame>((resolve, reject) => {
            const entry = {
              type,
              pred,
              resolve,
              reject,
              timer: undefined as unknown as NodeJS.Timeout,
            }
            entry.timer = setTimeout(() => {
              const j = waiters.indexOf(entry)
              if (j >= 0) waiters.splice(j, 1)
              reject(new Error(`timeout waiting for ws frame '${type}' after ${timeoutMs}ms; buffered: ${JSON.stringify(buffered)}`))
            }, timeoutMs)
            waiters.push(entry)
          })
        },
        close() {
          for (const w of waiters.splice(0)) {
            clearTimeout(w.timer)
            w.reject(new Error('wsFacts: closed'))
          }
          ws.close()
        },
      }
      // 显式等 subscribe ack（ack 载荷带 hiveId），保证后续触发动作不丢帧。
      await tap.next('subscribed', (d) => (d as { hiveId?: string }).hiveId === hiveId, 4000)
      return tap
    },
    factRows() {
      // 真实落盘布局：${persistenceDir}/${hiveId}/facts.ndjson（验证见 ⑦ 调试基线）——递归两层扫。
      const rows: Array<Record<string, unknown>> = []
      const scan = (dir: string, depth: number): void => {
        if (depth < 0) return
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            scan(full, depth - 1)
          } else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.ndjson')) {
            for (const line of readFileSync(full, 'utf8').split('\n')) {
              if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>)
            }
          }
        }
      }
      scan(persistenceDir, 2)
      return rows
    },
    countFact(type) {
      return boot.factRows().filter((row) => (row.fact ?? row).type === type).length
    },
    factPayloads(type) {
      return boot
        .factRows()
        .map((row) => (row.fact ?? row) as Record<string, unknown>)
        .filter((fact) => fact.type === type)
    },
    async close() {
      for (const id of hatchedMemberIds.splice(0)) {
        await roster.dismiss(hiveId, id).catch(() => undefined)
      }
      await server.close()
    },
  }
  return boot
}
