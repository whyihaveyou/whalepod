# WhalePod Agent 自动发现子系统设计（A2）——修订版

> 设计人：架构-Pro-1
> 日期：2026-08-17（修订：吸收 架构-Pro-2 源码+活库调研交接）
> 任务：#01a00fb5-af7a（A2，blocked_by A1）
> 依据：`docs/aionui-agent-discovery-research.md`（A1，真机实证）+ **架构-Pro-2 深挖交接**（`/Users/qzp/Desktop/aionui-research` v2.1.53 源码克隆 + `~/.aionui/aionui-backend.db` agent_metadata 表 + `aioncore doctor` 全表）；`docs/cli-agent-inventory.md`；`docs/acp-adapter.md`
> 交付对象：A3（实现 honeycomb agent-discovery 服务 + transport 端点）
> 阅读对象：A3 实现者、面板联调方、Swift 壳 owner（§5）

---

## 0. 目标与设计原则

把「本机有哪些可用的外部 CLI agent」从**人工/静态**变成**自动发现 + 一键编入团队**，与 AionUi 的 aioncore catalog 对标但落在 WhalePod/honeycomb 现有分层内。

**三条设计铁律（Leader 指定）：**
- **铁律 ①：discovered ≠ available，两个状态位强制分离。** 现有 `AgentDescriptor.detect()` 返回 `null` 即「无」，把「装了但合不上手」与「没装」混为一谈（codex-403 / kimi-超时是活例）。
- **铁律 ②：版本/能力不符 → 能力降级，不是硬失败。**
- **铁律 ③：PATH 继承坑（Bug#2 同源），给出明确解法。**

**复用基调**：现有 `connectors/` 的 `Detector` + `ACP_CATALOG` + `AcpAdapter` + `registry` 就是 AionUi「catalog + PATH 解析 + ACP 握手」的直接对应物。A2 在其上加一层「发现态」，接通 roster「编入团队」。

---

## 1. 探测链设计（吸取架构-Pro-2 两级探测）

### 1.1 现状与缺口（对照现有 Detector）

现有 `connectors/detect/detector.ts` 三层探测：
```
L0 path   : resolveBinary(binaryName, host) → binPath（PATH 扫描，host-env.ts 已 which 级解析）
L1 version: 子进程 --version → 解析 version + 能力
L2 config : configDir(home, dirName) 存在性（如 ~/.codex/auth.json）
L3 acp    : AcpAdapter spec 有 capabilityProbe / acp.spawnArgs，但 validate() 只是 !!binPath&&!!acp，未真握手
```

**缺口（铁道①②要补在这）：**
1. `detect()` 结果只有 `AgentDescriptor | null`，无「discovered 但 available=false」分支。
2. `AcpAdapter.validate()` 是占位（只查字段），**没真实 ACP Initialize/session 握手**——「可用」无权威判定。
3. catalog 只含 3 个 ACP，未全覆盖成「统一 catalog（含 npx 配方 & stdio）」。
4. **没解决短名碰撞（gem/goose/pi 撞系统命令）的 presence 误报**。
5. **依赖 --version 探测**——架构-Pro-2 源码实证 aioncore **无 --version 探测**，那是特性探测不是 presence。

### 1.2 探测链：两级探测（L1 presence + L2 深探）【核心修订】

```
[L1] presence —— 快、全量、无阻塞（≈ 原 A 段）
  - binary 解析：catalog 声明 binary_name → resolveBinary@合并 PATH → binPath
  - 或 npx 启动配方：catalog 可声明 launch:{recipe:"npx", pkg:"@scope/pkg", args:["acp"]}
      → presence = 配方可解析（npx 可达 = 免本机安装；靠内嵌 managed node，见 §4.4）
  - 配置目录/凭证存在性 → authHint
  → 产出: discovered, binPath|recipe, authHint

[L2] 深探 spawn → ACP initialize + session/new —— 权威但慢（默认 30s 超时）
  - spawn `<binPath> <acpArgs>`（或 npx 配方）→ ACP initialize
  - **必须校验 initialize 返回的 serverInfo**：name/版本/能力与 catalog 期望一致
      → **防短名碰撞**（gem/goose/pi 撞系统命令，presence-only 误报，L2 校验纠错）
  - 成功 → available=true + capabilities*/latencyMs
  - **auth 失败分类器**：握手/首探 401/403/quota → error_code='auth_required' + guidance 指引
  → 产出: available, latencyMs, capabilities, serverInfo, error_code?, guidance?
```

**关键设计点：**
- **L2 默认惰性**：`discover.list` 只跑 L1（全量廉价）；`refresh` / 单 agent `check` / `enroll` 才跑 L2。避免「开 agent 列表卡 43×握手」。
- **两级缓存**（复用 `DetectionCache`）：L1 TTL 60s，L2 TTL 30s；`refresh`/`check` 强制失效。
- **超时护栏**：L1 每 agent 独立超时（resolve 1s）；L2 握手 30s；任一层失败只降该层，不整链失败（铁律②）。
- **能力降级（铁律②）**：**不把 --version 当 presence 依赖**；能力只来自 L2 initialize + 可选 `capabilityProbe`（如 `opencode --help`）。缺失即不声明该能力，**仍可 enroll**。version 可为 "unknown"。握手超时 → available=false 但 discovered 保持 true → UI 显示「已发现 / 握手失败，可重试」。
- **短名碰撞规避**：presence 命中不立即判可用；L2 校验 serverInfo，不符 → `error_code='collision'` + guidance「可能与系统命令冲突」，保 discovered=true 但不建议 enroll（§6 R8，升级为 L2 必做）。

### 1.3 候选 CLI 清单（catalog 来源）

统一 catalog = `ACP_CATALOG`（现有 3 个 ACP）+ stdio 目录 + **npx 配方目录**：
```
ACP 路径（推荐）：claude/gemini/codex/kimi/opencode/qwen —— 走 §1.2 全链
stdio 路径（legacy）：claude/codex/opencode —— L1 + spawn（无 ACP 握手 → available 以 spawn 冒烟判定，标 best-effort）
npx 配方：约半数 agent 免本机安装（aioncore 实证）→ L1 判配方可解析，L2 用手签 managed node 起
```
> 新 agent 一律优先 ACP catalog（单实现）；stdio 保留兼容；npx 配方降低装机门槛（对齐 AionUi behavior）。

### 1.4 探测跑在哪一侧 + login-shell env 构造（铁律③ 正解【核心修订】）

**结论：探测在 harness（honeycomb）进程内跑；探测与 spawn 共用「login-shell 构造的 env」，不依赖 Swift 壳继承的残留 PATH。**

与 AionUi 对照：aioncore 在 **GUI 环境用 login-shell 构造 env**——`zsh -lc` 取用户登录 PATH，**剥离 NODE_OPTIONS / CLAUDECODE 污染变量**（它们会污染子进程行为），**保留代理类变量**（HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 等，否则走代理的 agent 会连不上）。

WhalePod 落地：
1. **`discovery/env.ts`（新增）`buildProbeEnv(host)`**：
   - 取用户 PATH：优先 osx 用 `zsh -lc 'echo $PATH'`（含用户 .zshrc 注入的 agent 路径），Windows/其它回退；
   - **净化**：删除 `NODE_OPTIONS`、`CLAUDECODE_*`、`*_NODE_RUNTIME_OPTIONS` 等污染变量（白名单式保留）；
   - **保留代理**：`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY/http_proxy/...`；
   - 产出 `probeEnv` → L1/L2 探测**和 spawn 全部用它**（一致）。
2. **PATH 兜底**：probeUserPath 失败静默回退 `process.env.PATH`，标 `pathSource:'fallback'`。
3. **`pathSource` 溯源**：`'shell' | 'app-env' | 'fallback'`，UI/日志可溯源「为什么 app 与终端不一样」。

> 这是 Bug#2 的正解，且**不要求 Swift 壳额外动作**（与 A1 初稿的 DSH_USER_PATH 注入相比更稳——login-shell env 由 harness 侧自取，天然拿到用户 shell 的 PATH 与代理）。Swift 壳因此**无需改动**（§5）。
> 若需要 Swift 侧环境补充（如 GUI 上下文变量），可后续用 config.env 增量合并，非必需。

---

## 2. 注册模型：DiscoveryRegistry（发现态）↔ Profile/roster（编排态）

### 2.1 分层

```
DiscoveryRegistry（发现态，只读快照 + enroll 入口）→ 新增 service
  持每 catalog entry：{ discovered, available, binPath|recipe, version, capabilities,
                        authHint, pathSource, status, error_code?, guidance?, latencyMs? }
        │ enroll(agentId, {name, role, model?})
        ▼
connector registry（既有 registry.ts）：agentId → AgentAdapter（bootstrapAcpAdapters 已装配）
        │ roster.register + hatch
        ▼
honeycomb Profile/roster（编排态）：Member { backend, connectorId, name, model } → RuntimeHandle
```
- DiscoveryRegistry 不持有会话；enroll 把它注册进 connector registry + roster 成为 Member。
- `Member.connectorId = AgentDescriptor.id`（无需改 Member 模型）。

### 2.2 「一键编入团队」状态迁移 + 状态模型

**Agent 状态模型（吸收架构-Pro-2，研究对齐 AionUi）**：
```
unchecked →(L1)→ missing | present
present   →(L2)→ online  | offline
offline   →(带 error_code=auth_required / collision / startupfail)→ + guidance 指引文案
```
持久呈现字段：`status ∈ { unchecked, missing, online, offline }` + **`error_code`**（`auth_required` / `collision` / `startup_failed` / `handshake_timeout` / `quota`…）+ **`last_check_guidance`**（人类可读指引文案，如「请先 codex login / 可能与你环境里的同名单命令冲突」）+ `last_check_at/latency`。

**enroll 语义**：
- 入参 `{ agentId, hiveId, name?, role?, model? }`；agentId 需 `present`（allowUnavailable=true 可 enroll `offline` 用于「先建成员后补握手」）。
- 动作：断言 connector registry 有 adapter → `roster.register(hiveId, { name, backend, connectorId, model })` → 返回 memberId。幂等（重 enroll 返既有 memberId）。
- 状态链：`present →(enroll)→ registered →(hatch)→ hatching → idle`。

### 2.3 持久化
- 发现态快照：内存（重启后 `refresh` 重建，PATH 会变不落盘），`agent-discovered` 事实仅审计。
- 编排态：沿用 facts 持久化（`member/registered`），**enroll 落盘**跨重启保留。

---

## 3. transport 端点（A3 实现范围）

`router.ts` 新增 `registerDiscoveryRoutes(t)`，挂 `/v1` 下：

| 方法 | 端点 | 语义 | 探测 |
|---|---|---|---|
| GET | `/v1/discover` | 列 catalog 当前发现态（含 status/available/capabilities/guidance/pathSource） | L1（缓存） |
| POST | `/v1/discover/refresh` | 强制刷新（`{includeHandshake?:boolean}` 时连 L2 深探） | L1 ± L2 |
| POST | `/v1/discover/{agentId}/check` | 单 agent 重做 L2 深探（返回 latencyMs/capabilities/error_code） | L2 |
| POST | `/v1/discover/enroll` | 编入团队 `{agentId,hiveId,name?,role?,model?}` → `{memberId,status}` | L2（首握手） |
| GET | `/v1/discover/{agentId}` | 单 agent 发现态详情 | L1 |

**WS**：`refresh`/`check` 后推 `discovery/updated {agentId,status,available,error_code?,guidance?}`；enroll 后推既有 `member/*`。

**`DiscoveryAgent` DTO（增 guidance/status/error_code 字段）**：
```ts
interface DiscoveryAgent {
  id: string                      // = connector id
  displayName: string
  kind: string
  backend: 'acp' | 'stdio' | 'npx-recipe'
  discovered: boolean             // 铁律①= L1 presence
  available: boolean              // 铁律①= L2 握手成功（stdio=spawn 冒烟 best-effort）
  status: 'unchecked'|'missing'|'online'|'offline'   // 状态模型
  binPath?: string | null
  launch?: { recipe:'npx'; pkg:string; args?:string[] } | null
  version?: string | null         // "unknown" 表示握手/能力探测未确认（非 --version 必探）
  authHint?: 'configured'|'missing'|'unknown'
  capabilities: string[]
  latencyMs?: number | null
  error_code?: 'auth_required'|'collision'|'startup_failed'|'handshake_timeout'|'quota'|null
  guidance?: string | null        // 人类可读指引文案
  pathSource?: 'shell'|'app-env'|'fallback'
  lastCheckAt?: number
  enrolledMemberId?: string | null
  error?: string | null
}
```

**错误码**：enroll 未发现→404；已 enroll→409(幂等重试返既有 memberId)；available=false 且未 allowUnavailable→422 NOT_AVAILABLE(附 error_code/guidance)；聚合超时→503 DISCOVERY_*。

---

## 4. cordis 服务形态、生命周期与触发（A3 实现范围）

### 4.1 挂哪个 Service
新增独立第 6 个 service `services/discovery.ts` → `DiscoveryService`，`ctx.discovery`。依赖 connector registry + DetectionCache + `discovery/env.ts`(probeEnv)；enroll 时调用 roster，不反向依赖。

### 4.2 生命周期 + 触发四类（吸收架构-Pro-2）
```
启动 hydrate ：apply() 时跑 L1 全量（并行、每 agent 独立超时），填初始快照
scheduled    ：低优先周期（如 5min）re-hydrate L1 缓存过期项
手动 refresh ：/v1/discover/refresh 或 /check（L2）
会话启动探测 ：enroll/成员会话启动时对目标 agent 跑 L2 并回写状态（免轮询，按需）
```
- teardown：注销 WS handler、清缓存，**不关任何已 hatch 会话**（discovery 是体检器）。
- **npx 配方用内嵌 managed node**：与 OOBE-M0 同构，honeycomb 自带 node 运行时解析 `npx -y @scope/pkg`，不外依赖用户 node。

### 4.3 config 触点（向后兼容）
```ts
discovery?: {
  enabled?: boolean            // 默认 true
  envSource?: 'login-shell'|'app-env'   // 铁律③；默认 'login-shell'
  L1TTLMs?: number             // 默认 60_000
  L2TTLMs?: number             // 默认 30_000
  handshakeTimeoutMs?: number  // 默认 30_000
  scrapeIntervalMs?: number    // scheduled re-hydrate；默认 5min
  catalog?: string[]           // 覆写候选（默认 ACP_CATALOG + stdio + npx 配方）
}
```

### 4.4 装配
`plugin.ts` apply 时 `ctx.discovery = createDiscoveryService(ctx, config.discovery)`；`bootstrapAcpAdapters()` 已在启动装配 ACP adapter 进 connector registry，discovery 复用同一 registry。

---

## 5. 与 Swift 壳的关系（铁律③ 收敛）

| 问题 | 结论 |
|---|---|
| 探测跑哪侧 | **harness（honeycomb）进程内**（与 spawn 同侧才一致） |
| Swift 壳角色 | **不再需要为 PATH 注入做改动** —— login-shell env 由 harness 侧 `buildProbeEnv()` 自取（§1.4） |
| config 触点 | `discovery.envSource='login-shell'`（默认）；仅当要 GUI 上下文变量时再谈 Swift 增量合并 |
| 不做什么 | 不在 Swift 侧探测 agent |

> B 计划：若 login-shell env 构造在某平台不可用，`pathSource='fallback'` 自动接管，体验降级不断链。

---

## 6. 风险清单与降级策略

| # | 风险 | 概率/影响 | 降级/缓解 |
|---|---|---|---|
| R1 | PATH 不一致（Bug#2 同源） | 高/高 | §1.4 login-shell env 构造（zsh -lc + 剥污染 + 留代理）+ pathSource 溯源；同 shell 复现姿势写文档 |
| R2 | 握手慢/超时拖慢列表 | 中/中 | L1/L2 分离 + 惰性 L2 + 每 agent 独立超时 |
| R3 | 版本探测偶发崩溃 | 中/低 | 不把 --version 当 presence；能力仅来自 L2 + 可选 capabilityProbe；version=unknown 不阻断 |
| R4 | ACP 进程残留 | 中/中 | 握手失败 SIGKILL+等待；A3 测试复用 acp-kimi-live 清理纪律 |
| R5 | enroll 到不可用 agent | 中/中 | 404/409/422 语义 + allowUnavailable 显式逃逸；UI 默认只对 online 展示「编入」 |
| R6 | 缓存陈旧 | 低/低 | L1/L2 TTL 分开 + refresh 强制失效 |
| R7 | stdio 无 ACP 握手，available 弱 | 中/低 | spawn 冒烟 best-effort + 标 available=best-effort |
| R8 | **短名碰撞误报（gem/goose/pi）** | 中/高 | **L2 必校验 serverInfo**；不符 → error_code='collision'+guidance，不推荐 enroll |
| R9 | 面板未适配发现态 | 中/中 | DiscoveryAgent.enrolledMemberId 桥接；面板先读 /v1/discover 再走 member 流 |
| R10 | npx 配方联网失败/无网 | 中/低 | L1 判配方可解析，L2 起跑失败 → offline + guidance「检查网络/镜像」 |

---

## 7. A3 实施拆分建议（给实现者）

1. `discovery/env.ts`：login-shell env 构造（zsh -lc 取 PATH + 净化污染变量 + 保留代理）+ probeUserPath 兜底 + pathSource；
2. `services/discovery.ts`：L1/L2 两级探测、双 TTL 缓存、状态模型(unchecked/missing/online/offline + error_code/guidance)、enroll；config.ts 加 discovery 块（向后兼容）；
3. `router.ts`：registerDiscoveryRoutes（5 REST + WS discovery/updated）；
4. `plugin.ts`：挂 ctx.discovery + 启动 L1 hydrate；
5. 测试 `test/discovery-*.test.ts`：L1/L2 双态、缓存分离、握手超时降级、**短名碰撞 serverInfo 误报**、auth 分类器(401/403/quota→auth_required)、enroll 404/409/422、**login-shell env 净化（剥 NODE_OPTIONS 留代理）**、pathSource 溯源（PATH shim 双环境 CI 纪律，失败自 skip 拒假绿）。

---

## 8. 与 A1 三条结论 + 架构-Pro-2 增量 的对账

| 结论/增量 | 本设计落点 |
|---|---|
| ① discovered ≠ available 双状态 | §1.2 L1/L2 + §2.2 状态模型 + DTO discovered/available/status |
| ② 版本/能力降级不硬失败 | §1.2 能力来自 L2+capabilityProbe、version=unknown、仍可 enroll |
| ③ PATH 继承坑明确解法 | §1.4/§5 login-shell env 构造（zsh -lc + 剥污染 + 留代理）+ pathSource；B 计划免依赖 |
| 触发四类（hydrate/scheduled/manual/会话启动回写） | §4.2 |
| 无 --version 探测 / npx 配方 + managed node | §1.2/§1.3/§4 |
| login-shell env 构造（Bug#2 正解） | §1.4/§5 |
| 两级探测 L1 presence + L2 spawn/ACP+session | §1.2 |
| auth 分类器 401/403/quota → requires_login | §1.2 L2 + DTO error_code/guidance |
| 状态模型 + error_code + last_check_guidance | §2.2/§3 |
| command_override/env_override | 现有 connectors overrides（types.ts）已承载；A3 复用，R8/R10 引用 |
| 短名碰撞 → L2 serverInfo 校验 | §1.2 + §6 R8 |
