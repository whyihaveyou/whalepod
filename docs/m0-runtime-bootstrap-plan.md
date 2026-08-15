# M0 运行时自举方案调研：把 node + @deepseek-ai/dsh 全家桶打进 .app（免装 Node 一键起）

> 状态：方案调研完成（docs only，未碰 HarnessShell 源码 / package.json）。
> 依据：docs/shell-oobe-proposal.md ① 运行时自举 + refs/dsh-desktop（dataelement/dsh-desktop）实测。
> 前置：OOBE-M2 已把数据根迁到 `~/Library/Application Support/WhalePod/`，
>         `HarnessServiceManager.mergedEnvironment()` 注入 `DSH_HOME=WhalePod/harness`。
> 实现排期：等 rebrand #01a00124 落地后再动 Swift 实现。

## 一、参考实现 dsh-desktop 怎么做的（已研究）

- **Node 来源**：`options.nodeExecutable = process.execPath`；Electron 主进程用
  `ELECTRON_RUN_AS_NODE=1` 环境中以 Node 模式执行自身二进制（Electron 内嵌 Node）——
  所以 **dsh-desktop 没有单独打 node**，它"免费"复用 Electron 自带的 Node。
- **dsh 入口**：`dshEntryPath = <app>/node_modules/@deepseek-ai/dsh/lib/bin.js`。
- **打包方式**（electron-builder）：`"asar": false` + `"npmRebuild": false` +
  `files: ["out/**/*", "node_modules/**/*", "package.json"]` —— 即**把 node_modules 整个拷进 .app**，
  不压缩不改装。
- 启动：spawn `node bin.js <args>` + 注入环境（reservePort/DSH_HOME 等）。

> 关键差别：**我们 Swift 壳没有内嵌 node**（无 Electron）。这是方案的核心差异点。

## 二、三方案对比（核心结论 ①/②）

### 方案 a：bundled —— 官方 node arm64 tarball 解进 .app
- Node 从哪拿：**node 官方 darwin-arm64 tarball**（`https://nodejs.org/dist/v22.x.x/node-v22.x.x-darwin-arm64.tar.xz`，
  含 `bin/node` + 依赖动态库），解到 `.app/Contents/Resources/node/`。
- dsh 全家桶离线：`npm pack @deepseek-ai/dsh`（+ 依赖）放进 `Resources/node_modules/`。
- 启动：绝对路径 `Resources/node/bin/node Resources/node_modules/@deepseek-ai/dsh/lib/bin.js web ...`。
- 体积：node binary 解压 ≈ 80–90MB；dsh 全家桶 ≈ 数 MB（纯 JS，见下预估）。

### 方案 b：本机 node 探测 —— 优先复用系统 node
- 探测链：`where node` → `/opt/homebrew/bin/node` → `/usr/local/bin/node` → 环境 PATH。
- 找到就用其跑 `@deepseek-ai/dsh/lib/bin.js`（node_modules 仍内置，或用 npx 解析）。
- 体积：0（不带 node）；首启快；但依赖用户本机有 node。

### 方案 c：首启 npx 拉取 fallback
- 都没有 → `npm exec @deepseek-ai/dsh web`（当前默认命令形态），自动拉取；无 node/npm 则明确报错引导安装。
- 体积：0；但首启耗时最长（下载）、依赖网络、需 npm。

| 维度 | a) bundled | b) 本机探测 | c) npx fallback |
| --- | --- | --- | --- |
| .app 体积 | +80–90MB（node） | +0 | +0（仅运行时缓存） |
| 离线可用 | ✅ 完整 | ✅（本机有 node 时） | ❌ 需网络 |
| 首启耗时 | 快（解压一次） | 最快 | 慢（npm 下载） |
| 更新机制 | 随 app 发版升级 | 随系统 node 走 | 每次 npx 解析最新 |
| 签名影响 | node 二进制需一并签名/公证 | 无（用系统 node） | 无 |
| 用户门槛 | 免装 Node | 需 Node 或在 PATH | 需 npm+网络 |

## 三、推荐主链路（核心结论 ③）

**推荐 a + b 组合：bundled 优先 → 本机 node 探测 → npx 兜底**

```
启动 harness 时：
1. bundled：若 Resources/node/bin/node 存在且可执行 → 用它（离线、版本自管、最稳）
2. 本机探测：否则按探测链找 node → 用它（省体积、跟随系统）
3. npx 兜底：都找不到 → 回落到 "npm exec @deepseek-ai/dsh web" + 引导安装 node
```

- **默认分发形态**（推荐打包）：a + b。bundled 为主，保证"免装 Node 一键起 + 离线"；
  本机 node 作为可选项（若用户装了新版 node 可借此跑最新 dsh）。
- 三种形态共用同一 `dsh lib/bin.js` 入口，仅 node 可执行文件路径不同，代码改动集中在一处"命令形态枚举"。

## 四、.app 体积预估
- node 官方 darwin-arm64 v22 解压：`bin/node` ≈ 80–90MB（含内置模块；tar.xz ≈ 24MB 分发）。
- `@deepseek-ai/dsh` 全家桶（dsh + client-ui + 运行时依赖，纯 JS）：预估 **5–15MB**（npm pack 后 node_modules
  展开）。可再 `pnpm prune --prod` 去掉开发依赖。
- 合计增量：**≈ 90–105MB**。对开发者工具类 .app 属可接受（对比 dsh-desktop 体积同量级）。
- 若走纯 b+c（不带 bundled）：增量 ≈ 0。

## 五、dsh 全家桶怎么离线打进 .app（核心结论②）

**推荐：`npm pack` 全量 + `pnpm install --prod` 生成纯净 node_modules，而不是整拷 pnpm store。**

- 理由：pnpm store 是 content-addressable（含大量无关版本/缓存，2.6G），不能直接拷；node_modules 整拷
  会带 devDependencies 和符号链接。
- 正确做法：
  1. 用 `npm pack`（或 `pnpm pack`）对每个 `@deepseek-ai/*` 运行时依赖打 tarball；
  2. 在构建机临时目录 `npm install <tarballs> --omit=dev` 生成纯净 node_modules；
  3. 把该 node_modules 拷进 `.app/Contents/Resources/node_modules/`。
- 版本固定：锁 `@deepseek-ai/dsh` 具体版本（如 `0.1.0-rc.6`，dsh-desktop 同款），避免漂移。
- 升级：随 .app 发版重打 tarball 即可；bundled node 与 dsh 打包版同步升级。

## 六、ServiceConfig.command 形态改造建议（核心结论③）

现状：`ServiceConfig.command` 是一个 shell 字符串（默认 `"npm exec @deepseek-ai/dsh web"`，经 `zsh -lc` 执行）。
M0 需把它升级为「运行时自举枚举」，command 由壳在启动时按探测结果解析生成，而非用户手写一句 shell。

建议改造（不破坏 config.json 语义，向后兼容）：

```swift
enum RuntimeBootstrap {
    case bundled                      // Resources/node + Resources/node_modules（离线优先）
    case nodeProbe                    // 本机 node（which node / homebrew）+ 内置 node_modules
    case npxFallback                  // npm exec @deepseek-ai/dsh（无 node 时兜底 + 引导安装）
    case custom(String)               // 用户 config.json 里手写的 command（兼容现状，优先级：custom > 自动）
}
```

- **解析顺序**：`RuntimeBootstrap` 探测链（bundled → probe → npx），生成 `[nodePath, binPath, "web", ...args]`；
- **config.json 兼容**：保留 `command` 字段。若用户手动填了 command → 用 `custom`（沿用现 `zsh -lc` 语义）；
  若未填（默认/空）→ 走自动探测链。
- **DSH_HOME**：M2 已注入 `WhalePod/harness`，自举时保持不变，三种形态统一注入。
- **`--port` 注入**：保持现状（壳自动追加 `--port 0` 或固定端口），command 形态改造不动端口逻辑。

## 七、分发/签名影响
- bundled node 是第三方二进制：打包后需一并 `codesign`，公证时包含进 app（Developer ID + notarize 才可外发）。
- 本机 b 方案不涉及签名（用系统 node）。
- 推荐首版以 a+b 本地可用（ad-hoc 签名本地跑）+ 产品化时走 Developer ID + notarize 完整链路。

## 八、落地拆分建议（方案→实现，rebrand 后执行）
1. `RuntimeBootstrap.swift`：枚举 + 探测链（bundled/probe/npx 三路径解析出 node/bin 路径）。
2. `ServiceConfig`：command 字段语义化（custom 兼容 + 空=自动探测）。
3. `HarnessServiceManager`：`mergedEnvironment()` 已就绪，启动命令改为由 RuntimeBootstrap 生成的可执行数组。
4. 打包脚本：`Scripts/` 加 build-runtime.sh（下载 node tarball + npm pack + 拷 node_modules + 签名）。
5. 验证：本机无 node 环境模拟 + 有 node 环境分别起；`swift build` / ad-hoc 签名 .app 双击可开。

## 附：实测数据点
- 本机 node：`/Users/qzp/.local/opt/node/bin/node`，v22.17.0。
- pnpm store：`/Users/qzp/Library/pnpm` 2.6G（content-addressable，不可直接打包）。
- dsh-desktop 签名参考：hardenedRuntime + Developer ID + notarize（gatekeeperAssess:false）。
- 当前默认 command（ServiceConfig.swift L48）：`"npm exec @deepseek-ai/dsh web"`，`zsh -lc` 执行。
