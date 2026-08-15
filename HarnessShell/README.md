# 鲸群 WhalePod — DeepSeek Harness 桌面壳（MVP）

> A Pod of Agents, Powered by DeepSeek Harness

macOS 最小桌面壳：`WKWebView` 内嵌加载本地 harness Web UI，并内置进程管理器用于
启动/停止 harness 服务。**默认自动分配随机回环端口**（规避端口冲突），支持**单实例锁**（防多开）。

> MVP 状态：视觉为占位样式（顶部工具条 + 服务未就绪覆盖层），视觉由「视觉-K3-2」产出后接入。
> 接入点见下文「视觉接入点」。

## 目录结构

```
HarnessShell/
├── HarnessShell.xcodeproj/        # Xcode 工程（在完整 Xcode 中打开运行）
├── Package.swift                  # SPM 清单（用于命令行编译验证/快速运行）
├── Sources/HarnessShell/
│   ├── main.swift                 # 程序入口（纯代码，无 storyboard）+ 单实例守护
│   ├── SingleInstance.swift       # 单实例锁：flock 文件锁 + NSRunningApplication 聚焦
│   ├── AppDelegate.swift          # 应用生命周期 + 主菜单 + whale:// 深链入口
│   ├── MainWindowController.swift # 主窗口：工具条(占位视觉) + WKWebView + 覆盖层 + 深链桥接
│   ├── HarnessServiceManager.swift# 进程管理器：posix_spawn 独立进程组 + 端口注入/解析 + killpg 停止 + 崩溃退避
│   ├── DeepLink.swift             # whale:// 深链解析器（open?port= / session/<id> / unknown）+ Web 载荷
│   ├── ServiceConfig.swift        # 服务配置（命令/工作目录/端口，可被 ~/Library/Application Support/WhalePod/config.json 覆盖）
│   └── Info.plist                 # 应用配置（localhost ATS 豁免 + whale:// CFBundleURLTypes）
└── README.md
```

## 运行方式

### 方式一：Xcode（推荐，交付形态）

1. 用完整版 Xcode 打开 `HarnessShell/HarnessShell.xcodeproj`。
2. 选择 **HarnessShell** scheme，点 **Run**（⌘R）。
3. 首次运行若提示签名，选「Sign to Run Locally」（工程已配置 ad-hoc 签名，无需开发者账号）。

### 方式二：命令行（无需完整 Xcode）

```bash
cd HarnessShell
swift run            # 或 swift build 后运行 .build/debug/HarnessShell
```

> 注：若已有实例在跑（`swift run` 二次启动），第二个实例会因单实例锁自动退出并聚焦第一个。

## 使用

- 启动后自动拉起 harness 服务并分配**随机回环端口**；从子进程 stdout 解析实际端口后
  再让 WKWebView 指向它，彻底避免 3080 被占用/冲突。
- 顶部工具条（占位视觉）：
  - 状态点/状态文字：绿=运行中 · 黄=启动中 · 红=未运行 · 橙=启动失败/退避重启中
  - **启动服务 / 停止服务**：进程管理器启停 harness
  - **刷新**：重载 WebView
  - **浏览器打开**：在默认浏览器打开服务地址
- 服务未就绪时，WebView 区域显示占位覆盖层（加载动画 + 提示）。

## 配置（可选）

默认 `command` 为空：走自动探测链（RuntimeBootstrap）——Full 档命中 bundled 运行时（免装 Node），Slim 档命中本机 node / `npx @deepseek-ai/dsh` 兜底。`command` 非空时作为 custom 命令通过 `zsh -lc` 原样执行（自动继承 PATH，向后兼容旧配置）。

`port` 语义：**`0`=自动随机端口（默认）**；**正整数**=固定端口。

如需自定义（换命令、指定工作目录、指定端口），创建 `~/Library/Application Support/WhalePod/config.json`（旧路径 `~/.harness-shell/config.json` 仍兼容）：

```json
{
  "command": "npm exec @deepseek-ai/dsh web",
  "workingDirectory": "/Users/qzp/aion2dsh/deepseek-harness",
  "host": "127.0.0.1",
  "port": 0,
  "environment": { "NODE_ENV": "production" }
}
```

字段均可省略，缺省回落内置默认值。
- 自动端口（`port: 0`）：壳在启动命令末尾追加 `-- --port 0`（对 `npm`/`npx` 需 `--` 分隔符，
  否则会被 npm 当成自己的参数吞掉），从 stdout 形如 `dsh web: http://127.0.0.1:58671`
  的行解析实际端口，再让 WebView 指向它。
- 固定端口（`port: <n>`）：壳追加 `--port <n>` 并探测该端口；若已被外部占用则直接复用。

## 单实例锁（防多开）

启动时用 **flock 文件锁**（`~/Library/Application Support/<bundle-id>/singleton.lock`）判定是否已有实例：

- 持锁成功 → 本实例是唯一实例，继续启动。
- 持锁失败 → 已有实例在跑，用 `NSRunningApplication` 聚焦其窗口到前台，本实例 `exit(0)`。

要点：
- flock 是内核级互斥，**跨进程可靠**；进程正常退出/崩溃时内核自动关闭 fd 释放锁。
- 锁文件 fd 设了 `FD_CLOEXEC`，避免 `posix_spawn` 拉起的 zsh→npm→node 子进程继承 fd
  导致「主进程退出后锁残留」。
- 曾弃用 `CFMessagePortCreateLocal` 命名锁——实测同名 local 端口在两个 `.build` 应用进程间
  **不互斥**（同 session 不同进程会被上下文隔离），flock 无此问题。

## 进程管理器设计（重要）

- 用 `posix_spawn` + `POSIX_SPAWN_SETPGROUP` 把服务进程放进**独立进程组**，
  停止时对整组发 `SIGTERM`（3 秒宽限期后 `SIGKILL`），确保
  `npm exec`/`pnpm` 派生的 node 子进程一起退出，不残留占用端口的孤儿进程。
- 每 2 秒 TCP 探测生效端口（`isPortOpen`，纯 socket，不受 ATS 影响），
  据此自动判定「运行中/启动中/未运行」。自动端口下探测**已解析**的随机端口。
- 启动时注入 `-- --port N`；子进程 stdout 出现端口后解析并写入 `resolvedPort`，
  UI 据此加载 WebView（`ServiceConfig.url(port:)`）。
- 进程退出后自动 `waitpid` 收割，避免僵尸进程。
- 应用退出（Cmd+Q / 关窗）时自动停止服务。

### 崩溃重启退避（意外退出自动拉起）

在优雅停机（SIGTERM→3s→SIGKILL）之上叠加「意外退出监测 + 指数退避重启」：

- 由本管理器拉起的进程意外退出（既非用户主动停止、也非外部端口占用）时，自动按
  **1s → 2s → 4s … 封顶 30s** 的指数退避重启。
- 连续快速崩溃 **5 次**后放弃自动重启，状态置为 `failed` 并在 UI 给出提示，等用户手动启动。
- **用户主动停止不触发重启**（通过 `stop()`/进程管理器停止时清除退避状态）。
- 新增 `State.restarting(attempt:delay:)`，工具条在退避期间显示提示并可点「停止重试」取消。

策略常量集中在 `HarnessServiceManager.swift`：
`restartBaseDelay=1s` · `restartMaxDelay=30s` · `maxConsecutiveCrashes=5`。

## whale:// 深链

应用注册 `whale://` URL scheme（`Info.plist` 的 `CFBundleURLTypes`），支持外部唤起：

| 格式 | 动作 |
| --- | --- |
| `whale://open?port=3080` | 打开指定端口的 harness 实例（直接加载对应地址） |
| `whale://session/<id>` | 路由到某个 session（交给 Web 端按 sessionId 处理） |
| 其他 | 落入 `.unknown`，原样桥接给 Web 端 |

行为：

- **已在运行**：聚焦并激活已有窗口（`showWindow + makeKeyAndOrderFront + activate`），
  确保服务在跑（未启动则拉起），把解析结果桥接给 WebView。
- **冷启动**：先到的深链缓存，页面加载完成后（`didFinish`）补注。
- **`.open(port)` 端口回落（风险 A/T4.3）**：自动端口模式下，深链传入的端口可能过时或不匹配，
  一律以 `serviceManager.resolvedPort` 为准；固定端口模式用传入端口。
- **崩溃重启跟随端口（风险 B/T7）**：自动端口模式下服务崩溃重启拿到新 `resolvedPort` 时
  WebView 自动 reload 跟随新端口；固定端口模式端口不变不 reload。
- **桥接契约**：注入 `window.__DSH_BOOT__`（含最后一条 `window.__DSH_LAST_LINK__`），
  并派发 `dsh:deeplink` / `dsh-deeplink` 两个 CustomEvent，`detail` 携带
  `{ type, port | sessionId, href, ts }`。

应用若要深链测试，需在 `open` 时传 `-a`（确保唤起已有实例）。

### 深链测试

```bash
# 1) 先在 Xcode/SPM 里启动 WhalePod（确保已注册 whale://）
# 2) 用 open 唤起：
open 'whale://open?port=3080'        # 应聚焦窗口并加载 3080 实例
open 'whale://session/abc-123'       # 应聚焦窗口并把 session 事件桥接给 Web 端
```

> 提示：`open 'whale://...'` 会优先唤起已在运行的实例（聚焦 + 路由）；
> 若应用未运行则冷启动后路由。


## 视觉接入点（视觉-K3-2 完成后）

- `MainWindowController.swift`：
  - `topBar`（NSVisualEffectView，高 48）→ 替换为设计稿的顶部栏
  - `overlayView`（服务未就绪覆盖层）→ 替换为设计的 loading/空态
  - `statusDot` / `statusLabel` / 三个按钮 → 可按设计重排
- 建议后续：新增 `Assets.xcassets`（应用图标），样式统一后由 `NSAppearance` 适配深色模式。

## 已知限制（MVP）

1. 本机只有 CommandLineTools 时无法用 `xcodebuild` 编译验证 .xcodeproj——
   已用 SPM（同一份源码）验证编译通过 + 冒烟测试通过；请在有完整 Xcode 的环境冒烟一次。
2. `posix_spawn_file_actions_addchdir_np` 在 macOS 26 SDK 下有一条弃用提示
   （非弃用版仅 macOS 26+ 可用，为兼容 macOS 13 保留 `_np`），不影响功能。
3. 未做应用沙盒（sandbox 会限制拉起子进程），未签名/临时签名即可本地运行。
4. 日志走 stderr（Xcode 控制台可见），暂无 UI 日志面板。
5. 自动端口模式下从 stdout 解析端口依赖 dsh 输出 `dsh web: http://127.0.0.1:<port>` 格式；
   若该格式变化，端口解析会失败 → 建议固定端口或用 config 指定。

## 冒烟测试

无头验证（端口探测 + 独立进程组 + killpg 整组停止 + waitpid 收割 + 端口解析）：

```bash
cd HarnessShell/Scripts/smoke-test
swiftc -o smoke ../../Sources/HarnessShell/ServiceConfig.swift \
  ../../Sources/HarnessShell/DeepLink.swift \
  ../../Sources/HarnessShell/HarnessServiceManager.swift main.swift && ./smoke
```

已实测：
- 随机端口端到端：真实 `dsh web -- --port 0` → 自动端口 53589 → 壳解析 → WebView 加载该端口 ✅
- 单实例锁：实例2 持锁失败自动退出并聚焦实例1；实例1 退出后实例3 可重入 ✅
- SPM `swift build` **0 warning 0 error**。
