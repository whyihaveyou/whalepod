# @deepseek-ai/cordis 框架速查表

> 深研对象：`@deepseek-ai/cordis@4`（Shigma / Koishi 作者出品的 Cordis fork）+ `@deepseek-ai/cordis-plugin-loader` + deepseek-harness（dsh）的组装方式。
> 本文为后续实现 `@dfh/honeycomb` 的前置参考。所有 API 均来自本地安装源码
> `/Users/qzp/.dsh/profiles/node_modules/@deepseek-ai/cordis/src/*.ts`。

---

## 0. 心智模型（一句话）

Cordis = **带依赖注入（DI）的分层 Context 树** + **插件注册表（plugin registry）** + **事件总线（event bus）** + **Fiber 生命周期**。所有东西都挂在 `Context` 上，插件是「可 dispose 的、按需实例化的模块」，服务是「被注册到 Context 上、可被插件注入的对象」。

---

## 1. Service 定义与依赖注入

### 1.1 核心类关系

| 类/符号 | 文件 | 职责 |
|---|---|---|
| `Context` | `context.ts` | 分层容器 + 事件 + 生命周期入口。一切 API 的宿主 |
| `Service` | `service.ts` | 抽象基类，子类通过 `super(ctx, name)` 把自己注册成服务 |
| `RegistryService` | `registry.ts` | `ctx.plugin()` / `ctx.inject()` 的实现；`@Inject` 装饰器 |
| `ReflectService` | `reflect.ts` | `ctx.get()` / `ctx.provide()` / `ctx.set()` / `ctx.mixin()` 的服务解析与隔离存储 |
| `Fiber` | `fiber.ts` | 生命周期状态机；`ctx.effect()` / `dispose` / `update` / `restart` |
| `Events` | `events.ts` | 事件总线（`on/once/emit/parallel/serial/bail/waterfall`） |
| `LoggerService` | `logger.ts` | `ctx.logger()` 分级日志 |

### 1.2 内置服务（每个 Context 构造时自动注册）

每个 `Context` 在构造时都会安装 5 个内置服务，可通过 `ctx.get(name)` 或属性直接取：

| 服务名 | 属性/取值 | 说明 |
|---|---|---|
| `fiber` | `ctx.fiber` | 生命周期（当前 context 自己的 Fiber） |
| `reflect` | `ctx.reflect` | 服务反射表（DI 的真正实现） |
| `registry` | `ctx.registry` | 插件注册表 |
| `events` | `ctx.events` | 事件总线实例 |
| `logger` | `ctx.logger()` | 日志 |

### 1.3 定义一个 Service（服务）

```ts
import { Context, Service } from '@deepseek-ai/cordis'

// 服务必须继承 Service，并在构造时调用 super(ctx, '服务名')
class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myService')   // 注册名就是注入名
  }
  doThing() { /* ... */ }
}
```

要点：
- `super(ctx, name)` 内部调用 `ctx.reflect.provide(name, this, check)` 完成注册。
- 服务实例**按需懒创建**：`ctx.get('myService')` 首次访问时才实例化。
- 服务可以声明依赖（见下）。

### 1.4 注入（inject）—— 插件/服务如何拿到依赖

```ts
import { Context, Service, Inject } from '@deepseek-ai/cordis'

// 方式 A：函数式插件通过静态 inject 数组声明依赖
export const inject = ['myService', 'logger']

export function apply(ctx: Context, config: any) {
  const svc = ctx.get('myService')  // 注入的依赖通过 ctx.get 取
  // ...
}

// 方式 B：类服务通过 @Inject 装饰器（class 属性注入）
class MyPluginService extends Service {
  @Inject('myService')
  declare myService: MyService

  constructor(ctx: Context) {
    super(ctx, 'myPluginService')
  }
}
```

注入查找顺序（`reflect.get` 的 resolve 链）：**isolate → intercept → extend**，最后到 root。即「越近的隔离域越优先」。

### 1.5 Context 的三层关系（分层 DI 关键）

| 方法 | 语义 | 用途 |
|---|---|---|
| `ctx.extend(name?, config?)` | 普通子 Context | 插件作用域、分组 |
| `ctx.isolate(name, config)` | 隔离域（新 realm） | 服务被覆盖、互相隔离（如多租户） |
| `ctx.intercept(name, config)` | 拦截域 | 拦截并包装上游服务 |

- `ctx.root` 永远指向根 Context。
- `ctx.get(id, resolve)` 的 `resolve` 参数控制是否跨层解析（`symbols.resolve`）。

### 1.6 提供/设置/混入

```ts
ctx.provide('foo', value)      // 注册服务值（替代/覆盖）
ctx.set('foo', value)          // 设置一个「可写属性」，不参与 DI 解析链（用于基础配置）
ctx.mixin(name, config)        // 声明混入（组合多个服务）
```

---

## 2. Events 事件

事件总线挂在 Context 上，**全部支持 async**。分两类方法：

### 2.1 常规监听

```ts
ctx.on(event, listener)      // 监听（永不自动取消）
ctx.once(event, listener)    // 一次性监听
ctx.emit(event, ...args)     // 触发（不等待 listener 完成）
```

### 2.2 异步控制流（5 种 dispatch 模式）

| 方法 | 语义 | 返回值 |
|---|---|---|
| `ctx.parallel(event, ...args)` | 并行执行所有 listener | `Promise<void>` |
| `ctx.serial(event, ...args)` | 串行逐个执行 | `Promise<void>` |
| `ctx.bail(event, ...args)` | 串行，遇第一个非 falsy 返回值即停并返回它 | `Promise<T>` |
| `ctx.waterfall(event, ...args)` | 串行，每个 listener 的返回值作为下一个的入参 | `Promise<args>` |
| `ctx.emit` | 同步触发，不等待 | `void` |

### 2.3 内部事件约定（重要）

Cordis / loader 自身使用 `internal/...` 前缀事件做框架通信，例如：
- `internal/update` —— loader 配置热更新
- `internal/plugin` —— 插件挂载/卸载通知
- `loader/config-update` —— 配置写入触发

**自定义插件业务事件不要用 `internal/` 前缀**，避免与框架事件冲突。

---

## 3. Lifecycle / Disposables 生命周期

### 3.1 Fiber 状态机

`Fiber` 管理「一个 Context 的可 dispose 效果集合」。核心方法：

```ts
ctx.effect(callback, options?)   // 注册一个 effect，返回 disposer 函数
// callback 可以是 sync 或 async 的清理函数
```

关键点：
- **`apply(ctx, config)` 的返回值就是 disposer**：函数式插件返回一个清理函数，插件卸载时自动执行。
- `ctx.effect(() => { const timer = setInterval(...); return () => clearInterval(timer) })`

### 3.2 Fiber 状态（FiberState）

| 状态 | 含义 |
|---|---|
| `init` | 初始 |
| `start` / `started` | 启动中 / 已启动 |
| `refreshing` / `reloading` | 热更新刷新中 / 重载中 |
| `error` / `detach` / `dispose` | 出错 / 脱离 / 已释放 |
| `unload` | 已卸载 |

### 3.3 Fiber 核心方法

```ts
ctx.fiber.await()     // 等待所有已注册 effect 就绪
ctx.fiber.update()    // 重新读取配置并刷新（HMR 用）
ctx.fiber.restart()   // 重启
ctx.fiber.dispose()   // 释放：逆序执行所有 disposer
```

### 3.4 最小插件生命周期模板

```ts
export function apply(ctx: Context, config) {
  // 1. 注册资源，拿到 disposer
  const dispose = ctx.effect(() => {
    // 初始化
    return () => { /* 清理 */ }
  })

  // 2. 也可以直接 return 清理函数
  return dispose
}
```

---

## 4. Config（cordis.yml + patch）

### 4.1 配置文件角色

| 文件 | 角色 |
|---|---|
| `cordis.yml` / `cordis.json` | 主配置：**顶层必须是 entry 数组** |
| `cordis.patch.yml` | patch 层：按 id 覆盖/禁用/插入 entry |

### 4.2 Entry（条目）结构

```yaml
# cordis.yml
- id: timer          # 可选：全局唯一 id（patch 定位用）
  name: timer        # 插件名（npm 包名或 cordis: 内置名）
  config:            # 传给 apply(ctx, config) 的第二个参数
    interval: 1000
  inject: {}         # 可选：显式注入覆盖
  group: []          # 可选：组（含子 entry）
  disabled: false    # 可选：禁用
```

### 4.3 Patch（补丁）语义

```yaml
# cordis.patch.yml —— 顶层数组，按顺序应用
- id: timer            # 定位目标 entry
  name: timer          # 可选：校验名字匹配，防误覆盖
  config:              # 覆盖该 entry 的 config
    interval: 500
  disabled: true       # 禁用该 entry

- insert:              # 插入新 entry（到某 group 或顶层）
    - name: my-plugin
      config: {}
```

patch 应用规则（见 `dsh-app-boot` 的 `applyEntryPatches`）：
1. 有 `insert` 字段 → 插入（`id` 存在则插入到该 group 内，否则顶层）。
2. 无 `insert` → 必须有 `id`，按 id 找目标，逐字段覆盖（`id` 字段本身不可覆盖）。
3. `name` 与目标不匹配 → 跳过并告警。
4. 匹配不到任何 entry → 跳过并告警。

### 4.4 `!!js` 表达式（YAML 方言）

config 值可以是 JS 表达式，用 `!!js` 标签标量：

```yaml
- name: my-plugin
  config:
    value: !!js "process.env.FOO ?? 42"   # 加载时求值
```

loader 内部用 `js-yaml` 的 `JSON_SCHEMA.extend(JsExpr)` 解析，`isJsExpr` 判定、`evaluate` 求值。**写回文件时 `!!js` 会原样 round-trip**（`represent` 保留表达式原文）。

### 4.5 内置 entry 名

| 名 | 包 | 作用 |
|---|---|---|
| `cordis:include` | `@deepseek-ai/cordis-plugin-loader` | 加载一个配置文件（include 其它 yml） |
| `cordis:group` | `@deepseek-ai/cordis-plugin-group` | 分组/隔离域 |
| `cordis:internal` | 内置 | 内部插件 |

---

## 5. Persistence 持久化

### 5.1 谁负责写回

loader 的 `EntryTree`（抽象基类）定义 `write()` 接口；dsh 用 `Include` 类实现真正的文件写回（见 `@deepseek-ai/dsh-app-boot`）。

```
EntryTree (abstract)
  └─ Include extends EntryTree     ← dsh 的 YAML/JSON 文件实现
       static inject = ['loader']
       static [EntryGroup.key] = true
```

### 5.2 写入流程

1. 业务代码调用 `entry.update(config)` 或 `loader.create(...)` / `entry.remove()`。
2. loader 内部触发 `Include.write()`。
3. `Include.write()` → `emit('loader/config-update')` → `writeFile(root.data)`。
4. `_writeFile`：`yaml.dump(config, { schema })`（YAML）或 `JSON.stringify`（JSON）→ 写 `.tmp` 文件 → `rename` 原子替换。
5. 写失败（EACCES/EBUSY/EPERM）→ 重试最多 10 次，退避 50ms*n；仍失败则降级为 readonly（`checkAccess` 检测无写权限也会置 readonly）。

### 5.3 热更新 / 刷新

- `Include.read()` 读文件 → 内容变化时 `_apply(candidate)` 事务性刷新子 entry（rollback 保护，失败回滚到最后一份好配置）。
- `Include` 监听 `internal/update` 事件，配置 patch 变化时重新 apply。

### 5.4 关键持久化 API

```ts
loader.create(entry)     // 新增 entry，返回 id
entry.update(config)     // 更新某 entry 的 config（触发写回）
entry.remove()           // 删除 entry
loader.write()           // 立即写回
```

---

## 6. deepseek-harness（dsh）如何组装 Cordis

`boot()`（`@deepseek-ai/dsh-app-boot`）的启动序列：

```ts
const ctx = new Context()
ctx.baseUrl = pathToFileURL(dirname(configPath)).href + '/'
ctx.provide('dshHomePath', dshHomePath)   // 注入 harness 家目录
await ctx.plugin(Loader)                   // 挂载 loader 服务
await prepare?.(ctx)                       // 应用侧准备钩子
await mountRootInclude(ctx, configPath, patches, baseModuleBaseUrl)
await ctx.get('loader')?.await()           // 等待插件树就绪
await assertEntriesActivated(ctx, binName) // 校验所有 entry 都激活
```

`mountRootInclude`：
- `ctx.loader.builtins.include = Include`（或 Host 解析子类）
- `ctx.loader.builtins.group = Group`
- 创建根 include entry（`id: "include"`, `name: "cordis:include"`, `config.path = 配置文件 URL`）

### 6.1 Profile 分层（dsh 特有）

```
profile 目录 (package.json 声明 dsh.profile.bundles 有序列表)
  ├─ cordis.patch.yml        ← 用户 patch 层（最后 apply）
  └─ node_modules/           ← pnpm 管理的 out-of-tree 插件

bundle 包（npm 包，manifest 声明 "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}）
  └─ 每个 bundle 的 patch 按 bundles 顺序逐层 apply
```

最终 entry 列表 = **空列表 → 逐个 bundle patch → profile 自身 patch → launcher patch 层**。

---

## 7. 最小可运行插件示例

见同目录 `../examples/cordis-minimal-plugin/`。核心要点：

```ts
import { Context } from '@deepseek-ai/cordis'

export const name = 'minimal-counter'

// 可选的配置 Schema（用 zod 的 StandardSchema 亦可）
export interface Config { interval?: number }

export function apply(ctx: Context, config: Config = {}) {
  const { interval = 1000 } = config
  let n = 0
  // ctx.effect 返回 disposer，插件卸载时自动清理
  const timer = ctx.setInterval(() => {
    ctx.logger('minimal-counter').info('tick', ++n)
  }, interval)
  return () => clearInterval(timer)
}
```

运行（依赖 dsh 的 loader 生态）：

```bash
# 在含 @deepseek-ai/cordis 的环境里
node --loader tsx examples/cordis-minimal-plugin/main.ts
```

---

## 8. 速查：常用 API 一页表

| 需求 | API |
|---|---|
| 注册服务 | `class S extends Service { constructor(ctx){ super(ctx,'s') } }` |
| 取服务 | `ctx.get('s')` / `ctx.s` |
| 覆盖服务 | `ctx.provide('s', value)` |
| 挂插件 | `ctx.plugin(plugin, config)` |
| 注入依赖 | `static inject=[...]` + `ctx.get(...)`；类用 `@Inject('s')` |
| 监听事件 | `ctx.on/once('evt', fn)` |
| 异步事件 | `ctx.parallel/serial/bail/waterfall('evt', ...)` |
| 注册清理 | `ctx.effect(() => disposer)` 或 `apply` 返回 disposer |
| 等待就绪 | `ctx.fiber.await()` |
| 释放 | `ctx.fiber.dispose()` |
| 热更新 | `ctx.fiber.update()` / `entry.update(config)` |
| 写配置 | `loader.create/update/remove` → 自动 `write()` |
| 日志 | `ctx.logger('name').info/warn/error(...)` |
| 子上下文 | `ctx.extend/isolate/intercept(name, config)` |
| 配置表达式 | YAML `config: !!js "expr"` |
