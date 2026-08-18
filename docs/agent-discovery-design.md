# WhalePod Agent 自动发现子系统设计（A2）

> 设计人：架构-Pro-1
> 日期：2026-08-17
> 任务：#01a00fb5-af7a（A2，blocked_by A1）
> 依据：`docs/aionui-agent-discovery-research.md`（A1，真机实证）；`docs/cli-agent-inventory.md`（本机 CLI 基线'）；`docs/acp-adapter.md`（ACP 旗舰收口）
> 交付对象：A3（实现 honeycomb agent-discovery 服务 + transport 端点）
> 阅读对象：实现-Pro-4/A3 实现者、面板联调方、Swift 壳 owner（§5）

---

## 0. 目标与设计原则

把「本机有哪些可用的外部 CLI agent」从**人工/静态**变成**自动发现 + 一键编入团队**，与 AionUi 的 aioncore catalog 对标但落在 WhalePod/ honeycomb 现有分层内。

**三条设计铁律（Leader 指定，来自 A1 调研）：**
- **铁律 ①：discovered（PATH 命中）≠ available（ACP 握手成功），两个状态位强制分离。**
  现有 `AgentDescriptor.detect()` 返回 `null` 即视为「无」，把「装了但合不上手」与「没装」混为一谈（我们的 codex-403 / kimi-超时正是活例）。新模型必须显式承载 `{ discovered, available }`。
- **铁律 ②：版本/能力不符 → 能力降级，不是硬失败。**
  AionUi 对 claude `--version` 识别失败只是省略 `--thinking-display`，仍可接入。WhalePod 探测链对每一档能力缺失都应降级，不阻止 enroll。
- **铁律 ③：PATH 继承坑（Bug#2 同源），给出明确解法。**
  Swift 壳的子进程 PATH 与用户 shell PATH 不一致。必须定义「探测在哪一侧跑、用户 PATH 如何拿到」。

**复用基调**：现有 `packages/honeycomb/src/connectors/` 的 `Detector`（三层探测：path/version/config）+ `ACP_CATALOG` + `AcpAdapter` + `registry`（connector 注册表）就是 AionUi「catalog + PATH 解析 + ACP 握手」的直接对应物。A2 是**在其上加一层「发现态」**，并接通 roster 的「编入团队」。

---

## 1. 探测链设计（复用 OOBE-M0 node 探测链模式）

### 1.1 现状与缺口（对照现有 Detector）

现有 `connectors/detect/detector.ts` 已是三层探测：
```
layer 0 path   : resolveBinary(binaryName, host) → binPath（PATH 扫描，host-env.ts 已实现 which 级解析）
layer 1 version: 子进程跑 --version → 解析 version + 能力
layer 2 config : configDir(home, dirName) 存在性（如 ~/.codex/auth.json）
layer 3 acp    : （AcpAdapter spec 里有 capabilityProbe / acp.spawnArgs，但 validate() 只是
                  `!!binPath && !!acp`，未真握手）
```

**缺口（铁道①②要补在这）：**
1. `detect()` 结果只有 `AgentDescriptor | null`，无「discovered 但 available=false」分支。
2. `AcpAdapter.validate()` 是占位（只查字段），**没有真实 ACP Initialize 握手**——所以「可用」没有权威判定。
3. 现 catalog 只含 3 个 ACP（opencode/kimi/gemini），本机还有 codex/hermes + 其它 stdio，未全覆盖成「统一 catalog」。

### 1.2 探测链分档（新）

把探测拆成 **两段四步**，每段产出独立状态位：

```
[A] 发现段 discover —— 走纯 PATH/文件系统，廉价、无副作用
  step-0 path     : binary_name 在 $PATH 上解析出绝对路径（host-env.resolveBinary，已实现）
  step-1 version  : 子进程 `--version` 解析（超时 2s；失败不致命 → 标记 version="unknown"）
  step-2 config   : 配置目录/凭证文件存在性（决定 auth 与可用子集）
      → 产出: discovered = true|false, binPath, version?, authHint?

[B] 可用段 available —— 走真实 ACP Initialize 握手，权威但慢（默认 30s 超时）
  step-3 handshake: spawn `<binPath> <acpArgs>` → ACP initialize → 成功则 available=true，
                    拿到 available_commands / available_models / 能力集
      → 产出: available = true|false, latencyMs, capabilities*
```

**关键设计点：**
- **step-3 默认惰性**：`discover.list` 只跑 A 段（廉价）；只有 `discover.refresh`（显式 refresh，或 enroll 时）才跑 B 段握手。这避免「打开 agent 列表就卡 43×握手」。
- **A/B 分开缓存**（复用 `DetectionCache`）：A 段 TTL 较长（如 60s），B 段 TTL 较短（如 30s）且可用 `discover.refresh` 强制失效。
- **超时护栏**：每一层独立超时（path 0 / version 2s / handshake 30s），任何一层失败只降该层，不整链失败（铁律②）。
- **能力降级**：version 解析失败 → `version:"unknown"`，`--thinking-display` 等派生能力自动不声明；握手超时 → available=false 但 discovered 保持 true，UI 显示「已发现 / 握手失败，可重试」。

### 1.3 候选 CLI 清单（catalog 来源）

统一 catalog = `ACP_CATALOG`（现有 3 个 ACP）+ **stdio 目录**（claude-code/codex/kimi-code/opencode/hermes，`cli-agent-inventory.md` 所列）：

```
ACP 路径（推荐）：claude/gemini/codex/kimi/opencode/qwen 等 —— 走 §1.2 全链
stdio 路径（legacy）：claude/codex/opencode —— 走 A 段 + spawn（无 ACP 握手 → available 以 spawn+done 判定）
```
> 设计取向：新 agent 一律优先 ACP catalog（复用 `AcpAdapter` 单实现）；stdio 目录保留兼容，`capabilityProbe` 已可表达（`opencode --help`）。

### 1.4 探测跑在哪一侧（铁律③ 的解法）

**结论：探测跑在 harness（honeycomb）进程内**，但 **PATH 显式注入用户 shell PATH**，不依赖 Swift 壳继承的残留 PATH。

理由与机制：
1. **为什么 harness 内跑**：agent 的 detect/spawn 本来就要在 harness 内执行（enroll → hatch → spawnSession 都在 harness），探测与执行保持一致才不会有「探测到但 spawn 不到的假象」。iOS/桌面壳只负责把「用户登录 shell 的 PATH」交进来。
2. **用户 PATH 从哪拿**（三源合并，长程治理）：
   - **主源：由 Swift 壳在启动 harness 前探测并注入** —— `RuntimeBootstrap` 在 spawn dsh 时用
     `login shell -lc 'echo $PATH'`（`/bin/zsh -lc` 对本用户）取**用户登录 PATH**，写入 harness 子进程环境变量 `DSH_USER_PATH`（新增，见 config 触点）。※ 与 Swift owner 协调，这半句 `-lc` 探测就是给我们 PATH 继承坑的根治；若 RuntimeBootstrap 不可动，则退化为 harness 内 `getDefaultShellPath()`（§1.4.2）。
   - **harness 侧合并规则**（`discovery/env.ts`，新增）：`resolveProbeEnv()` =
     `{ ...process.env, PATH: userPath(shell登录PATH) ?? process.env.PATH }`。
     探测与 spawn **都**用这份合并后的 env，保证一致。
   - **兜底探测函数** `probeUserPath()`：`process.getuid` 可用时查 `getent passwd $UID` 的 shell，跑 `-lc echo $PATH`；失败静默回退 `process.env.PATH` 并标 `pathSource:'fallback'`。
3. **引入 Bug#2 教训记录**：探测结果必须带 `pathSource: 'shell'|'app-env'|'fallback'`，UI/日志可溯源「为什么 app 里能发现但终端不一样」。

> §6 风险表里把「PATH 不一致」列为 **P0 必做**，因为不解决，AionUi 是的 bug 我们会在 WhalePod 原样复现。

---

## 2. 注册模型：DiscoveryRegistry（发现态）↔ Profile/roster（编排态）

### 2.1 分层（延续 AionUi 的「发现层 ≠ 编排层」）

```
┌─────────────────────────────────────────────────────────────┐
│ DiscoveryRegistry (发现态，只读快照 + enroll 入口)            │   ← 新增 service
│   持每个 catalog entry 的 { discovered, available, binPath,  │
│     version, capabilities, authHint, pathSource }            │
│   由 discover.list / discover.refresh 驱动                    │
└─────────────┬───────────────────────────────────────────────┘
              │ enroll(discoveredAgentId, {name, role})
              ▼
┌─────────────────────────────────────────────────────────────┐
│ connector registry（既有 registry.ts）: agentId → AgentAdapter│
│   bootstrapAcpAdapters() 已把 ACP_CATALOG 实例化成 adapter    │
└─────────────┬───────────────────────────────────────────────┘
              │ roster.register + hatch
              ▼
┌─────────────────────────────────────────────────────────────┐
│ honeycomb Profile/roster (编排态)：Member { backend,         │
│   connectorId, name, model }  → RuntimeHandle 会话句柄       │
└─────────────────────────────────────────────────────────────┘
```

- **DiscoveryRegistry 不持有会话**：它只是「本机体检结果」的只读快照 + 一套 `enroll` 命令。真正能干活的是把它「注册进 connector registry + roster」之后的 Member。
- **connector id 复用**：现有 `Member.connectorId` 已是为「回指连接器注册表里 connector id」设计的——`AgentDescriptor.id`（如 `opencode-acp` / `codex`）直接就是它。**无需改 Member 模型**；enroll 时把 `discoveredAgentId` 映射成 `connectorId + backend:'acp'`（或 stdio 对应 backend）。

### 2.2 「一键编入团队」状态迁移

```
discovered=false ──(path 命中)→ discovered=true
discovered=true  ──(握手成功)→ available=true
available        ──(enroll)→  conn-registry 已注册 + roster Member{backend, connectorId}
                              status: registered
                              ──(hatch)→ status: hatching → idle（可派工）
```

**enroll 语义（DiscoveryRegistry.enroll）**：
- 入参 `{ agentId, name?, role?, model? }`，agentId 必须是 `discovered=true`（或显式 `forceAvailable` 允许 available=false 也 enroll——用于「先建成员、后补握手」）。
- 动作：① 断言 connector registry 已有对应 adapter（`bootstrapAcpAdapters()` 启动即装配）；② `roster.register(hiveId, { name, backend, connectorId: agentId, model })`；③ 返回 memberId。
- **既发现又编排态可并存**：同一 agentId 已 enroll 的不重复注册（幂等，重 enroll 返回既有 memberId）。

### 2.3 持久化（编排态落盘）

- 发现态快照：内存（重启后 `discover.refresh` 重建），**不落盘**（PATH/环境会变，落盘易陈旧）。
- 编排态：沿用 honeycomb Profile/facts 持久化（`roster.register` 走既有事实日志），**enroll 需落盘**，使「我编了哪些 agent」跨重启保留。
- 增补事实词汇（facts 层）：`agent-discovered {agentId,...}`（可选，仅供审计）与 enroll 走现有 `member/registered`。

---

## 3. transport 端点设计（A3 实现范围）

在 `transport/router.ts` 新增 `registerDiscoveryRoutes(t)`，挂在现有 `/v1` 下。REST + WS 双端（WS 走既有 subscribe 广播机制）。

| 方法 | 端点 | 语义 | 触发探测段 |
|---|---|---|---|
| GET | `/v1/discover` | 列出全部 catalog 当前发现态（含 discovered/available/version/capabilities/pathSource） | A 段（缓存） |
| POST | `/v1/discover/refresh` | 强制刷新（失效缓存，A 段；`{includeHandshake?:boolean}` 时连 B 段握手） | A ± B 段 |
| POST | `/v1/discover/{agentId}/check` | 单 agent 重做可用段握手（返回 latencyMs/capabilities） | B 段 |
| POST | `/v1/discover/enroll` | 编入团队 → body `{agentId, hiveId, name?, role?, model?}`；返回 `{memberId, status}` | B 段（首启握手） |
| GET | `/v1/discover/{agentId}` | 单 agent 发现态详情 | A 段 |

**WS**：`discover.refresh` / 单 agent `check` 完成后推 `discovery/updated {agentId, discovered, available,...}`；enroll 后推既有 `member/*` 事件。

**响应承载**（`DiscoveryAgent` DTO）：
```ts
interface DiscoveryAgent {
  id: string                 // = connector id（AgentDescriptor.id）
  displayName: string
  kind: string
  backend: 'acp' | 'stdio'   // 连接方式
  discovered: boolean        // 铁律①：PATH/文件系统命中
  available: boolean         // 铁律①：ACP 握手成功（后端='stdio' 时为 spawn 冒烟）
  binPath?: string | null
  version?: string | null    // "unknown" 表示解析失败（铁律②降级）
  authHint?: 'configured' | 'missing' | 'unknown'
  capabilities: string[]     // 握手可得（available=true 时才有）
  latencyMs?: number | null  // 最近一次握手往返（AionUi last_check_latency_ms）
  pathSource?: 'shell' | 'app-env' | 'fallback'
  lastCheckAt?: number
  enrolledMemberId?: string | null   // 若已 enroll，回指 member
  error?: string | null      // 最近一次失败的友好消息（握手/版本）
}
```

**错误码**：
- enroll 未发现 agent → `404 NOT_FOUND`
- enroll 已 enroll → `409 ALREADY_ENROLLED`（幂等重试按「返回既有 memberId」处理）
- available=false 且未 `forceAvailable` → `422 NOT_AVAILABLE`（可附 `error`）
- 探测超时聚合失败 → `503 DISCOVERY_*`（附 layers 各状态）

---

## 4. cordis 服务形态与生命周期（A3 实现范围）

### 4.1 挂哪个 Service

新增 `services/discovery.ts` → `DiscoveryService`，作为 **honeycomb 一个独立 service（第 6 个 service）** 装配进 plugin（`apply(ctx, config)`，`ctx.discovery = new DiscoveryService(...)`）。AionUi 里它是核心发现中枢，故不塞进现有 5 个 service，独立成域。

- 依赖 `connector registry`（拿各 adapter 的 spec / validate / spawn）、`DetectionCache`、`HostEnvironment`（含 §1.4 合并 env）。
- 不反向依赖 roster/ledger；enroll 时**调用** roster，但 discovery 本身不持有会话。

### 4.2 生命周期

- **boot（apply 时）**：`discover.list()` 预热 A 段（并行、每 agent 独立超时），填充初始快照。挂 WS subscribe。
- **run**：`refresh` / `check` / `enroll` 按需触发（§3）。
- **teardown**：注销 WS handler、清缓存，**不关任何已 hatch 会话**（discovery 只是体检器）。
- **config 触点**（`HoneycombConfig` 增量，向后兼容）：
  ```ts
  discovery?: {
    enabled?: boolean          // 默认 true（探测无副作用）
    pathInherit?: 'shell'|'app-env'   // 铁律③；默认 'shell'
    pathTTLMs?: number         // A 段缓存，默认 60_000
    handshakeTTLMs?: number    // B 段缓存，默认 30_000
    handshakeTimeoutMs?: number// 默认 30_000
    catalog?: string[]         // 可覆写候选 CLI（默认 = ACP_CATALOG + stdio 目录）
  }
  ```
  加到 `HoneycombConfig` / `ResolvedHoneycombConfig` / `resolveHoneycombConfig()`（A3 动 config.ts，向后兼容默认值）。

### 4.3 装配

`plugin.ts` apply 时：`ctx.discovery = createDiscoveryService(ctx, config.discovery)`；`connectors/bootstrapAcpAdapters()` 已在启动装配 ACP adapter 进 connector registry，discovery 复用同一 registry（不重复装配）。

---

## 5. 与 Swift 壳的关系（铁律③ 彻底落到实现）

| 问题 | 结论 |
|---|---|
| 探测跑哪侧 | **harness（honeycomb）进程内**（与 spawn 同侧才一致） |
| Swift 壳角色 | 只负责在 spawn 前把**用户登录 shell PATH** 注入 harness（见 §1.4.2 主源） |
| config 触点 | `DSH_USER_PATH` 环境变量（Swift 注入）+ `config.discovery.pathInherit`（harness 侧开关） |
| 不做什么 | **不在 Swift 侧探测 agent**（双击可找 binary，但 spawn/握手都在 harness，Swift 测了也是白测） |
| 动 Swift 吗 | **A3 不动 Swift**；只出需求清单交 Swift owner（RuntimeBootstrap 注入 `DSH_USER_PATH`；参照 OOBE-M0 已用它注入过 node 路径的先例） |

> 若 Swift 侧改不动（RuntimeBootstrap 冻结），harness 内 `probeUserPath()`（§1.4.2 兜底）自动接管，`pathSource` 标 `shell`，体验降级但不断链。**这是设计上保证「无 Swift 依赖也能跑」的 B 计划**。

---

## 6. 风险清单与降级策略

| # | 风险 | 概率/影响 | 降级/缓解 |
|---|---|---|---|
| R1 | **PATH 不一致（Bug#2 同源）** | 高/高 | §1.4 双保险：Swift 注入 `DSH_USER_PATH` + harness `probeUserPath()` 兜底；`pathSource` 可溯源；文档记录复现姿势（同 shell 复现） |
| R2 | 握手慢/超时拖慢列表 | 中/中 | A/B 段分离：`discover.list` 只 A 段；B 段只 `refresh{includeHandshake}` / `check` 显式触发；每 agent 独立超时 |
| R3 | 版本探测偶发崩溃（agent --version 输出怪） | 中/低 | 每层独立 try/catch + 超时；version=unknown 降级不阻断（铁律②） |
| R4 | ACP init 进程残留（握手后未回收） | 中/中 | 握手失败必须 SIGKILL + 等待；纳入 A3 测试（复用 acp-kimi-live 清理纪律） |
| R5 | enroll 到不可用 agent（available=false） | 中/中 | `409/422` 语义 + `forceAvailable` 显式逃逸；UI 默认只对 available=true 展示「编入」按钮 |
| R6 | 缓存陈旧（agent 装了/卸了） | 低/低 | A/B TTL 分开 + `refresh` 强制失效 |
| R7 | stdio legacy 无 ACP 握手，available 判定弱 | 中/低 | 对 stdio 走「spawn+`--help`/`--version` exit 0 冒烟」，并标 `available=best-effort` |
| R8 | catalog 冲突（多 agent 同名 binary） | 低/中 | `resolveBinary` 取 PATH 首个；`overrides` 留待 A3 后 follow-up |
| R9 | 面板/前端未适配发现态（只认 member） | 中/中 | `DiscoveryAgent.enrolledMemberId` 桥接；面板先读 `/v1/discover` 展示，再走既有 member 流 |

---

## 7. A3 实施拆分建议（给实现者）

1. **数据/工具层**：`connectors/detect/discovery-env.ts`（§1.4 合并 env + probeUserPath）+ `DiscoveryAgent` DTO（§3）；
2. **service**：`services/discovery.ts`（A/B 两段探测、缓存、enroll）；config.ts 加 `discovery` 块（向后兼容）；
3. **transport**：`router.ts` 加 `registerDiscoveryRoutes` + WS `discovery/updated`；
4. **装配**：`plugin.ts` 挂 `ctx.discovery` + 预热；
5. **测试**：`test/discovery-*.test.ts`——discovered/available 双态、A/B 缓存分离、握手超时降级、version=unknown、enroll 幂等/409/422、PATH 合并（shim 命中）、`pathSource` 溯源（参照 A1 的 PATH 教训 + 上次 detect 两态 CI 红修复先例，shim 需保证 CI Linux 可跑，失败自 skip 不许假绿）。

---

## 8. 与 A1 三条结论的对账（交付自检）

| 结论 | 本设计落点 |
|---|---|
| ① discovered ≠ available 双状态 | §1.2 A/B 两段 + §2.2 状态迁移 + DTO `discovered`/`available` 两个字段 |
| ② 版本/能力降级不硬失败 | §1.2 逐层独立超时 + version=unknown + 能力不声明，仍可 enroll |
| ③ PATH 继承坑明确解法 | §1.4 / §5：探测在 harness 侧 + `DSH_USER_PATH` 注入 + `probeUserPath()` 兜底 + `pathSource` 溯源；B 计划免 Swift 依赖 |
