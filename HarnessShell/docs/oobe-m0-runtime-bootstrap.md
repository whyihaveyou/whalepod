# OOBE-M0 运行时自举：命令抽象 + bundled/fallback 探测链（设计方案）

> 作者：工程-Flash-2 | 类型：**只读方案准备**（等集成测试绿后实施）| 关联任务 #01a0010d
> 依据：`docs/shell-oobe-proposal.md` ①（G1，P0）里程碑 M0
> 参考实现：`refs/dsh-desktop/src/main/runtime/harness-runtime.ts`（已读源码）
> 现状：`HarnessShell/Sources/HarnessShell/{ServiceConfig,HarnessServiceManager,MainWindowController}.swift`

---

## 0. 目标与边界

**目标**：把 `HarnessServiceManager` 的启动命令从「依赖用户环境的 `npm exec @deepseek-ai/dsh web`」
改为**自举形态**——绝对路径 node + 打包的 `@deepseek-ai/dsh/bin.js`，让 .app「开箱即首启」。

**M0 本阶段范围**（Leader 界定）：
- ✅ 命令抽象：`ServiceConfig` 支持 command 形态切换
- ✅ 探测链：bundled（node+bin.js）优先 → 本机 dsh fallback → 明确报错引导
- ❌ 不动随机端口（`--port 0` 注入）/ 崩溃重启状态机（只关心进程生命周期）
- ❌ 不做 bundled 运行时实际打包进 .app（打包集成只出方案，等集成测试绿后再动打包链路）

---

## 1. 现状梳理（已读源码确认）

### 1.1 当前 spawn 路径
`HarnessServiceManager.spawnInOwnGroup(arguments: ["zsh","-lc", buildCommandLine()], ...)`
→ `buildCommandLine()` 把 `config.command` + `--port N` 拼成**一条 shell 命令字符串**，经 `zsh -lc` 执行。

```swift
// HarnessServiceManager.buildCommandLine()（当前）
private func buildCommandLine() -> String {
    let command = config.command                       // "npm exec @deepseek-ai/dsh web"
    let portArg = config.isAutoPort ? "--port 0" : "--port \(config.port)"
    // npm/npx exec 需 `--` 分隔符透传，否则 --port 被 npm 吞掉
    let needsSeparator = command.starts(with: "npm ") || command.starts(with: "npx ")
    return needsSeparator ? "\(command) -- \(portArg)" : "\(command) \(portArg)"
}
```

### 1.2 `ServiceConfig.command` 形态（当前）
- 仅一种形态：**裸 shell 命令字符串**（默认 `npm exec @deepseek-ai/dsh web`），`zsh -lc` 执行。
- 依赖本机 node/npm + `@deepseek-ai/dsh` 全家桶（本机实测无全局 dsh、无 clone 依赖可用 → 开箱必失败）。
- workingDirectory 默认 nil（用主目录）。

### 1.3 随机端口/崩溃重启（M0 不动，但要兼容）
- 端口：`buildCommandLine` 追加 `--port 0`（自动）→ dsh stdout 解析实际端口 → `resolvedPort` → UI 加载。
- 崩溃重启：`performStart → startNewProcess → spawnInOwnGroup`，已清 `resolvedPort` + `outputBuffer`（Bug#1 已修）。
- 状态机：`.restarting` / `.running` 等只消费「进程+端口」，不关心命令形态 → **命令抽象可无损接入**。

---

## 2. 命令抽象设计

### 2.1 抽象：`StartupCommand`（命令形态判别）

给 `ServiceConfig.command` 增加形态判别，支持两种 command 形态，`buildCommandLine` / spawn 层按形态分发：

| 形态 | 例子 | 语义 | 启动方式 |
|---|---|---|---|
| **bundled**（内嵌 node，推荐） | 保留字 `"embedded"`，或命令形如 `<nodePath> <binPath>` | 用打包的 node 直接跑打包的 bin.js | 直接 argv（无 shell）：`node spam bin.js web --port N` |
| **shell**（兼容现状/fallback） | `"npm exec @deepseek-ai/dsh web"` | 裸命令，走本机 node/npm/dsh | `zsh -lc`（现状） |

**判别**：`ServiceConfig` 新增计算属性 `launchMode: LaunchMode`，
- `command == "embedded"` 或命令以绝对 node 路径开头（`/` 开头且含 `bin.js`）→ `.bundled`
- 否则 → `.shell`（保持现状完全兼容）

```swift
enum LaunchMode { case embedded, shell }

struct ServiceConfig: Codable {
    var command: String = default.command
    // 新增 bundled 字段（可选，仅 embedded 形态用）
    var nodePath: String?      // 内嵌 node 绝对路径（打包时写入，如 Bundle.main .../Resources/runtime/node）
    var dshBinPath: String?    // 内嵌 bin.js 路径（.../Resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js）
    var dshHome: String?       // DSH_HOME，默认 ~/Library/Application Support/WhalePod/harness
}
```

> **命名集中（品牌收束前置）**：M0 代码里凡涉及**产品显示名 / Bundle 标识符 / 数据根目录**等将来由品牌收束统一改名的字符串，一律抽成 `AppIdentity` 常量集中（见 §4.1），不散落各处内联。目标值统一：
> - 数据根：`~/Library/Application Support/WhalePod/`（**英文目录名，避中文路径**；与 Flash-3 M2 对齐）
> - Bundle 标识符：`io.whalepod.desktop`（由品牌收束统一改）
> - 显示名：**鲸群 WhalePod**

### 2.2 命令解析：`StartupCommand.resolve(nodePath:binPath:)`

由探测链产出**最终生效的（node 绝对路径, bin.js 绝对路径）**，供 bundled 形态直接 argv 启动：

```swift
/// 探测链结果
enum RuntimeProbe {
    case bundled(nodePath: String, binPath: String)   // 内嵌可用
    case fallback(shellCommand: String)                // 本机 dsh fallback（沿用现有 shell 启动）
    case unavailable(reason: String)                   // 明确报错引导
}
```

---

## 3. 探测链设计（bundled → fallback → 报错）

### 3.1 探测顺序

```
bundled 可用?  ──是──► RuntimeProbe.bundled(node,bin)   // 首选：离线、版本锁定
   │否
本机 dsh 可用?  ──是──► RuntimeProbe.fallback("npx --yes @deepseek-ai/dsh@<ver> web")
   │否（或用户 config 显式 shell）
明确报错 ──────────► RuntimeProbe.unavailable("未找到 dsh 运行时，请安装 node 后重试 或 安装 .app 的 bundled runtime")
```

### 3.2 bundled 探测（优先）

仿 `harness-runtime.ts` 的 `existsSync(dshEntryPath)` 前置校验，在 Swift 用 `FileManager.fileExists`：

```swift
static func probeEmbedded() -> (node: String, bin: String)? {
    // 打包后在 Bundle.main 内找 runtime 目录（见 5. 打包集成方案）
    guard
        let runtimeDir = Bundle.main.resourceURL?.appendingPathComponent("runtime"),
        let nodePath = nodeIn(runtimeDir),                       // runtime/bin/node 或 runtime/node
        FileManager.default.isExecutableFile(atPath: nodePath.path),
        let binPath = runtimeDir
            .appendingPathComponent("node_modules/@deepseek-ai/dsh/lib/bin.js")
            .path existing as? String,
        FileManager.default.fileExists(atPath: binPath)
    else { return nil }
    return (nodePath.path, binPath)
}
```

要点（对齐 dsh-desktop）：
- node 可执行文件：打包的独立 node（`ELECTRON_RUN_AS_NODE` 是 Electron 特供，我们 Swift 壳用**独立 node 二进制**，无需该变量）。
- bin.js：`node_modules/@deepseek-ai/dsh/lib/bin.js`。
- 环境：`DSH_HOME` 指到 `~/Library/Application Support/WhalePod/harness`（数据在 .app 外，见提案 ③）、`NO_COLOR=1`、`PATH` 透传。

### 3.3 bundled 形态的直接 argv 启动

`bundled` 形态**不走 shell**，直接用 `posix_spawn(nodePath, [binPath, "web", "--host", "127.0.0.1", "--port", String(port)])`
——这正是 dsh-desktop `buildNodeArguments` 的等价：
```ts
// refs/dsh-desktop: buildNodeArguments → ['--expose-internals', dshEntryPath, 'web', '--host', '127.0.0.1', '--port', N]
```
> 注：`--expose-internals` 是 Cordis HMR 需要的 Node 内部加载器开关，dsh-desktop 只授给 child 进程。我们是否也需要需在实施时用真实 dsh 验证；若不需可省略，二者都以 `--host 127.0.0.1 --port N` 保证 loopback。

### 3.4 fallback（本机 dsh）

bundled 不可用（未打包 / runtime 缺失）时，回落现有 `npm exec`/`npx` shell 形态并追加现有 `-- --port N` 逻辑，**行为与现状完全一致**。版本锁定建议 `npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web`（对齐 refs/dsh-desktop 依赖，防漂移）。

### 3.5 明确报错（都不可用）

`RuntimeProbe.unavailable` → 进程管理器 `state = .failed("未找到 dsh 运行时...")`；
MainWindowController 的失败覆盖层展示**引导文案**（装 node / 或用 bundled .app），而非静默失败。

---

## 4. 与现有机制的兼容性（M0 不动它们）

| 现有机制 | 与命令抽象的关系 | 结论 |
|---|---|---|
| 随机端口 `--port 0` + stdout 解析 | bundled 形态直接 argv 传 `--port 0`，stdout 仍是 `dsh web: http://127.0.0.1:<port>` → `parsePort` 照常工作 | ✅ 兼容（端口注入从 shell 拼接改为 argv 传入） |
| 崩溃重启状态机（.restarting 等） | 只依赖「进程+resolvedPort+outputBuffer」，与命令形态解耦 | ✅ 零改动 |
| Bug#1 修复（startNewProcess 清 outputBuffer/resolvedPort） | 保留；bundled 形态的 stdout 走同一 handleOutput | ✅ 兼容 |
| 单实例锁（SingleInstance，flock） | 与命令无关 | ✅ 无关 |

**唯一需要动的地方**：
1. `ServiceConfig` 加 `LaunchMode` 判别 + bundled 字段（nodePath/binPath/dshHome）。
2. `HarnessServiceManager.spawnInOwnGroup` 增加**直接 argv 分支**（bundled）与现有 shell 分支并存，由 `launchMode` 分发。
3. `performStart/startNewProcess` 先调 `RuntimeProbe.resolve(...)`，按探测结果启动或报错。
4. `buildCommandLine()` 仅 shell 形态使用（保留）；bundled 形态绕过它直接构 argv。

---

## 5. 打包集成方案（本阶段不实做，仅说明）

**目标布局**（对齐 refs/dsh-desktop 的 `Contents/Resources/app/node_modules/...`）：

```
WhalePod.app/
└── Contents/
    ├── MacOS/WhalePod            # Swift 壳可执行
    └── Resources/
        └── runtime/                      # 打包的自举运行时
            ├── node                      # 独立 node 可执行（~50MB，arm64）
            └── node_modules/
                └── @deepseek-ai/
                    ├── dsh/lib/bin.js    # dsh CLI 全家桶（版本锁定 0.1.0-rc.6）
                    └── ...dsh 依赖包...
```

**打包手段**（实施阶段可选）：
- **方案 i（首选，纯 Swift 侧打包）**：Xcode/SPM build phase 里用一个脚本把 `runtime/` 拷进 `Resources`；
  运行时不依赖 Electron，直接用独立 node。node 二进制从官方/Homebrew 提取（arm64），dsh 全家桶 `npm pack`/`npm ci` 到 `runtime/node_modules`。
- **方案 ii（借鉴 dsh-desktop）**：若将来想复用 Electron 的更新/签名链，再评估；当前 Swift 壳用独立 node 更轻。

**版本锁定**：`@deepseek-ai/dsh@0.1.0-rc.6`（与 refs/dsh-desktop package.json 一致），避免漂移。

**升级安全**：`DSH_HOME`（数据）在 `~/Library/Application Support/WhalePod/`，不在 .app 内 → 替换 .app 不动数据（提案 ③ 已对齐）。

---

## 6. 待集成测试关注面（T7 叠加）

- T7 叠加回归：bundled 形态下随机端口解析、崩溃重启两处与现有测试同路径（换启动层），
  integration-test.md T7 用例应补一条「bundled 启动也能解析随机端口」的断言。
- 本机无 global dsh：M0 实施后默认走 bundled 或明确报错，不再假装「本机 npm 可用」。

---

## 附：关键参考逐行对照（防漂移）

| dsh-desktop（harness-runtime.ts / index.ts） | 我们的等价 |
|---|---|
| `nodeExecutable = process.execPath` + `ELECTRON_RUN_AS_NODE=1` | 独立 node 二进制（无此变量需求） |
| `dshEntryPath()` → `Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js` | `Resources/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| `buildNodeArguments = ['--expose-internals', dshEntryPath, 'web', '--host','127.0.0.1','--port', N]` | `[binPath, 'web', '--host','127.0.0.1','--port', N]`（--expose-internals 视需） |
| `reservePort()` 内核 socket 预占 | 已有 `--port 0` 自动端口 |
| `DSH_HOME = userData/harness` | `~/Library/Application Support/HarnessShell/harness` |
| `existsSync(dshEntryPath)` 前置校验 → failed | `FileManager.fileExists` → `.unavailable` / `.failed` 明确报错 |
| `stdio: ['pipe','pipe','pipe']` + stdout 读端口 | 现有 `posix_spawn` stdout 管道 + `parsePort`（`--port 0` stdout 布局一致） |
