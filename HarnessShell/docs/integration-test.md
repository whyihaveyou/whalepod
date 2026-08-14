# HarnessShell — 全功能集成测试预案（integration-test.md）

> 作者：工程-Flash-1 | 状态：**预案（待 Flash-2/Flash-3 落地后执行）**
> 适用对象：`/Users/qzp/aion2dsh/HarnessShell/`
>
> 目的：桌面壳集齐全部能力（视觉 chrome + 打包 + 随机端口/单实例 + 崩溃重启/deep link）后，在联调阶段一次性验证这些能力**协同工作**、互不冲突，避免带着隐性缺陷进入下一轮。
>
> ⚠️ **重点关注**：`工程-Flash-2`（随机端口 `--port 0` + 端口解析喂 WKWebView + 单实例锁）与 `工程-Flash-3`（崩溃退避重启 + `dsh://` 深链）**都改了 `HarnessServiceManager.swift`**。联调时必须专门验证两者叠加无冲突——「`--port` 注入 + 端口解析」与「崩溃重启状态机」同时工作，且 **`resolvedPort` 在 restart 后仍正确**。

---

## 0. 当前实现依据（阅读源码后整理，底层事实）

| 能力 | 载体/文件 | 关键实现点 |
|---|---|---|
| 随机端口 | `HarnessServiceManager.swift` `buildCommandLine()` | `isAutoPort`（config.port ≤ 0）时命令追加 ` --port 0`；从子进程 stdout 解析实际端口写入 `resolvedPort` |
| 端口喂 WebView | `MainWindowController.swift` `loadInitialURLIfNeeded()` | `.running` 态调用，用 `config.url(port: serviceManager.resolvedPort)` 加载，`hasLoadedInitialURL` 保证只加载一次 |
| 状态机 | `HarnessServiceManager.swift` | `State`：`stopped/starting/running/restarting(attempt,delay)/failed(msg)`；`onStateChange` 驱动 UI |
| 崩溃重启 | 同上 `scheduleRestart()` | 指数退避 1s→2s→4s…封顶 30s；`maxConsecutiveCrashes=5` 超过则放弃转 `.failed`；`userRequestedStop=true` 时**不重启**（`poll()` 走 `.stopped`） |
| 单实例 | `main.swift` + `SingleInstance.acquire()` | CFMessagePort 命名锁；同名实例已持锁 → 激活旧实例窗口并 `exit(0)`（AppDelegate 的 `applicationShouldHandleReopen` 聚焦） |
| dsh:// 深链 | `DeepLink.swift` + `MainWindowController.handle(deepLink:)` + `AppDelegate` | 支持 `dsh://open?port=N`、`dsh://session/<id>`、其他→`unknown`；注入 `window.__DSH_BOOT__` + `__DSH_LAST_LINK__` + 派发 `dsh:deeplink`/`dsh-deeplink` 双事件；页面未加载完先缓存 `pendingDeepLink`，`didFinish` 补注 |
| 视觉 chrome | `MainWindowController.swift` `updateUI(state:)` | 状态点语义、呼吸动画、加载/未运行/错误三态覆盖层（`overlayView`） |
| 打包/签名 | `Scripts/*.sh` + `docs/distribution.md` | ad-hoc/Developer ID + DMG/ZIP |

**两处联调必须盯紧的实现细节（叠加冲突风险点）**：

- **(A) 深链 `.open(port)` 与自动端口模式的张力**：`handle(deepLink:)` 对 `.open(port)` 直接 `webView.load(config.url(port: port))`，`bypass` 了 `serviceManager.resolvedPort`。自动端口模式下服务实际监听的是**随机端口**，若深链指定了不同的 `N`，WebView 将指向一个可能不存在的端口。→ 见 **T4.3**。
- **(B) restart 后 `resolvedPort` 与 WebView 的同步**：`startNewProcess()` 每次重启都清空 `resolvedPort`（自动模式置 nil）再从新进程 stdout 重新解析；但 `loadInitialURLIfNeeded()` 的 `hasLoadedInitialURL` 只在**首次**置真，重启后 WebView **不会自动重新加载新端口**。→ 见 **T3.4**（失败时首要排查文件：`MainWindowController.swift` 的 `loadInitialURLIfNeeded` 与 `HarnessServiceManager.swift` 的 `startNewProcess`）。

---

## 1. 通用说明：环境准备与快速起停

```bash
cd /Users/qzp/aion2dsh/HarnessShell

# 打包（ad-hoc，产物 dist/HarnessShell.app）
Scripts/build-app.sh

# 配置：自动端口模式（推荐，别名避免端口冲突）
#   ~/.harness-shell/config.json:
#   { "command": "npm exec @deepseek-ai/dsh web",
#     "workingDirectory": "/Users/qzp/aion2dsh/deepseek-harness",
#     "host": "127.0.0.1", "port": 0 }

# 启动 / 关闭（用于每个用例前后的干净环境）
open dist/HarnessShell.app
osascript -e 'quit app "HarnessShell"'   # 或点击停止服务后关闭窗口
```

**通用前置**：确保无残留 harness 进程 / 无残留锁，避免脏状态：
```bash
pkill -f "dsh web"; pgrep -fl "HarnessShell"; rm -f /tmp/dsh-port.txt
```

---

## 2. 用例编号约定

| 前缀 | 能力域 |
|---|---|
| **T1** | 随机端口（`--port 0` + 端口解析喂 WebView） |
| **T2** | 单实例锁（二次启动聚焦旧实例、进程数保持 1） |
| **T3** | 崩溃退避重启（kill 子进程→自动拉起、指数退避、连续崩溃放弃、主动 stop 不重启） |
| **T4** | dsh:// 深链（open?port=N / session 路由、已运行聚焦、冷启动路由） |
| **T5** | 视觉 chrome（暗色、状态点语义、加载/未运行/错误三态覆盖层） |
| **T6** | 打包（ad-hoc 签名 + DMG/ZIP 安装、codesign verify、双击可开） |
| **T7** | **叠加回归**（Flash-2 × Flash-3：随机端口 + 崩溃重启 + resolvedPort 在 restart 后正确）← 组长重点 |

每个用例给出：**验证目标 / 手动步骤 / 可脚本化命令 / 通过判据 / 失败时先查哪个文件**。

---

## T1 随机端口（--port 0 + resolvedPort 喂 WebView）

### T1.1 自动端口：启动后用随机端口，WebView 指向解析端口
- **验证目标**：`--port 0` 生效，服务监听在随机回环端口；WKWebView 加载到的是**解析后的实际端口**，页面正常显示（非"无法连接"）。
- **手动步骤**：配 `serviceManager.resolvedPort`（config.port=0）；启动 app；观察顶部状态点转绿、状态文字显示 `运行中 · 127.0.0.1:<随机端口>`；WebView 显示 harness UI。
- **可脚本化**：
  ```bash
  open dist/HarnessShell.app && sleep 8
  # 1) 取随机端口：从服务 stdout（stderr 也重定向进管道）解析，或 lsof 探测新监听
  PORT=$(lsof -nP -i TCP -sTCP:LISTEN | grep node | awk '{print $9}' | grep -oE '[0-9]+$' | tail -1)
  echo "resolved port = $PORT"
  # 2) WebView 加载的 URL 应等于该端口（用 WKWebView 无法直接读，改用浏览器复验端口可达）
  curl -sI -m 5 "http://127.0.0.1:$PORT" | head -1   # 期望 HTTP 200
  ```
- **通过判据**：curl 对解析端口的探测返回 200；日志可见 `加载 http://127.0.0.1:<PORT>`。
- **失败先查**：`HarnessServiceManager.swift`（stdout 解析 / `resolvedPort`）、`MainWindowController.loadInitialURLIfNeeded`、`ServiceConfig`（是否真的是自动端口）。

### T1.2 固定端口模式（非 0 时）
- **验证目标**：config.port>0 时命令追加 `--port <n>`，WebView 加载固定端口；端口被外部占用时复用（不重复拉起）。
- **手动步骤**：改 config 为 `port: 4180`；外部 `lsof -nP -i :4180` 先占一个服务 → 启动 app，应识别为 running 直接加载，不拉新进程。
- **通过判据**：状态直接转绿；未额外 spawn 新 `dsh web` 进程。
- **失败先查**：`HarnessServiceManager.performStart`（固定端口分支的 `isReachable()` 复用逻辑）。

---

## T2 单实例锁

### T2.1 二次启动聚焦旧实例、进程数保持 1
- **验证目标**：已运行一个实例时，再次 `open` 不产生第二实例；旧实例被聚焦到前台。
- **手动步骤**：启动一次 → 记进程数；再 `open` 一次 → 观察：旧窗口被带到前台/激活，且 `pgrep -f HarnessShell` 数量保持 1。
- **可脚本化**：
  ```bash
  open dist/HarnessShell.app && sleep 5
  BEFORE=$(pgrep -f "HarnessShell.app/Contents/MacOS/HarnessShell" | wc -l | tr -d ' ')
  open dist/HarnessShell.app && sleep 4
  AFTER=$(pgrep -f "HarnessShell.app/Contents/MacOS/HarnessShell" | wc -l | tr -d ' ')
  echo "before=$BEFORE after=$AFTER"
  [ "$BEFORE" = "1" ] && [ "$AFTER" = "1" ] && echo "PASS" || echo "FAIL"
  ```
- **通过判据**：`AFTER==1`；窗口激活（可用 `osascript -e 'tell app "System Events" to get frontmost of process "HarnessShell"'` 验证）。
- **失败先查**：`main.swift`（`SingleInstance.acquire()`）、`SingleInstance.swift`（CFMessagePort 锁逻辑）、`AppDelegate.applicationShouldHandleReopen`（聚焦）。

---

## T3 崩溃退避重启

### T3.1 kill 子进程 → 自动拉起（指数退避）
- **验证目标**：服务进程被杀后，状态进入 `restarting(attempt,delay)`，按 1s→2s→4s…自动重启并回到 running。
- **手动步骤**：启动到 running → 记录 `spawnedPidValue`（或找出 harness 子进程 pid）→ `kill -9` 它 → 观察状态文字"服务意外退出，1s 后第 1 次重启…"→ 等几秒服务自动恢复、状态点转绿。
- **可脚本化**：
  ```bash
  open dist/HarnessShell.app && sleep 8
  # 当前被拉起的 dsh 子进程（独立进程组，pid = 组 id）
  CHILD=$(pgrep -f "dsh web" | head -1)
  [ -n "$CHILD" ] && kill -9 "$CHILD"
  sleep 3; echo "第1次重启状态应在退避中"
  sleep 20
  curl -sI -m 5 http://127.0.0.1:$(pgrep -f "dsh web" >/dev/null && lsof -t -iTCP -sTCP:LISTEN | while read p; do lsof -p $p -a -iTCP -sTCP:LISTEN -Fn 2>/dev/null | grep -oE '[0-9]+$'; done | tail -1) 2>/dev/null | head -1 || echo "需手工确认端口"
  ```
  （更稳做法：看 app 日志里 `▶ 启动命令` 与 `⚠ 服务意外退出…第 N 次` 行判断退避序列。）
- **通过判据**：日志出现重启序列；最终状态回到 `running`。
- **失败先查**：`HarnessServiceManager.poll()`（进程已退判断 + 分派 scheduleRestart 的分支）、`scheduleRestart()`。

### T3.2 指数退避序列正确
- **验证目标**：连续 kill 多次，退避时间 1s→2s→4s→8s→16s→30s（封顶 30）。
- **手动步骤**：连续多次 `kill -9`，每次记录日志里 `N 秒后自动重启（第 X/5 次）` 的 delay 是否翻倍。
- **通过判据**：delay 序列为 `1,2,4,8,16,30,30…`；`restartAttempt` 从 1 递增。
- **失败先查**：`scheduleRestart()` 的 `restartBaseDelay * pow(2, attempt-1)` 与 `restartMaxDelay` 封顶。

### T3.3 连续崩溃放弃（超过 5 次 → failed，不无限重启）
- **验证目标**：连续快速崩溃达到上限后进入 `.failed`，不再自动重启，需手动。
- **手动步骤**：连续 kill 子进程 6 次（期间不等它进入 running，一直 kill）→ 第 6 次日志应显示"连续崩溃 6 次，放弃自动重启"，状态文字出现"服务连续崩溃 6 次，已放弃自动重启，请手动启动"。
- **通过判据**：达到 `maxConsecutiveCrashes(=5)` 后转 `.failed`，之后不再 spawn 新进程。
- **失败先查**：`scheduleRestart()` 的 `if restartAttempt > maxConsecutiveCrashes` 分支、`poll()` 重启计数清零逻辑（注意：一旦可达会清 0，连续 kill 需在 running 前完成）。

### T3.4 主动 stop 不重启（用户停止语义）
- **验证目标**：用户点"停止服务"（`stop()`）后，进程被杀但**不会**触发自动重启；状态停在 `.stopped`。
- **手动步骤**：running → 点"停止服务" → 等 5s → 观察进程消失、状态文字"服务未运行"、**无**"自动重启"日志。
- **通过判据**：`userRequestedStop=true` 后 `poll()` 走 `.stopped` 分支；`killpg(SIGTERM)` 宽限 3s 后 `SIGKILL`；不出现 scheduleRestart。
- **失败先查**：`stop()` / `shutdown()` 是否置 `userRequestedStop`、`poll()` 的 `if userRequestedStop { state = .stopped }` 分支。

---

## T4 dsh:// 深链

### T4.1 open?port=N（已运行的实例，指定端口加载）
- **验证目标**：`dsh://open?port=3080` 在已运行时聚焦窗口并加载 3080 页面。
- **手动部署**：先启动一个固定端口 3080 的 harness（或自动端口改 3080 场景）→ `open "dsh://open?port=3080"` → 窗口聚焦，WebView 指向 3080。
- **可脚本化**：
  ```bash
  open dist/HarnessShell.app && sleep 8
  # 先让服务跑在 3080（改 config.port=3080 或已外部起 3080）
  open "dsh://open?port=3080"; sleep 3
  curl -sI -m 5 http://127.0.0.1:3080 | head -1   # 期望 200（配合复验）
  ```
- **通过判据**：窗口前置；WebView 显示 3080 的 UI。
- **失败先查**：`DeepLink.parse`（host=open、port 解析）、`MainWindowController.handle(deepLink:)` 的 `.open(port)` 分支。

### T4.2 已运行聚焦（二次 `open` 深链只聚焦、不新起）
- **验证目标**：同 T2.1 结合深链——已运行实例收到 `dsh://` 只聚焦旧窗口，进程数保持 1。
- **通过判据**：进程数 1；窗口前置。
- **失败先查**：`AppDelegate.application(_:open urls:)` 是否仍经单实例锁路径。

### T4.3 ⚠️ 自动端口 × open?port=N 的叠加张力（重点）
- **验证目标**：**自动端口模式下**（服务实际随机端口 ≠ 深链指定的 N）打开 `dsh://open?port=N`，行为是否符合预期（不崩溃、有合理降级/提示），以及是否"误指到不存在的端口"。
- **手动步骤**：自动端口启动（config.port=0）→ 确认服务随机端口 R（日志可得）→ `open "dsh://open?port=3080"`（R≠3080）→ 观察：WebView 是跳 3080（可能空白/无法连接）还是仍留在 R。
- **通过判据**：**明确记录并确认现状**——由于实现是 `.open(port)` 直接 load(port)，预期 WebView 会切到 3080。若该端口不存在则显示加载失败覆盖层。**判定为"符合当前设计意图 + 已知限制"**，若希望自动端口优先则需改 `handle` 逻辑（记录为本用例结论，联调对齐）。
- **失败先查**：`MainWindowController.handle(deepLink:)` 的 `.open(port)` 直接 load 逻辑 vs `serviceManager.resolvedPort`。

### T4.4 session 路由
- **验证目标**：`dsh://session/<id>` 交给 Web 端路由；`__DSH_BOOT__/__DSH_LAST_LINK__` + `dsh:deeplink`/`dsh-deeplink` 事件载荷正确。
- **手动步骤**：`open "dsh://session/abc"` → Web 端应收到 `{type:"session", sessionId:"abc", href:..., ts:...}` 事件（可在 Web 控制台验证 `window.__DSH_BOOT__`）。
- **可脚本化**（验证 Web 桥接产物不是 UI，但可抽查注入 JS 命中）：
  ```bash
  open "dsh://session/s-123"
  # 通过松弛观察：日志出现 "→ 深链 dsh://session/s-123"
  ```
- **通过判据**：日志记录深链；Web 端能读到 `__DSH_LAST_LINK__`。
- **失败先查**：`DeepLink.webPayload`、`bridgeDeepLinkToWeb` 的 JS 注入。

### T4.5 冷启动路由（页面未加载完成时收到深链 → didFinish 补注）
- **验证目标**：服务/页面尚未 ready 时收到 `dsh://`，被缓存到 `pendingDeepLink`，待 `didFinish` 后补注完成路由。
- **手动步骤**：冷启动 app（服务刚拉起）立刻 `open "dsh://open?port=..."` → 最终应路由成功。
- **通过判据**：日志 "→ 深链 …" 出现；WebView 最终加载到目标。
- **失败先查**：`MainWindowController` 的 `pendingDeepLink` + `webView(_:didFinish:)` 补注分支。

---

## T5 视觉 chrome

### T5.1 暗色主题 + 状态点语义
- **验证目标**：默认暗色（`NSAppearance.darkAqua`）；状态点颜色语义：idle（灰）/progress（琥珀/呼吸）/active（绿）/danger（红）。
- **手动步骤**：分别在 stopped / starting / running / failed 观察状态点颜色与动画（starting 呼吸）。
- **通过判据**：与 `ShellTokens.Color.status*` 定义一致；starting 呼吸动画可见。
- **失败先查**：`MainWindowController.updateUI(state:)` + `ShellTokens.swift` 颜色、`startBreathing/stopBreathing`。

### T5.2 加载/未运行/错误三态覆盖层
- **验证目标**：`starting`→加载页（品牌图标+spinner+端口）；`stopped`→未运行页（空心灰点+标题+"启动服务"主按钮）；`failed`→错误页（⚠ 标题+说明+"重试"）。
- **手动步骤**：模拟三种状态（正常启动 to running；停止到 stopped；故意配错命令触发 failed）观察覆盖层。
- **通过判据**：三态覆盖层文案、按钮、可见性与 `updateUI` 的 overlay 分支一致、淡入淡出正常。
- **失败先查**：`updateUI(state:)` 的 `.starting/.stopped/.failed` overlay 分支 + `setOverlayVisible`。

---

## T6 打包与安装

### T6.1 ad-hoc 签名 + codesign verify
- **验证目标**：打包出的 .app 结构完整、ad-hoc 签名可通过 verify。
- **可脚本化**：
  ```bash
  Scripts/build-app.sh
  codesign --verify --deep --strict --verbose=2 dist/HarnessShell.app
  codesign -dv dist/HarnessShell.app 2>&1 | grep -E "Identifier|Signature"
  # 期望：valid on disk / Signature=adhoc / Identifier=com.aion2dsh.HarnessShell
  ```
- **失败先查**：`Scripts/build-app.sh`、Info.plist 占位符解析是否残留。

### T6.2 DMG/ZIP 生成与挂载安装
- **验证目标**：`make-dmg.sh`/`make-zip.sh` 产物可校验；DMG 双击可挂载、拖拽安装、双击 .app 可开。
- **可脚本化**：
  ```bash
  Scripts/make-dmg.sh && hdiutil verify dist/HarnessShell.dmg
  Scripts/make-zip.sh
  # 挂载验证内容
  hdiutil attach dist/HarnessShell.dmg -nobrowse -readonly
  ls /Volumes/DFH\ Workstation/        # 应含 HarnessShell.app + Applications 软链
  hdiutil detach /Volumes/DFH\ Workstation
  # 从 DMG/zip 双击 .app 打开，进程数=1，界面正常
  ```
- **失败先查**：`Scripts/make-dmg.sh`/`make-zip.sh`、`build-app.sh`（bundle 结构）。

---

## T7 ⚠️ 叠加回归（Flash-2 × Flash-3 核心断言）——组长重点

> 这是联调阶段的**第一优先**用例，专测"随机端口/端口解析"与"崩溃重启状态机"同在一个 `HarnessServiceManager` 内**同时工作**，且 **`resolvedPort` 在 restart 后仍正确**。

### T7.1 自动端口 + 崩溃重启：restart 后端口仍正确、WebView 可用
- **验证目标**：自动端口（port=0）下，服务崩溃 → 自动重启(dir 新的随机端口) → **`resolvedPort` 更新为新端口**，服务可用；观察 WebView 是否跟随（记结论，见风险 B）。
- **手动步骤**：自动端口启动到 running → 记录旧端口 R1（日志/`resolvedPort`）→ `kill -9` 子进程 → 等退避重启完成 → 记录新端口 R2（应 ≠ R1，是新随机端口）→ `curl http://127.0.0.1:R2` 应 200；再看 WebView 是否已切到 R2。
- **可脚本化**：
  ```bash
  open dist/HarnessShell.app && sleep 10
  R1=$(lsof -nP -iTCP -sTCP:LISTEN | grep node | grep -oE '[0-9]+$' | tail -1); echo "R1=$R1"
  kill -9 "$(pgrep -f 'dsh web' | head -1)"
  sleep 22   # 覆盖 1s+2s+4s…退避直到回到 running
  R2=$(lsof -nP -iTCP -sTCP:LISTEN | grep node | grep -oE '[0-9]+$' | tail -1); echo "R2=$R2"
  [ -n "$R2" ] && [ "$R1" != "$R2" ] && curl -sI -m 5 "http://127.0.0.1:$R2" | head -1
  ```
- **通过判据**：
  1. 服务能自动重启（状态回到 running）；
  2. **`resolvedPort` 从 R1 正确更新为 R2**（R2≠R1，且 R2 端口可达——证明 restart 后端口解析没有残留旧值/死锁）；
  3. 记录 WebView 是否跟随新端口（风险 B：当前 `hasLoadedInitialURL` 只在首次置真，重启后 WebView **不会自动 reload 新端口**——**若这是现状判定为已知限制并记录**，联调决策是否要加"restart 后 reload"）。
- **失败先查**：**`HarnessServiceManager.startNewProcess()`**（restart 时 `resolvedPort` 重置逻辑，line ~99）→ **`MainWindowController.loadInitialURLIfNeeded/hasLoadedInitialURL`** → `poll()/scheduleRestart()`。

### T7.2 固定端口 + 崩溃重启（回归）
- **验证目标**：固定端口模式重启后 `resolvedPort` 恒等于 config.port，WebView 无需改端口，服务恢复即可用。
- **通过判据**：restart 后 `resolvedPort==config.port`；curl 200；无端口错乱。
- **失败先查**：同 T7.1（固定模式下 `resolvedPort` 不置 nil）。

### T7.3 单实例锁 × 深链冷启动（组合）
- **验证目标**：一个实例已跑，再 `open "dsh://..."` 仅聚焦不重复拉起；冷启动深链可达。
- **通过判据**：进程数保持 1；深链最终路由成功。
- **失败先查**：`main.swift` 单实例 + `AppDelegate` 深链入口 + `pendingDeepLink` 协同。

---

## 8. 执行建议与提交格式

1. **顺序**：先 T1（基础端口）→ T2（单实例）→ T3（崩溃重启）→ T7（叠加，最重）→ 再 T4/T5/T6（相对独立）。
2. 每个用例记录：`PASS/FAIL/BLOCKED` + 复现 `./log 行` + 屏幕/`screencapture` 佐证 + 判定依据。
3. 叠加用例（T7）发现缺陷时优先定位到文件级（见各"失败先查"），并把结论回写到本文档。
4. 本预案为**白盒依据**（已读源码），执行时以实际落地代码为准——若 Flash-2/3 落地后接口/逻辑与上文有出入，先更新"§0 实现依据"再执行。

---

## 附：联调快速命令速查
```bash
Scripts/build-app.sh                     # 打包 ad-hoc .app
open dist/HarnessShell.app               # 启动实例
osascript -e 'quit app "HarnessShell"'   # 优雅退出
open "dsh://open?port=3080"              # 深链 open
open "dsh://session/s-123"               # 深链 session
pgrep -f "HarnessShell.app" | wc -l      # 进程数（单实例断言）
pgrep -fl "dsh web"                      # harness 子进程
lsof -nP -iTCP -sTCP:LISTEN | grep node  # 探测实际监听随机端口
```
