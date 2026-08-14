# HarnessShell 集成测试结果（T1-T7）

> 执行：工程-Flash-1 | 任务 #01a0010d-ea35 | 状态：**进行中（边测边写）**
> 预案：`HarnessShell/docs/integration-test.md` | 最后更新：持续追加
> 环境：macOS aarch64 | node v22.17.0 / npm 11.19.0 | swiftc 6.3.3（CLT，无完整 Xcode）
> 被测：HarnessShell（Swift + WKWebView），Flash-2/3 改动已合入同一棵树，`swift build -c release` 0 error

---

## 汇总

| 用例 | 结果 | 备注 |
|---|---|---|
| **T1.1** 自动端口启动+解析 | ⏳ 部分通过 | parsePort 单测全过；端到端 running + resolvedPort 可达 PASS；restart 场景被 Bug#1 影响（见 T7.1） |
| T1.parsePort 单元 | ✅ 通过 | 真实 dsh 输出 `http://127.0.0.1:62812`→62812；端口 0 忽略；无端口→nil |
| **T2** 单实例 flock | ⏳ 待执行 | 按 flock/FD_CLOEXEC 语义设计断言 |
| **T3** 崩溃退避重启 | ⏳ 待执行 | 被 Bug#1 部分阻塞（restart 端口恢复） |
| **T4** dsh:// 深链 | ⏳ 待执行 | Risk A 已修（代码确认） |
| **T5** 视觉 chrome | ⏳ 待执行 | |
| **T6** 打包签名 | ⏳ 待执行 | 我的 Scripts 本应回归 |
| **T7** 叠加回归 | ⚠️ **发现 Bug#1（阻塞）** | T7.1 resolvedPort 断言失败，根因 outputBuffer 未清 |

---

## 已发现问题清单

### 🐛 Bug #1【真实缺陷，T7.1 暴露】restart 时 `outputBuffer` 残留 → 端口误解析，卡死 starting

- **文件**：`HarnessShell/Sources/HarnessShell/HarnessServiceManager.swift`
  - `startNewProcess()`（88-112 行）：每次重启清 `resolvedPort = nil`，但**未清 `outputBuffer`**
  - `handleOutput()`（369-385 行）：`resolvedPort == nil` 时 `parsePort(from: outputBuffer)`
  - `outputBuffer` 全局仅 3 处引用（26 初始化 / 369 += / 372 解析），**从无重置**
- **现象（T7.1 实测必现）**：自动端口模式 kill 子进程 → 进入 restarting → 退避 1s 后 starting，但**卡在 starting 80s 不恢复**；`resolvedPort` 滞留旧端口且新端口不可达。
- **根因链**：
  1. restart 时 `outputBuffer` 仍含**上一进程**完整输出（含旧 `dsh web: http://127.0.0.1:<旧端口>`）；
  2. 新进程首个输出触发 `handleOutput`，`resolvedPort == nil`（已清）→ `parsePort` 从**残留旧缓冲**匹配到旧端口 → `resolvedPort = 旧端口`；
  3. 真正的**新端口**随后输出，但因 `resolvedPort != nil` 不再更新；
  4. 旧端口已无进程监听 → `isReachable()` 恒 false → 状态永远 starting。
- **实测输出佐证**（T7.1）：
  ```
  dsh web: http://127.0.0.1:52745        # 首启端口 52745（T1 PASS）
  kill zgid → restarting(a:1) → starting
  已解析实际端口: 52745                   # ⚠️ 新进程首输出即误解析旧端口！
  $ node ... --port 0
  dsh web: http://127.0.0.1:52788         # 真正新端口，被错过
  ... t=20/40/60/80s state=starting resolved=52745 reachable=false  # 卡死
  ```
- **修复建议（对应 owner 修，我不擅自改）**：`startNewProcess()` 内 `resolvedPort = nil` 处**追加一行 `outputBuffer = ""`**。
- **影响**：重启使断 **T7.1 黄金断言** 与 **T3**；固定端口模式不受影响（`resolvedPort` 非 nil，不走 parsePort 分支）。

---

## 逐项明细

### T2 单实例 flock

**T2.1 flock 单实例互斥 ✅ 通过（决定性）**
- 方法：直接运行 `.build/release/HarnessShell`（完整走 main.swift → `SingleInstance.acquire()` → app.run()），先后台启动两个实例，检查 stderr `[singleton]` 日志 + 进程数。
- 结果：
  ```
  实例A: [singleton] 持锁成功(唯一实例)          # 首启持锁 ✅
  实例B: [singleton] 文件锁被占用，检出已有实例，聚焦后退出   # 二次启动被挡，立即退出 ✅
  进程数(实例A/B 同源) = 1                        # 符合单实例 ✅
  ```

**T2 FD_CLOEXEC 防子进程继承 ✅ 通过**
- 方法：持锁实例 A 运行时，`lsof` 查 singleton.lock 的持有者 + 退出后 B 能否立获锁。
- 结果：
  ```
  持有 singleton.lock fd 的进程: 仅 HarnessShell(65667, fd=3) 一个 ✅
  源码确认: fcntl(fd, F_SETFD, FD_CLOEXEC) 已设   # 锁 fd 不被子进程(zsh→node)继承 ✅
  A 退出 → B 立即 [singleton] 持锁成功         # 锁随内核 fd 自动释放，无残留锁 ✅
  ```
- **结论**：flock 主锁 + FD_CLOEXEC + NSRunningApplication 兜底聚焦 全部按预期工作。**T2 通过**。

### T3 崩溃退避重启（状态机骨架，端口恢复被 Bug#1 阻塞）
> 端口恢复（restart→running 的 resolvedPort）被 Bug#1 阻塞（见顶部问题清单）。但状态机自身的「崩溃检出→退避序列→连续崩溃放弃→主动 stop 不重启」**可通过必崩溃命令（`/bin/false`）独立验证**，不依赖 dsh/端口。

（待补：T3.1 退避序列 / T3.3 连续崩溃放弃 / T3.4 主动 stop 不重启）


**T1.parsePort 单元测试 ✅ 通过**
- 方法：独立 `swift` 脚本复刻 `HarnessServiceManager.parsePort`，喂真实 dsh 输出。
- 结果：
  ```
  case0: "dsh web: http://127.0.0.1:62812" -> 62812  PASS
  case1: "127.0.0.1:0 (port 0)"           -> nil     PASS（正确忽略 0）
  case2: "Listening on ...:59000"          -> 59000   PASS
  case3: "Server ... [::1]:64000"          -> 64000   PASS
  case4: "正文无端口"                        -> nil     PASS
  ALL PASS
  ```

**T1.1 端到端（真实 HarnessServiceManager 实例化）✅ 部分通过**
- 方法：`swiftc` 把真实 `HarnessServiceManager.swift + ServiceConfig.swift + @main 测试驱动` 编成独立可执行，用真实 config（`corepack pnpm dsh web` + workingDirectory=deepseek-harness + port 0）实例化并 start。
- 关键输出：
  ```
  [state] ... running; resolved=Optional(52745)
  [T1] resolvedPort=52745 reachable=true => PASS
  ```
- **结论**：自动端口下真实拉起 dsh、从 stdout 解析随机端口、进入 running、端口可达 —— **PASS**。
- 注：T1 本身（单次启动）不受 Bug#1 影响（outputBuffer 初始为空）；Bug#1 只影响 restart 场景（T7.1/T3）。

### T7 叠加回归
**T7.1（kill 崩溃 → restart 后 resolvedPort 正确）⚠️ FAIL（根因 Bug#1）**
- 方法：同 T1.1，running 后 `killpg(spawnedPid, SIGKILL)`，等待重启并断言 `resolvedPort` 变新、可达。
- 结果：**FAIL/阻塞**，详见 Bug#1。`sawRestarting=true`（状态机正确进入重启），但 restart 后端口误解析旧值、卡 starting。
- **对状态机本身的判读**：**崩溃检测 + 退避调度（restarting→starting）工作正常**（日志明确出现 `服务意外退出，1 秒后自动重启（第 1/5 次）` + `restarting(a:1,delay:1.0)`），问题仅在**新端口解析**因缓冲残留失效。→ 状态机骨架 OK，端口恢复有 Bug#1。
- **阻断项**：等待 owner（Flash-2/3）修复 Bug#1 后复测 T7.1 + T3。

---
（持续追加 T2-T6）
