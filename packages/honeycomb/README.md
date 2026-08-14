# @dfh/honeycomb

DFH Workstation 多智能体编排核心（**概念级重实现**，Cordis 原语之上，只用蜂巢词汇）。

独立目录落地（不依赖 harness 内部包），源码自包含、可编译、服务可单测。
集成时把 `src/framework.ts` 的 `Context` 缝（seam）换成真实的
`@deepseek-ai/cordis` 即可 —— 方法签名一一镜像 Cordis。

## 目录结构（§11）

```
src/
├── framework.ts           最小 Cordis 兼容缝：Context / Events / 生命周期
├── types.ts               领域模型 + 跨服务 DTO（§3 / §5 / §6）
├── config.ts              HoneycombConfig + StandardSchema（§10）
├── events.ts              HiveEventMap + mandate/decide、courier/outgoing 两个 waterfall（§8）
├── context.ts             Context 接口增强（ctx.hive / ledger / courier / mandate / roster / agents）
├── plugin.ts              apply(ctx, config) 装配（§5.5）
├── persistence/
│   ├── facts.ts           HiveFact 词汇（§9.2）
│   ├── store.ts           仅追加事实日志 → 派生快照（§9）
│   └── jsonl.ts           JsonlFactBackend：磁盘追加日志 + 启动重放 + 损坏行容错（§9.3）
├── services/
│   ├── hive.ts            HiveService（§5.1）
│   ├── ledger.ts          LedgerService（§5.2）
│   ├── courier.ts         CourierService（§5.3）
│   ├── mandate.ts         MandateService（§5.4）
│   └── roster.ts          RosterService（§6.1）
├── runtime/
│   ├── registry.ts        MemberRuntime 命名注册表（§6.2）
│   ├── native-runtime.ts  委托 ctx.agents 的原生后端桩（§6.2）
│   └── fiber.ts           hatch/dismiss 的 Fiber 托管（§6.4）
└── consumer/
    └── orchestration-loop.ts  编排循环 stub（架构-Pro-1 并行设计）
```

## 交付说明（重要）

1. **「6 个服务」vs「5 个服务」**：文档 §0/§13 写「6 个服务」，但 §5/§6
   只定义了 5 个 —— `hive` / `ledger` / `courier` / `mandate` / `roster`。
   本实现以 §5/§6 为准装配 5 个服务。第 6 个候选是 `MemberRuntime` 命名
   注册表（§6.2），本实现按 §6.2 以 `ctx.roster.registerRuntime(runtime)`
   暴露（`RosterService` 接口新增了 `registerRuntime` / `listRuntimes`，
   以对齐 §6.2 的调用点），而非独立顶层服务。

2. **事实词汇两处最小扩展**：§9.2 的词汇是概念级（非穷尽）。为支撑 §5/§6
   的服务面，追加了两个事实：
   - `hive-updated`（`setMode` / `setSessionMode` 的 `workspaceMode` /
     `sessionMode` patch）；
   - `member-renamed`（`RosterService.rename`）。
   其余服务方法均映射到 §9.2 既有事实。

3. **`FactRecord` 携带 `hiveId`**：§9.2 的 fact 不含 hive 分区键（如
   `member-status` 只有 `memberId`）。为支持按 hive 分区重放（jsonl/sqlite
   后端），`FactRecord` 在记录层显式携带 `hiveId`。

4. **mandate/decide 的「短路」语义**：§5.4 描述为 waterfall 且「返回
   verdict 即短路」。本实现用 `ctx.waterfall`（归约）实现：默认策略先算出
   初始 grant，插件监听器可返回新 grant 覆盖（收紧/放行），最终 verdict
   决定结果；返回 `denied` 即等效「短路」。`allowOverrides: false` 时忽略
   插件覆盖。

5. **courier/outgoing 丢消息**：监听器返回 `null` 即丢消息，`send` 抛
   `MessageDroppedError`。

6. **deliver 异步入队**：概念级实现直接落库返回 id（真实异步队列留待
   运行时接入）。

7. **编译/单测**：本包零运行时依赖；`framework.ts` 是自包含缝。
   `tsc --noEmit` 可过（严格模式）。`test/smoke.ts` 用 `tsx` 直接运行，
   覆盖建蜂巢 → 注册/孵化 → 任务依赖 → 授权 → 收发消息 → 遣散 → 事实重放
   全链路。

8. **持久化落盘（§9.3）**：默认 `jsonl` 后端把仅追加事实日志写磁盘
   （`<persistenceDir>/<hiveId>/facts.ndjson`，默认 `~/.dfh/hive`）；
   `apply` 变为异步，启动时 `await store.load()` 重放日志重建派生快照。
   写失败 / 损坏行**跳过并告警**（`onWarn`），绝不中断启动。`sqlite`
   后端尚未实现（暂回退 jsonl + 告警）。`test/persistence.test.ts`
   （`npm run test:persistence`）覆盖跨重启重放、损坏行容错、append-only
   轮数与多 hive 确定性重放。

## 快速开始

```ts
import { Context } from '@dfh/honeycomb'
import { apply } from '@dfh/honeycomb/plugin'

const ctx = new Context()
await apply(ctx, { persistenceDir: '~/.dfh/hive' })   // 可选覆盖落盘目录
const hive = await ctx.hive.create({ name: 'A', workspace: '/tmp/a' })
```
