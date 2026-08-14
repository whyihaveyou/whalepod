# 最小可运行 Cordis 插件示例

对应速查表：`../../docs/cordis-quick-reference.md`。

## 文件

| 文件 | 作用 |
|---|---|
| `plugin.ts` | 插件本体：Service 定义、注入、事件、生命周期、配置 |
| `main.ts` | 手写运行入口（真实 dsh 里由 loader 替代） |
| `cordis.yml` | loader 配置示例（含 patch 注释） |

## 运行

需要能解析 `@deepseek-ai/cordis` 的环境（本地已装在
`/Users/qzp/.dsh/profiles/node_modules/@deepseek-ai/cordis`）。

```bash
# 通过 dsh 的 node_modules 解析（示例用 tsx 直接跑 TS）
cd /Users/qzp/aion2dsh/examples/cordis-minimal-plugin
NODE_PATH=/Users/qzp/.dsh/profiles/node_modules \
  npx --yes tsx main.ts
```

预期输出（每 500ms 一行，3 次后自动退出）：

```
minimal-counter started (interval 500ms), waiting for 3 ticks...
[minimal-counter] hello, Cordis #1
[minimal-counter] hello, Cordis #2
[minimal-counter] hello, Cordis #3
reached 3 ticks, shutting down...
context disposed. bye.
```

## 五个主题的对应位置

- **Service + DI**：`GreetingService`（`super(ctx,'greeting')`）+ `greeting-provider` 注册 + `minimal-counter` 的 `inject=['greeting']` + `ctx.get('greeting')`
- **Events**：`ctx.parallel('minimal-counter/tick', n)` + `ctx.on(...)`
- **Lifecycle/Disposables**：`apply` 返回 `() => clearInterval(timer)` + `ctx.fiber.dispose()`
- **Config**：`apply(ctx, config)` 读取 `{ name, interval }`，见 `cordis.yml`
- **Persistence**：真实 dsh 里计数器状态可通过 `loader` 的 `entry.update()` 写回 yml（本示例为最小化省略）

## 注意

- 真实 dsh 里 `ctx.logger()` 有 exporter 注入；bare cordis 默认无输出，故示例用 `console.log` 保证可见。
- 真实 dsh 里无需 `main.ts`，loader 直接读 `cordis.yml` 挂载插件；`main.ts` 仅用于最小闭环演示。
