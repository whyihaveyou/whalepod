# honeycomb-adaptor —— harness 真实可加载验证

> 任务产出：把 `@whalepod/honeycomb` 的 `apply(ctx)` 从「自造 shim 独立装配」推进到
> 「能被真实 deepseek-harness（cordis loader）加载」。
> 完整原理见 `../docs/harness-plugin-integration.md`。

## 文件

| 文件 | 作用 |
|---|---|
| `adaptor.ts` | 真实 `@deepseek-ai/cordis` 最小插件（依赖 `ctx.agents`，`ctx.effect` 范式 ✅） |
| `cordis.yml` | 主配置（顶层 entry 数组） |
| `cordis.patch.yml` | patch 层（insert/覆盖） |
| `verify-load.ts` | 直接驱动 `ctx.registry.plugin` 的加载验证（含 agents 桩） |
| `verify-loader.ts` | 模拟 loader 读 cordis.yml + patch 的端到端验证 |

## 验证结果（已 PASS，真实 cordis）

`verify-load.ts`：3 次心跳触发、dispose 后 0 残留。
`verify-loader.ts`：cordis.yml mount 成功、config 生效（interval=1000）、
heartbeat 触发、dispose 后无新 tick。

复跑：

```bash
cd /Users/qzp/aion2dsh/honeycomb-adaptor
NODE_PATH=/Users/qzp/.dsh/profiles/node_modules npx --yes tsx verify-load.ts
NODE_PATH=/Users/qzp/.dsh/profiles/node_modules npx --yes tsx verify-loader.ts
```

## 关键结论（迁移 honeycomb 时务必注意）

1. **必须用真实 `@deepseek-ai/cordis`**（peerDependency，与 harness 同源），
   删除 `src/framework.ts` 自造 shim。
2. **定时器/订阅必须用 `ctx.effect(...)`**，不要裸 `setInterval` + `return disposer`——
   后者 dispose 后可能不停（实测），前者由 fiber 可靠清理。
3. `inject: ['agents']` 声明依赖 harness 的 `AgentRegistry`（`super(ctx,'agents')` 注册）。
4. 服务提供用 `class X extends Service { constructor(ctx){ super(ctx,'x') } }` + `declare module '@deepseek-ai/cordis'{interface Context{...}}`。
