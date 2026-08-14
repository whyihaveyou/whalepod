# honeycomb 主包 cordis 全量迁移 · 执行计划

> 关联任务：#01a00112（【honeycomb cordis 全量迁移】弃 framework.ts shim，主包迁真实 cordis）
> 阻塞于：#01a000cd-97cc（编排循环 orchestr-loop，架构-Pro-2 收尾中）
> 前置已完成：小步① 已把 `@deepseek-ai/cordis@^4.0.1` + `@deepseek-ai/schemastery@^3.18.1` 装进
> `packages/honeycomb` 的 `peerDependencies` 并实装 node_modules（typecheck 的 module-not-found 已清零）。
>
> 本文件是**执行蓝图**（待阻塞解除即按顺序执行），与
> `docs/harness-plugin-integration.md §6-8` 的迁移清单互补——这里是按文件粒度展开的 step-by-step。

---

## 0. 现状速览（迁移前已核实）

> ✅ **进度（2026-08-14）**
> - 小步① 依赖已装（peer deps + node_modules 实装），registry.ts module-not-found 清零。
> - **A0（util.ts 抽出 makeId/now）已完成**：`src/util.ts` 新建，`roster/ledger/courier/hive`(services, makeId+now)、
>   `persistence/store.ts`(now)、`runtime/fiber.ts`(makeId) 的 import 已切 `../util`；基线 typecheck 0 error。
> - 剩余迁移为**原子切换**：services Service-化 / plugin.ts / events+context 增强目标 / runtime import 都相互耦合，
>   且 `plugin.ts`、`config.ts`、`transport/*` 正被 #01a00107（transport 真适配器）占用，
>   `consumer/orchestration-loop.ts` 正被 #01a0012a（编排健壮性）占用 → 待这些并发任务交回后按 Phase B 落地。

从 `docs/harness-plugin-integration.md §6-8` 的迁移清单互补——这里是按文件粒度展开的 step-by-step。

---

## 0. 现状速览（迁移前已核实）

- `src/framework.ts` = **自造 Context shim**（Proxy）；`src/context.ts` 做服务声明合并增强。
  方法集合：`provide/get/inject`、`on/once/off/emit/parallel/serial/bail/waterfall`、
  `effect/onDispose/scope/dispose/root`。
- 各 service 目前是**工厂函数** `createXService(ctx, deps)` 返回接口对象（如 `RosterService`），
  在 `plugin.ts` 的 `apply` 里 `ctx.provide(name, svc)` 装配。
  service 内部已正确使用 `ctx.emit` / `ctx.onDispose` / `ctx.waterfall`，**方法逻辑可原样保留**。
- `src/events.ts` 通过 `declare module './framework' { interface Events {...} }` 合并 emit 事件表。
- `src/runtime/registry.ts`、`src/runtime/native-runtime.ts`、`src/connectors/registry.ts` 分别 import shim / 真 cordis。

### 关键兼容性事实（决定迁移写法）
1. 真 cordis **没有 `ctx.onDispose()`**（全包 grep 0 命中）。服务里的 `ctx.onDispose(fn)` 必须映射。
2. 真 cordis 的 `ctx.effect(execute, label)`：body 返回 disposer 即于释放时执行；generator 形式 body 于释放时才跑。
   - `onDispose(() => void x())` → **`ctx.effect(() => () => { void x() })`**（body 立即跑、返回的 disposer 于释放时执行）
   - 或 `ctx.effect(function* () { void x() })`（generator 形式，body 释放时才跑）
   - ⚠ 已实测**「裸 setInterval + return disposer」是坑**（timer 不随 dispose 停）；一律用 `ctx.effect` 包。
3. 真 cordis `Service` 子类**必须显式 `constructor(ctx){ super(ctx,'name') }`**（否则不注册，已实测）。
4. 事件合并目标从 `'./framework'` 改为 `'@deepseek-ai/cordis'` 的 `interface Context` 增强（含 `Events`）。
5. 服务从 `factory(ctx,deps)` 改 `class extends Service`：接口（`RosterService` 等）与公开 API **保持不变**——
   transport / orchestration-loop / 测试 / examples 都依赖现有签名，**只换实现形态，不动 API**。
6. **`makeId` / `now` 是 `framework.ts` 的工具函数导出**（不是 cordis 方法）。5 个 service + `persistence/store`（now）+
   `runtime/fiber`（makeId）依赖它们。**迁移须先为二者建新家**（如 `src/util.ts` 或保留在迁移后的工具模块），
   否则删 framework.ts 会连带大量 import 断裂。建议：从 `src/util.ts` 导出 `makeId` + `now`，各处 import 改指向。

### 全部 `../framework` / `./framework` import 方（22 个，迁移时逐一改）
- `src/services/`: hive.ts、ledger.ts、courier.ts、mandate.ts、roster.ts（`Context` + `makeId`/`now`）
- `src/runtime/`: native-runtime.ts、agent-runtime.ts、registry.ts（`Context`）、fiber.ts（`makeId`）
- `src/persistence/`: store.ts（`now`）
- `src/transport/`: port.ts、core.ts、ws.ts、memory.ts（`Context`）、subscribe.ts（`Context, Disposable`）、types.ts（`Events`）
- `src/consumer/`: orchestration-loop.ts（`Context`）
- `src/plugin.ts`（`Context`）、`src/index.ts`（`export * from './framework'` → 需改为显式再导出）

### `onDispose` 实际使用点（2 处，均映射 `ctx.effect`）
- `src/services/roster.ts:74` `ctx.onDispose(() => void fibers.disposeAll())`
- `src/plugin.ts:73` `ctx.onDispose(() => {...})`

---

## 1. 迁移文件清单（按依赖顺序）

| # | 文件 | 动作 | 关键点 |
|---|---|---|---|
| 0 | `package.json` + `tsconfig.json` | ✅ 已完成/待确认 | peer deps 已装（小步①），node_modules 已实装；tsconfig 需 `取消 exclude:["src/connectors"]` + 加 `allowImportingTsExtensions`（connectors 的 `.ts` 相对导入需要） |
| 1 | `src/util.ts` | **新增** | 从 framework.ts 摘出 `makeId` / `now` 两个工具函数（被 6 个文件依赖，删 shim 前必须先建新家，src/services/ ×5 + persistence/store + runtime/fiber 都改 import 指向这里） |
| 2 | `src/framework.ts` | **删除** | shim 彻底移除，`import type { Context } from '../framework'` 全量指向真 cordis |
| 3 | `src/events.ts` | 改建 | `declare module './framework'` → `declare module '@deepseek-ai/cordis'`（`interface Context { Events: {...} }` 或直接 `Events` 泛型增强，按 cordis 合并约定）；emit 表常量/waterfall 钩子不变 |
| 4 | `src/context.ts` | 改/删 | 服务声明合并改用 `declare module '@deepseek-ai/cordis'`；无需 shim 的 `Context` 类型重导出 |
| 5 | `src/config.ts` | 增益可选 | 保留 `ResolvedHoneycombConfig` 类型；新增定义 zod/StandardSchema `Config` 供 loader 校验（用 schemastery 对齐 harness） |
| 6 | `src/services/hive.ts`, `ledger.ts`, `courier.ts`, `mandate.ts`, `roster.ts` | **Service 化** | `class X extends Service { constructor(ctx){ super(ctx,'x') } ... }`；方法体照搬；`onDispose`→`ctx.effect`；`ctx.emit` 照用；`makeId/now` import 改 `src/util` |
| 7 | `src/runtime/registry.ts` | 改 import | `../framework` → `@deepseek-ai/cordis`；`MemberRuntime` 接口保留 |
| 8 | `src/runtime/native-runtime.ts` | 改 import + 判空 | `ctx.agents` 仅 harness 挂载后满足，挂 harness 才取（§7 结论）；独立模式（无 ctx.agents）抛明确错 |
| 9 | `src/plugin.ts` | **重用真 apply** | `import { Context } from '@deepseek-ai/cordis'`；`inject:['agents','sessionPersistence']`；不手拼 shim；`onDispose`→`ctx.effect`；`ctx.provide` 由 Service 注册取代 |
| 10 | `src/index.ts` | 改 barrel | 移除 `import './framework'` / `export * from './framework'`；改导出 `src/util` + 显式订单的原服务/事件导出 |
| 11 | `src/connectors/*` | 编译纳入 | 已 import 真 cordis；取消 exclude 后纳入 typecheck（6 个 module-not-found 已清零；残留 TS5097 靠 `allowImportingTsExtensions`） |
| 12 | 测试/示例 | 不改逻辑 | `persistence.test`、`e2e-core.test`、`transport-smoke`、`smoke.ts`、orchestration-loop 单测 必须全绿（它们应只依赖 `apply` + 服务公开 API） |

---

## 2. 执行顺序（依赖驱动 + 安全推进）

```
Phase A（等阻塞解除前可做，不碰 services/consumer）
  A0. 新建 src/util.ts：把 makeId / now 从 framework.ts 摘出来 → 6 个依赖方先改 import（纯搬移，零语义变化）
  A1. tsconfig：取消 connectors exclude + 开 allowImportingTsExtensions   ← 无副作用，先做
  A2. events.ts 改 declare module 目标（'./framework' → cordis）            ← 需先确认 cordis 合并约定
  A3. framework.ts 删除前：全仓 grep `from '../framework'`，列清全部依赖方   ← 已盘点（22 方，见上表）

Phase B（阻塞=编排循环交付 解除后）
  B1. 服务逐个 Service 化（roster→hive→ledger→courier→mandate）：保留接口、改实现形态
  B2. runtime/registry.ts + native-runtime.ts 的 import 切真 cordis
  B3. plugin.ts 改写为真实 apply + inject + Service 注册
  B4. index.ts barrel 清理 + 全量 typecheck（含 connectors）+ 全量测试
B 全程每步跑 `npx tsc -p tsconfig.json --noEmit` + 相关测试，保持可编译
```

> **为何先做 A0（util.ts）**：`framework.ts` 同时承载「Context shim」与「`makeId`/`now` 工具」两种职责。
> 若直接删 framework.ts，6 个文件的 `makeId`/`now` import 会全部断裂。先把工具迁到 `src/util.ts`
> 并让依赖方改指，再把 framework.ts 里仅剩的 shim 职责删除——拆分成两个独立可验证的小步。


---

## 3. 风险点与对策

| 风险 | 表现 | 对策 |
|---|---|---|
| **`onDispose` → `effect` 语义迁移** | 服务 dispose 时机错乱（timer/订阅残留） | 统一 `ctx.effect(() => () => void cleanup())`；已有一手实测避坑经验，逐个服务核对 dispose 行为 |
| **Service 未注册** | 忘写 `constructor super(ctx,'name')` → `ctx.x` 为 undefined | 每个 Service 显式构造器，加类型检查兜底 |
| **模块增强目标漂移** | events/服务增强合不到宿主的同一个 `@deepseek-ai/cordis` 实例 | 必须是 peerDependency（已装）；`declare module '@deepseek-ai/cordis'` 单源 |
| **API 签名回归** | transport / orchestration-loop / 测试因形态改动而 break | 公开接口（`RosterService` 等）原样保留，只改内部实现形态；测试为验收门 |
| **connectors 编译噪音** | TS5097（`.ts` 后缀相对 import） | tsconfig 开 `allowImportingTsExtensions`（此为非 emit 相关、纯类型导入，安全）；若涉及 emit 再评估 |
| **config 校验接入** | loader 校验 honeycomb config 需 zod/schemastery | 用已装的 schemastery 定义 `Config`；与 harness config 注入约定对齐 |
| **native-runtime ctx.agents** | 独立模式 hatch 抛错 | 保持「从 ctx 取 agents，未装配即明确报错」；core 独立只用 mock/connector（§7 已定稿） |
| **双 cordis 实例** | `instanceof Service` 失效、插件挂载失败 | strict peerDependency；不要升为 dependencies bundle 独立拷贝 |

---

## 4. 验收判据（Definition of Done）

1. `src/framework.ts` **已删除**，全仓无 `from '../framework'` 残留（`src/context.ts` 亦清理）。
2. `npx tsc -p tsconfig.json --noEmit` **0 error**（含 connectors，取消 exclude 后）。
3. 五个服务公开 API（接口签名）与迁移前一致（可 diff 确认）。
4. 现有测试全绿：`persistence.test`、`e2e-core.test`、`transport-smoke`、`smoke.ts`、orchestration-loop 单测。
5. `ctx.effect` 正确（dispose 后无残留 timer/订阅），可与 honeycomb-adaptor 同款验证。
6. 迁移记录：改了哪些文件、踩了什么坑（回填到本文件或 adapter README）。

---

## 5. 待阻塞解除的启动命令

```bash
cd /Users/qzp/aion2dsh/packages/honeycomb
# 每步门槛
npx tsc -p tsconfig.json --noEmit
npx tsx test/persistence.test.ts   # 及 e2e-core / transport-smoke / smoke
```
