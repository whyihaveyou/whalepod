# 品牌收束改名蓝图：深链 + 路径 + 包名 + 文档一次性改名（WhalePod）

> 作者：工程-Flash-2 | 类型：**只读改名蓝图**（等集成测试全绿 + cordis 迁移完成后执行，不实改）
> 关联任务：#01a00124 【品牌收束】产品定名「鲸群 WhalePod」
> 产品名：鲸群 / 英文 WhalePod
> **Slogan（用户钦定，全仓统一）**：`A Pod of Agents, Powered by DeepSeek Harness`
> 中文语境可配「鲸群——多智能体，共游深海」，以英文原文为准。

---

## 0. 执行前置（闸门）

本蓝图**只是执行地图**，实改须同时满足：
1. ✅ 集成测试 T1-T7 全绿（Flash-1 收尾中）。
2. ✅ cordis 全量迁移落地（编排-Pro #01a00112），否则 `package.json` scope 改名会撞其在飞文件。
3. 单次提交执行完毕，不留中间态，改完跑回归（swift build + 深链用例 + npm test）。

---

## 1. 全局盘点清单

按领域分为 5 组。每组给出：文件路径 / 现状 / 目标值 / 执行顺序 / 风险点。

### A 组（壳层：显示名 + Bundle ID + 标题）

| # | 文件路径 | 现状 | 目标值 |
|---|---|---|---|
| A1 | `HarnessShell/HarnessShell.xcodeproj/project.pbxproj`（**2 处**，Debug/Release） | `PRODUCT_BUNDLE_IDENTIFIER = com.aion2dsh.HarnessShell` | `io.whalepod.desktop` |
| A2 | `HarnessShell/Sources/HarnessShell/Info.plist` | `CFBundleDisplayName = "Harness Shell"` | `"鲸群 WhalePod"` |
| A3 | `HarnessShell/Sources/HarnessShell/MainWindowController.swift:48` | `window.title = "DeepSeek Harness 桌面壳"` | `window.title = "鲸群 WhalePod"`（titleVisibility 已 hidden，改后依旧隐藏不影响） |

**执行顺序**：A1→A2→A3。
**风险**：Bundle ID 变更会让系统不再认识旧的已签名 app（新 bundle id 是全新 app），deep-link/monitoring 需重装；集成测试若依赖旧 bundle id 的深链注册需回归。

### B 组（深链 scheme：`dsh://` → `whale://`）

| # | 文件路径 | 现状 | 目标值 |
|---|---|---|---|
| B1 | `Info.plist` | `CFBundleURLSchemes = ["dsh"]`；`CFBundleURLName = "com.harnessshell.dsh"` | `["whale"]`；`CFBundleURLName = "io.whalepod.desktop"` |
| B2 | `HarnessShell/Sources/HarnessShell/DeepLink.swift:25` | `scheme == "dsh"` | `scheme == "whale"`；文件头注释 `// dsh://` 同步改 `// whale://` |
| B3 | `HarnessShell/Sources/HarnessShell/AppDelegate.swift:27` | 深链入口 `dsh://` 判定/注释 | 同步 whale:// |
| B4 | `HarnessShell/docs/*.md`、`docs/*.md` 深链用例（integration-test.md 已按 dsh:// 跑过一轮） | `dsh://open?port=` 等用例 | 全部 `whale://...`，并**回归一轮深链用例** |

**执行顺序**：B1→B2→B3→B4。
**风险（高）**：深链是运行时注册的 system URL scheme。改名后旧 `dsh://` 链接失效；**集成测试已按 `dsh://` 跑过一轮**，改名后 T4（深链）必须回归。建议 B4 与大改同一提交，紧跟回归。

### C 组（数据/配置路径：`~/.harness-shell/` → `~/Library/Application Support/WhalePod/`）

| # | 文件路径 | 现状 | 目标值 |
|---|---|---|---|
| C1 | `HarnessShell/Sources/HarnessShell/ServiceConfig.swift:71-75` | 配置路径追加 `.harness-shell` | `.appendingPathComponent("WhalePod")`（配置在 `~/Library/Application Support/WhalePod/config.json`） |
| C2 | `HarnessShell/Sources/HarnessShell/SingleInstance.swift:73,84` | 锁目录名 + bundleID 回落 `com.aion2dsh.HarnessShell` | `io.whalepod.desktop`（与 A1 对齐） |
| C3 | 文档/注释（ServiceConfig.swift:6-9 示例） | `~/.harness-shell/config.json` | 新路径 |

**执行顺序**：C1→C2→C3。
**风险（高）**：**与 Flash-3 的 M2「Application Support 根统一为 `~/Library/Application Support/WhalePod/`」对齐**（任务描述 ③：M2 先行用新名）。执行前**必须确认 M2 已落地**，且 DSL 数据（DSH_HOME，M0 OOBE 方案里的 `~/Library/Application Support/HarnessShell/harness`）也归到此根下。**迁移旧数据**：若用户已有 `~/.harness-shell/config.json`，改名后不再读取（无迁移脚本则配置丢失→提示）。建议改名时做「读新路径，旧路径存在则提示迁移」或一次性拷贝。

### D 组（包名 scope：`@dfh/honeycomb` → `@whalepod/honeycomb`）

| # | 文件路径 | 现状 | 目标 |
|---|---|---|---|
| D1 | `packages/honeycomb/package.json:2` | `"name": "@dfh/honeycomb"` | `"@whalepod/honeycomb"` |
| D2 | `packages/honeycomb/package-lock.json:2,8` | `@dfh/honeycomb` | scope 改名 + lock 更新（`npm install` 重新生成） |
| D3 | `packages/honeycomb/src/**/*.ts`（约 30+ 文件头注释 `@module @dfh/honeycomb/...`） | 注释文档串 | `@whalepod/honeycomb/...` |
| D4 | `packages/honeycomb/src/config.ts:135` | `vendor: '@dfh/honeycomb'` | `'@whalepod/honeycomb'` |
| D5 | `packages/honeycomb/src/index.ts:2,8` | `@dfh/honeycomb public entry` | 同步 |
| D6 | `honeycomb-adaptor/{adaptor.ts:15, verify-loader.ts:45}` | `name = '@dfh/honeycomb'`（loader 映射键） | `@whalepod/honeycomb` |
| D7 | `prototypes/team-panel/src/services/*`（transportDto.ts、localHoneycombClient.ts、api.ts、mockApi.ts 注释） | 注释里 `@dfh/honeycomb` | 仅注释 → 同步（等客户端 SDK 落地后 import 也要指向新 scope） |
| D8 | `packages/honeycomb/src/connectors/*` | 头注释 `@deepseek-ai/dsh-honeycomb-connectors` | **保持**：connectors 模块名含 `dsh-`，属实现层词汇（对齐 ⑥「内部实现词汇不动」）——**仅当用户要求才改，默认不动** |

**执行顺序**：D1→D2(重装 lock)→D3/D4/D5(源码)→D6→D7。全仓 `grep '@dfh/honeycomb'` 清 0。
**风险（极高，务必等迁移）**：
- scope 改名 = 包名变更，**pnpm workspace / npm 解析依赖名改变**；`import '@dfh/honeycomb'` 之处若不一起改会解析失败。
- **必须等编排-Pro 的 cordis 迁移（#01a00112）落地后再动**——迁移在飞 package.json/import，改名与其并发会产生解析混乱。Leader 已明确此约束。
- `@deepseek-ai/dsh-honeycomb-connectors` 明确**不动**（⑧ 内部词汇保留）。

### E 组（文档 / README / git）

| # | 位置 | 现状 | 目标 |
|---|---|---|---|
| E1 | `HarnessShell/README.md` **头部（在标题下新增，非替换现有正文）**（无根 README） | 标题 `# HarnessShell — DeepSeek Harness 桌面壳（MVP）`，正文无定位声明 | 标题改 `# 鲸群 WhalePod — DeepSeek Harness 桌面壳`；**新增定位声明块**：基于 MIT 的 DeepSeek Harness 构建并致谢；多智能体编排为独立概念重实现，不含任何 AionUi 代码；**Slogan 用用户钦定话术** `A Pod of Agents, Powered by DeepSeek Harness` |
| E2 | 全仓 `.md` 中「DFH Workstation」 | 旧产品名 | 「鲸群 WhalePod」（README、壳关于面板、文案统一）。当前 grep **尚无**现存的「DFH Workstation」正文字样，执行时以 grep 实测清 0 |
| E3 | 壳「关于」面板 | `orderFrontStandardAboutPanel` 默认用 CFBundle | 靠 A2 的 CFBundleDisplayName("鲸群 WhalePod") 自动带出 |
| E4 | git（**本仓确为 git 仓库**） | 历史提交含旧名 | 改名 patch **作为一个提交**；若与在飞分支冲突，以 Leader 协调为准，不 reset --hard |

**执行顺序**：E 组放**最后**统一刷（E1→E2→E3），避免与 A/B/C/D 并发 diff 混乱。

---

## 2. 执行顺序总览（单提交原则）

```
第一波（壳）   A1 → A2 → A3
第二波（深链） B1 → B2 → B3 → B4(用例回归)
第三波（路径） C1 → C2 → C3   （确认 M2 已落地）
第四波（包名） D1 → D5 → D6 → D7 → D3(批量头注释) → D2(lock 重装)   （迁完成后才动）
第五波（文档） E1 → E2 → E3
回归          swift build 0 error · 深链 whale:// 用例 · npm test · grep 旧串清 0
```

---

## 3. 回归验证清单（改名后必跑）

| 项 | 命令/断言 | 预期 |
|---|---|---|
| 编译 | `cd HarnessShell && swift build` | 0 error 0 warning |
| 深链 | 打开 `whale://open?port=...` / 集成测试 T4 深链套件 | scheme 注册新 id，映射成功 |
| 单实例 | 二次启动第二实例自动退出（锁 用新 bundle id 目录） | 锁名一致，flock 生效 |
| 端口/重启 | 自动端口解析 + 崩溃重启（Bug#1 回归） | resolvedPort 正常（不受改名影响，但仍回归） |
| 包名 | `cd packages/honeycomb && npm test` | scope 改名后测试绿 |
| 残留扫描 | `grep -rn "DFH Workstation\|@dfh/honeycomb\|dsh://\|\.harness-shell\|com\.aion\.harnessshell"` | 除 connectors 的 `dsh-honeycomb-connectors` 外全清 |

---

## 4. 风险总表

| 风险 | 级别 | 缓解 |
|---|---|---|
| 深链 scheme 改名后旧 `dsh://` 失效 | 高 | B4 回归一轮 + 对外话术同步 |
| Application Support 路径迁移丢数据 | 高 | 确认 M2 落地；旧路径提示迁移/一次性拷贝 |
| 包 scope 改名与 cordis 迁移并发冲突 | 极高 | **strictly 等 #01a00112 落地后再动 D 组** |
| Bundle ID 变更 = 全新 app（旧 app 失效） | 中 | 一次到位，accepted as 正式改名 |
| connectors 模块含 `dsh-` 被误改 | 低 | D8 明确不动，回归扫描时 white-list |

---

## 5. 明确「现在不动、等闸门」

- **D 组全部**：等 cordis 迁移（#01a00112）落地。
- **整体执行**：等集成测试全绿 + Leader ping。
- 本蓝图只是地图；执行时按 Leader 最新指引用本文件 + A-E 表逐项落地，不留半套。
