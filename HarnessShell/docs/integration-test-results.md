# HarnessShell 集成测试结果（T1-T7）

> 执行：工程-Flash-1 | 任务 #01a0010d-ea35 | 状态：**进行中（边测边写）**
> 预案：`HarnessShell/docs/integration-test.md` | 最后更新：2026-08-15 01:07（T7.1 复测通过）
> 环境：macOS aarch64 | node v22.17.0 / npm 11.19.0 | swiftc 6.3.3（CLT，无完整 Xcode）
> 被测：HarnessShell（Swift + WKWebView），Flash-2/3 改动已合入，`swift build -c release` 0 error
> **Bug#1 已由 Flash-2 修复入库（`startNewProcess` 加 `outputBuffer=""`），T7.1 复测 PASS，黄金断言收口 ✅**

---

## 汇总

| 用例 | 结果 | 备注 |
|---|---|---|
| **T1** 随机端口（--port 0 + 解析喂 WebView） | ✅ 通过 | parsePort 单测全过；端到端 running+resolvedPort 可达 PASS |
| **T2** 单实例 flock（含 FD_CLOEXEC） | ✅ 通过 | 互斥/聚焦退出/锁自动释放/无子进程继承 全验证 |
| **T3** 崩溃退避重启 | ✅ 通过 | T3.1 退避序列/ T3.3 连续崩溃放弃/ T3.4 主动 stop 不重启 |
| **T4** dsh:// 深链 | 🟡 待执行 | Risk A/B 已修且在代码确认 |
| **T5** 视觉 chrome | 🟡 待执行 | |
| **T6** 打包签名 | 🟡 待执行 | 我的 Scripts 回归 |
| **T7** 叠加回归 | ✅ **通过** | T7.1 kill→restart 后 resolvedPort 正确且可达（Bug#1 修复后复测） |

---

## 问题清单

### 🐛 Bug #1【已修复 ✅，T7.1 复测 PASS】
**restart 时 `outputBuffer` 残留 → 端口误解析，卡死 starting**
- 根因：`HarnessServiceManager.startNewProcess()` 每次重启只清 `resolvedPort`，未清 `outputBuffer` → 新进程首输出触发 `handleOutput` 时从残留旧缓冲误解析旧端口 → 真新端口被错过 → 卡 starting。
- **修复（Flash-2，commit 已入库）**：`startNewProcess()` 内 `resolvedPort=...` 同一处追加 `outputBuffer=""`，注释清晰。
- **复测 T7.1：PASS**（见下）。
- 价值：由 T7.1 黄金断言（--port 注入 × 崩溃重启叠加）直接抓出，印证预案将其列为首要的正确性。

---

## 逐项明细

### T7 叠加回归（重中之重）

**T7.1 kill→崩溃重启后 resolvedPort 正确且可达 ✅ 通过（Bug#1 修复后复测）**
- 方法：`swiftc` 编真实 `HarnessServiceManager+ServiceConfig+@main`，config=自动端口（corepack pnpm dsh web, port 0）；running 后 `killpg(spawnedPid, SIGKILL)`，等待重启，断言 `resolvedPort` 变化且可达。
- 结果（决定性）：
  ```
  [T1] resolvedPort=55933 reachable=true          # 首启随机端口 ✅
  ### [T7.1] kill spawned pid=67651                # kill 子进程（进程组）
  [T7.1] after crash resolved=55962(was 55933)
         changed=true reachable=true
         sawRestarting=true runningCount=2 backRunning=true
  [T7.1] => PASS                                    # 🎉 黄金断言通过
  ```
- **判读**：
  - `sawRestarting=true`：崩溃检测+退避重启状态机正常；
  - `changed=true & reachable=true`：**restart 后 resolvedPort 更新为新随机端口且服务可达**（outputBuffer 清空修复生效）；
  - `runningCount=2`：首启+重启两次进入 running；
  - `backRunning=true`：kill 后成功恢复。
- **附带确认**：`--port 0` 注入 × 崩溃重启状态机 **同时工作无冲突**；Risk A/B（`.open` 回落 resolvedPort、reloadIfPortChanged/lastLoadedPort）均在代码确认。
- **结论**：T7 是品牌收束关键路径的最后一道门，**通过**。

### T1 随机端口（--port 0 + 端口解析喂 WebView）

**T1a parsePort 单元测试 ✅ 通过**
```
case0: "dsh web: http://127.0.0.1:62812" -> 62812  PASS
case1: "127.0.0.1:0 (port 0)"           -> nil     PASS（正确忽略 0）
case2: "Listening on ...:59000"          -> 59000   PASS
case3: "Server ... [::1]:64000"          -> 64000   PASS
case4: "正文无端口"                        -> nil     PASS
ALL PASS
```

**T1b 端到端（真实 HarnessServiceManager）✅ 通过**
```
[state] running; resolved=Optional(52745)
[T1] resolvedPort=52745 reachable=true => PASS
```
- 自动端口下真实拉起 dsh、从 stdout 解析随机端口、进 running、端口可达。
- 注：Bug#1 修复前 T1 单次启动本就 PASS（初始 outputBuffer 空）；修复后仍 PASS。

### T2 单实例 flock（含 FD_CLOEXEC）

**T2.1 互斥/聚焦退出/进程数保持 1 ✅ 通过**
```
实例A: [singleton] 持锁成功(唯一实例)
实例B: [singleton] 文件锁被占用，检出已有实例，聚焦后退出
进程数 = 1
```

**T2.2 FD_CLOEXEC 防子进程继承 + 锁自动释放 ✅ 通过**
```
持有 singleton.lock fd 的进程: 仅 HarnessShell(65667, fd=3) 一个
源码确认: fcntl(fd, F_SETFD, FD_CLOEXEC) 已设
A 退出 → B 立即 [singleton] 持锁成功    # 无子进程持锁残留
```
- **结论**：flock 主锁 + FD_CLOEXEC + NSRunningApplication 兜底聚焦全部按预期。**T2 通过**。

### T3 崩溃退避重启（全链）

**T3.1 退避序列 + T3.3 连续崩溃放弃 ✅ 通过**
- 方法：command=`exit 1`（启动即崩溃，永不 running）→ restartAttempt 持续累加。观察 `restarting(a,delay)` 序列与最终 failed。
- 结果：
  ```
  退避序列(delay) = 1.0 → 2.0 → 4.0 → 8.0 → 16.0     # 指数退避，与预期逐项吻合 ✅
  FAILED: "服务连续崩溃 6 次，已放弃自动重启，请手动启动"   # 达 maxConsecutiveCrashes 上限转 failed ✅
  连续崩溃样本(restartAttempt 累计) = 5 次后放弃
  ```
- **判读**：T3.1 指数退避序列正确（1→2→4→8→16，30 封顶逻辑在，因 5 次即达放弃上限未触发 30）；T3.3 连续崩溃 5 次放弃正确。

**T3.4 主动 stop 不重启 ✅ 通过（真实 dsh）**
- 方法：真实 `corepack pnpm dsh web --port 0` 进 running 后 `manager.stop()`，断言 stop 后无 restarting 且停在 stopped。
- 结果：
  ```
  [t+0s] starting → [t+6s] running → manager.stop() → [t+8s] stopped
  stop后6s finalState=stopped；restartCount=0（stop 后无任何重启尝试）
  子进程: 无 dsh 残留（stop 的 killpg SIGTERM→SIGKILL 清理生效）
  ```
- **判读**：`userRequestedStop=true` 后 poll 走 stopped 分支、不 scheduleRestart —— 语义正确。
- 注：首轮测试曾出现 `runningAfterStop=YES` 误报，系测试断言时序瑕疵（stop 瞬间 state 残留 running + 循环起点过早），**非产品 bug**；修正断言（只查 restartCount 与最终状态）后 PASS。

**结论：T3 全链通过**（退避序列 / 连续崩溃放弃 / 主动 stop 不重启；restart 端口恢复由 T7.1 覆盖）。

---
（待补 T4/T5/T6）
