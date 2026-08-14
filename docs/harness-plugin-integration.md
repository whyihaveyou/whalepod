# @dfh/honeycomb → deepseek-harness 插件真实接入说明

> 目标：把 `@dfh/honeycomb` 的 `apply(ctx, config)` 从「基于自造 shim 的独立装配」
> 推进到「能被真实 deepseek-harness 运行时（dsh-boot + dsh-loader）加载」。
>
> 事实来源：`/Users/qzp/aion2dsh/deepseek-harness/packages/**` 源码 +
> `/Users/qzp/.dsh/profiles/node_modules/@deepseek-ai/cordis*/**` 源码。

---

## 0. 现状与核心结论

- **harness 用真实 `@deepseek-ai/cordis`**：它的每个插件包都写
  `declare module '@deepseek-ai/cordis' { interface Context { ... } }`，服务继承
  `Service` 并 `super(ctx, name)`。因此 honeycomb 必须依赖同一个 cordis 实例，
  **不能再用自造的 `framework.ts` shim**。
- **honeycomb 现状**：`plugin.ts` 里 `import type { Context } from './framework'`
  （自造 shim，镜像了 cordis 的 on/emit/parallel/provide/get/effect 等 API，但**不是**
  真实 cordis）。要接入 harness，需把类型注记换成 `@deepseek-ai/cordis`，并把
  `ctx.provide(...)`/`ctx.get(...)`/`ctx.emit(...)` 换成真实 cordis 的服务/事件写法。
- **好消息**：honeycomb shim 的 API 面与真实 cordis **高度同构**，迁移主要是
  「换 import + 把服务从工厂函数式换成 `class XxxService extends Service`」。

---

## 1. 插件如何被 harness 的加载器发现并启用

### 1.1 链路

```
dsh-boot(app-boot) 
  → 创建 root Context
  → ctx.plugin(Loader)                     // @deepseek-ai/cordis-plugin-loader
  → 读 Profile（node_modules 里按 bundles 顺序收集 patch）
  → mountRootInclude：把用户 cordis.yml / cordis.patch.yml 折叠成 entry 树
  → Loader 逐个 Entry 解析、import、挂载
```

### 1.2 Entry -> 插件对象 -> 挂载

loader 对 `cordis.yml` 里每个 entry：

```ts
// ①按 name import
plugin = unwrapExports(await tree.import(entry.name))  // ESM/CJS 都取到插件
// ②挂到 context
fiber = ctx.registry.plugin(plugin, entry.config)
await fiber.await()
```

- `unwrapExports`：`exports = exports.default ?? exports`，再 `default ?? exports`。
- `ctx.registry.plugin(plugin, config)` 接受三种形态：
  1. **函数型**：`function apply(ctx, config) { ... }`（返回 disposer，可选 `name`/`inject` 静态字段）。
  2. **对象型**：`{ name, inject, apply }`。
  3. **class 型**：`class X extends Service { static Config: z; apply(){} }`，`static Config` 用于 config Schema。

### 1.3 Tharefore honeycomb 需要什么

`@dfh/honeycomb` 包需满足：
1. **入口导出默认插件对象**（`.default` 或 `{ apply, name, inject }`）——cordis-plugin-loader 取 default。
2. 若以包名 `name: '@dfh/honeycomb'` 被 cordis.yml 引用，loader 会自身份目录 `import('@dfh/honeycomb')`，
   所以该包**必须能作为模块被 load**（有 `exports`/`main` 指向编译产物，且能 `import` 到 cordis）。
3. `apply(ctx, config)` 里 `import { Context } from '@deepseek-ai/cordis'`——**与 harness 同源**。

---

## 2. apply(ctx) 的 ctx 服务映射（honeycomb ⇄ harness 实际服务）

真实 cordis `Context` 是 Proxy：`ctx.get(name)` 返回注册的服务，方法集来自混入服务：

| 子域 | 真实 cordis 来源 | harness 暴露名 | honeycomb shim 现用 | 迁移动作 |
|---|---|---|---|---|
| 服务注册 | `reflect` | `ctx.provide/get/set/mixin/accessor` | `ctx.provide/get` | 换成 `class extends Service` + `super(ctx,name)` |
| 依赖注入 | `registry` | `ctx.inject(...)` / `static inject` | 工厂函数 + deps 参数 | 用 `inject` 数组 + `ctx.get()` |
| 插件挂载 | `registry` | `ctx.plugin(plugin, config)` | 手动装配 | 直接可用 |
| 事件总线 | `events` | `ctx.on/once/off/emit/parallel/serial/bail/waterfall` | `ctx.on/emit/parallel/...` | 直接可用（同构） |
| 生命周期 | `fiber` | `ctx.effect()/onDispose()`，apply 返回 disposer | `ctx.dispose/ctx.root` | 用 `ctx.effect`/返回 disposer |
| 日志 | `logger` | `ctx.logger(name)` | 无 | 接 `ctx.logger()` |
| 作用域 | `reflect` | `ctx.extend/isolate/intercept` | `ctx.scope` | 用 `ctx.extend`/`isolate` |

### 2.1 harness 暴露给插件的核心服务（部分列举）

| ctx 服务 | 类型 | 说明（映射用途） |
|---|---|---|
| `ctx.agents` | `AgentRegistry` | 孵化/恢复/注册/进入 agent。**honeycomb 团队孵化的落点** |
| `ctx.agent?` | `Agent` | 仅 Agent.ctx 上有；标识当前 agent 关联 |
| `ctx.sessionPersistence` | `SessionPersistence` | 会话级持久化（append/load）。**对应 honeycomb persistence** |
| `ctx.systemPrompt` | `SystemPromptService` | agent 系统提示词组合 |
| `ctx.workspace` | `WorkspaceService` | 工作区管理 |
| `ctx.storage` | `StorageService` | 键值存储 |
| `ctx.tools` | `ToolsService` | 工具注册 |
| `ctx.agentLoop` | `AgentLoop` | agent 主循环 |
| `ctx.commands` | `CommandsService` | slash 命令 |
| `ctx.llm` | `LlmService` | LLM 调用 |
| `ctx.settings` / `ctx.credentials` | … | 配置/凭据 |

### 2.2 `ctx.agents`（AgentRegistry）API —— honeycomb `ctx.agents` 目标

```
create(options: CreateAgentOptions): Promise<AgentHandle>
resume(options: ResumeAgentOptions): Promise<AgentHandle>   // 恢复会话
register(agent: Agent): () => void                           // 注册
enter(agent, owner): () => void                              // 代理关联切换
announce(agent: Agent): void                                 // 公告就绪
get(id: SessionId): Agent|undefined
isOwnedBy(id, owner): boolean
list(): Agent[];  roots(): Agent[]
currentInitiator(): Agent|undefined;  requireInitiator(): Agent
setFactory(factory: AgentFactory): () => void
```

harness 中**孵化一个 agent** 对应 honeycomb `RosterService.hatch`；监听 agent 事件用
`ctx.on('agent/...', ...)`。

---

## 3. config 如何注册进 cordis.yml + patch

### 3.1 主配置 `cordis.yml`（顶层 entry 数组）

```yaml
# 项目根 或 profile 主配置
- id: honeycomb            # 全局唯一 id（patch 定位用）
  name: '@dfh/honeycomb'   # 插件包名（loader import 解析用）
  config:                  # 传给 apply(ctx, config) 的第二参数
    defaultHiveMode: isolated
    defaultWorkspaceMode: relative
    persistence:
      backend: store
  disabled: false
```

> 若 harness 从 `examples/` workspace 挂载，`name` 也可用相对路径（如 `./honeycomb.mjs`），
> 或通过 `examples/package.json` 声明 `"@dfh/honeycomb": "workspace:*"` 用包名。

### 3.2 patch 层 `cordis.patch.yml`

patch 用于**不碰主配置**地覆盖/插入/禁用 entry（多 profile 共享同一份主配置时必备）：

```yaml
# cordis.patch.yml
- id: honeycomb            # 定位要覆盖的 entry
  name: '@dfh/honeycomb'   # 可选：校验名字，防误覆盖
  config:
    defaultHiveMode: flyingCoin   # 覆盖 config 字段

# 追加一个新 entry（不覆盖已有主配置）
- insert:
    - id: honeycomb-extra
      name: '@dfh/honeycomb'
      config: {}
```

规则（cordis-plugin-loader `applyEntryPatches`）：
- 有 `insert` → 插入（`id` 存在则插入到该 group，否则顶层）。
- 无 `insert` → 必须有 `id`，按 id 覆盖（`id` 字段本身不可覆盖）；`name` 不匹配则跳过并告警。
- patch 按 bundle 顺序逐层叠加：**空列表 → bundle patch 们 → profile patch → launcher patch**。

### 3.3 harness 里 config Schema

函数型插件可用 `static Config`（cordis 内置 zod 校验）：在插件对象上挂
`offer.Config = ZodObj<Config>`，或 class 型插件 `static Config`。honeycomb 现有
`config.ts` 的 `ResolvedHoneycombConfig` 可保留为 TS 类型 + 一个 zod schema。

---

## 4. 最小可加载 patch / 示例

（见 `honeycomb-adaptor/` 目录：真实 cordis 写法的最小插件 + cordis.patch.yml + 两个已验证脚本）

### 4.1 ⚠️ 关键：定时器/订阅必须用 `ctx.effect`，不要裸 `return disposer`

实测（见 §5 验证日志）：cordis 函数插件若 `apply` 里裸 `setInterval(...)` 再 `return () => clearInterval(timer)`，
`fiber.dispose()` 后定时器**可能不会停**（依赖 apply 返回值的收集时序，具名 `function` 与箭头 `const`
行为不一致）；而用 **`ctx.effect(() => { const t=setInterval(...); return () => clearInterval(t) })`**
注册，disposer 由 fiber 可靠逆序执行，`dispose` 后 0 残留。

这与 cordis 官方 `cordis-plugin-timer` 的写法一致（`ctx.effect(() => { const timer=setInterval(...); return () => clearInterval(timer) }, 'ctx.interval()')`）。
**honeycomb 迁移务必沿用 `ctx.effect` 范式。**

### 4.2 最小「真实 cordis」插件（对照 honeycomb 改造法）

```ts
// honeycomb-adaptor/adaptor.ts —— 最小可加载插件（已通过真实 cordis 验证）
import { Context } from '@deepseek-ai/cordis'

export const name = '@dfh/honeycomb'           // cordis.yml name 引用
export const inject = ['agents']               // 声明依赖 harness 服务

export function apply(ctx: Context, config: { interval?: number } = {}) {
  const { interval = 1000 } = config
  const logger = ctx.logger('honeycomb')

  // ✅ 用 ctx.effect（cordis 官方范式）
  ctx.effect(() => {
    const timer = setInterval(() => {
      const n = ctx.agents.list().length
      logger.info('hive heartbeat: %d live agents', n)
      void ctx.parallel('honeycomb/heartbeat', { liveAgents: n })
    }, interval)
    return () => clearInterval(timer)
  }, 'honeycomb:heartbeat')

  ctx.effect(() => {
    const off = ctx.on('agent/ready', (agent) => logger.info('agent ready: %s', agent.id))
    return () => off?.()
  }, 'honeycomb:agent-ready')
}
```

### 4.3 最小 patch

```yaml
# honeycomb-adaptor/cordis.patch.yml
- insert:
    - id: honeycomb
      name: '@dfh/honeycomb'
      config:
        interval: 1000
```

### 4.4 通用最小入口（若内部想暴露 Service）

```ts
// 服务写法（真实 harness 惯例）
declare module '@deepseek-ai/cordis' {
  interface Context { honeycomb: HoneycombService }
}
class HoneycombService extends Service {
  constructor(ctx: Context) { super(ctx, 'honeycomb') }
  // ... 编排 API（hive/roster/mandate/ledger/courier 从 factory 迁到这里）
}
export function apply(ctx: Context, config: Config) {
  // 注册服务 + 订阅 harness 事件（agent 生命周期事件）
  new HoneycombService(ctx)
  ctx.on('agent/ready', (agent) => { /* 接入 roster */ })
  return () => {}
}
```

---

## 5. 最小验证步骤（在 deepseek-harness 仓库里）

### 5.0 ✅ 已在本机验证通过（真实 @deepseek-ai/cordis）

`honeycomb-adaptor/verify-load.ts`（直接 `ctx.registry.plugin` + 桩 agents）：

```
[verify] plugin mounted: @dfh/honeycomb
[verify] honeycomb/heartbeat {"liveAgents":2}   ×3
[verify] ticks received = 3 (PASS)
[verify] no ticks after dispose = PASS
[verify] DONE
```

`honeycomb-adaptor/verify-loader.ts`（模拟 loader 读 cordis.yml+cordis.patch.yml，js-yaml）：

```
[loader] cordis.yml entries: honeycomb
[loader] mounted "honeycomb" ok, config={"interval":1000}
[loader] heartbeat #1 {"liveAgents":2}
[loader] ticks = 1 (PASS)
[loader] new ticks after dispose = 0 (PASS)
[loader] DONE
```

复跑方式：

```bash
cd /Users/qzp/aion2dsh/honeycomb-adaptor
NODE_PATH=/Users/qzp/.dsh/profiles/node_modules npx --yes tsx verify-load.ts
NODE_PATH=/Users/qzp/.dsh/profiles/node_modules npx --yes tsx verify-loader.ts
```

> `NODE_PATH` 指向本机已装的 `@deepseek-ai/cordis*`，以便 ESM 解析。

### 5.1 作为 workspace 包挂载（若能 access harness monorepo）

```bash
cd /Users/qzp/aion2dsh/deepseek-harness

# ① 把 honeycomb 加进 harness examples/ 的 workspace 依赖
#    (honeycomb 需 built 出 ESM 产物，且 package.json 有 exports["."].import → lib/index.js)

# ② 准备一个 profile 目录，写两份文件
mkdir -p profiles/hc && cat > profiles/hc/cordis.yml <<'EOF'
- id: honeycomb
  name: '@dfh/honeycomb'
  config:
    interval: 1000
EOF
cat > profiles/hc/cordis.patch.yml <<'EOF'
- insert:
    - id: honeycomb-extra
      name: '@dfh/honeycomb'
      config: {}
EOF

# ③ 启动 harness（boot 入口，logs/ 输出）
# 以 web 入口为例（或任一 dsh boot bin）：
node packages/boot/app-boot/bin/dsh-profile.mjs run web  # 实际命令以仓库 scripts 为准
```

### 5.2 不侵入 monorepo 的最小验证（已实现：verify-load.ts / verify-loader.ts）

已在 §5.0 用独立脚本完成（直接驱动 `ctx.registry.plugin` 与 loader 语义），
无需改动 harness 仓库即可验证插件可加载。

### 5.3 判定「加载成功」

1. loader 无 `import`/`apply` 报错，日志出现 `apply · @dfh/honeycomb`。
2. `ctx.agents.list()` 随 agent 创建变化；自定义事件 `honeycomb/tick` 被监听方收到。
3. config 能从 `cordis.patch.yml` 覆盖（改 `interval` 后热更新生效，fiber.update）。

---

## 6. 迁移清单（honeycomb 内部，供实现接手）

> ⚠️ **第一步（也是被 leader / 连接器-Pro 验证的核心）**：
> **给 `packages/honeycomb/package.json` 添加 `@deepseek-ai/cordis` 依赖（peerDependency），
> 然后全量切真 cordis —— 不只改 `plugin.ts`**。
> 现状：`src/connectors/registry.ts`（连接器骨架的 registry service）**已经 import 真实
> `@deepseek-ai/cordis`（Context, Service）+ `@deepseek-ai/schemastery`**，且在逻辑方向上与
> 本方案一致，但 `packages/honeycomb/package.json` 尚未安装这两个依赖 → typecheck 报错。
> 同时 `tsconfig.json` 的 `exclude: ["src/connectors"]` `目前把 connectors 从 typecheck 排除`，
> 全量切真 cordis 时需**取消该 exclude**，让 connectors 也纳入编译与类型检查。

| 项 | 现在 | 改成 |
|---|---|---|
| **依赖** | package.json 无 `@deepseek-ai/cordis`；connectors 已 import 真 cordis+schemastery 但没装 | **新增依赖：`@deepseek-ai/cordis`（peer）+ `@deepseek-ai/schemastery`（若 connectors 要编译）**；tsconfig 取消 `exclude: ["src/connectors"]` |
| `src/framework.ts` Context shim | 自造 | 迁移后用真实 `@deepseek-ai/cordis`，**删除 shim** |
| `plugin.ts` 引入 | `import type { Context } from './framework'` | `import { Context } from '@deepseek-ai/cordis'` |
| `context.ts` 服务声明合并 | 自造声明 | 改用 `declare module '@deepseek-ai/cordis' { interface Context { ... } }` |
| 服务（hive/roster/mandate/ledger/courier + connectors registry） | `factory(ctx, deps)` 工厂 | `class X extends Service { constructor(ctx){ super(ctx,'x') } }` + `declare module` |
| 事件 | `ctx.emit('hive/created', ...)` | 复用 `@deepseek-ai/cordis` events（同名即可） |
| persistence | `persistence/store.ts` FactStore | 接 harness `ctx.sessionPersistence`（或保留自研 store 作后备） |
| config | `config.ts` ResolvedHoneycombConfig | 保留类型 + 加 zod `Config`（供 loader 校验） |
| 依赖 harness 服务 | 无 | `inject: ['agents', 'sessionPersistence']` + `ctx.get` |
| 孵化 agent | RosterService.hatch | 委托 `ctx.agents.create/resume`（AgentRegistry） |
| `runtime/registry.ts`、`native-runtime.ts` | import `'../framework'` shim | import 真 cordis；见 §7 运行模式结论 |

> 注意：honeycomb 依赖 `@deepseek-ai/cordis` 必须是 **peerDependency**，与 harness
> 共享同一份实例（否则 `ctx.plugin(plugin)` 会因不同 Context 原型而挂载失败）。

---

## 7. 挂载运行模式结论（原生 runtime 直跑 vs 仅 harness 可用）

**核心映射**：honeycomb core 自身**没有** `ctx.agents`——`ctx.agents`（AgentRegistry）
是 harness 侧（`core/agent`）提供的服务。

- **独立模式（core 单独跑，无 harness）**：`Service` 里 `ctx.agents` **未装配**。
  `native-runtime`（原生女王/成员孵化）在 hatch 时访问 `ctx.agents` 会**抛错**
  （实测 `native-runtime.ts` 注释已标注「未装配时抛错」）。做法是绕过：测试/独立模式用
  **mock runtime 或 connector runtime**（不开原生孵化）。
- **挂载进 harness 后**：`ctx.agents` 由 harness 提供（AgentRegistry `super(ctx,'agents')`），
  原生孵化可正常走。**结论：原生 runtime 直跑仅 harness 可用；core 独立模式只支持
  mock / connector runtime。**

这对迁移的含义：`runtime/native-runtime.ts` 的 `ctx.agents` 依赖是「挂 harness 才满足」的，
接入验证清单要含此判断；核心逻辑（roster/mandate/ledger/courier）保持 cordis 服务化，
不绑定 `ctx.agents` 的耦合，只在 hatch 原生时取 `ctx.agents`。

---

## 8. 附：npm 分发版与 clone 仓库差异（backlog 记录）

- harness 官方以 **npm 包分发**：`@deepseek-ai/dsh@0.1.0-rc.6` + `@deepseek-ai/dsh-*` 插件全家桶
  （见 `/Users/qzp/aion2dsh/refs/dsh-desktop` 的 package.json）。
- 该桌面壳（dataelement/dsh-desktop，MIT）通过 **patch-package** 给上游 npm 包打补丁，而非 fork。
- **对插件加载路径的影响**：若 honeycomb 以 npm 分发版验证，入口/加载路径可能与我们
  clone 的 `deepseek-harness` 仓库源码有差异（npm 版走 `node_modules/@deepseek-ai/dsh*`）；
  发现差异时记录即可，不必展开。我们的开发/验证以 clone 仓库为准。
