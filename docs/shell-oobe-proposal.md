# HarnessShell「开箱即用 OOBE」改造方案

> 作者：工程-Flash-1 | 类型：**方案文档（先方案后实现）** | 关联任务 #01a00104
> 参考仓库：`/Users/qzp/aion2dsh/refs/dsh-desktop`（dataelement/dsh-desktop，MIT，Electron 跨平台壳）
> 现状：`/Users/qzp/aion2dsh/HarnessShell/`（Swift + WKWebView + 进程管理器，macOS）

> ⚠️ **优先级说明**：集成测试（T1-T7）一旦触发，优先回去执行联调预案（`HarnessShell/docs/integration-test.md`），本 OOBE 改造方案可暂停推进。

---

## 0. 背景与现状对照（为什么需要 OOBE）

我们的 Swift 壳 `HarnessServiceManager` 的 `default` 命令是 `npm exec @deepseek-ai/dsh web`，workingDirectory 默认指向本机 clone 仓库。这意味着**当前假设本机已具备**：① node + npm；② `@deepseek-ai/dsh` 全家桶（或网络可达能装）；③ dsh 数据目录。实测本机：**无全局 dsh、无 `~/.harness-shell/`、无 `~/.harness/`** —— 即"开箱"后首启必然失败/需用户自行准备运行时。

dsh-desktop 与之不同：**完全自举 runtime**（Electron 内置 node + 打包的 `@deepseek-ai/dsh` npm 全家桶），用户零安装、零 clone 即可首启进入 harness。

---

## ① 运行时自举（Runtime Bootstrap）

### dsh-desktop 的做法（已读源码确认）
- **运行时载体**：`nodeExecutable = process.execPath`，即**借助 Electron 内嵌的 Node** 跑 dsh CLI（`ELECTRON_RUN_AS_NODE=1` 语义），无需系统 node。
- **dsh 入口**：`dshEntryPath()` 指向打包后 `Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js` 全家桶（package.json 直接依赖 `@deepseek-ai/dsh@0.1.0-rc.6` 等全部 dsh 包，`npm install`/打包时带入），**不需要用户 clone 仓库**。
- **随机端口**：`reservePort()` 用内核 socket 预占随机端口（对应我们已有的 `--port 0` 自动端口机制）。
- **数据目录**：`DSH_HOME = userData/harness`（安装目录之外，见 ③）。

### 我们 Swift 壳的可行路径评估

| 方案 | 说明 | 优点 | 缺点 | 推荐度 |
|---|---|---|---|---|
| **A. npx 按需拉包** | 首启执行 `npm exec --yes @deepseek-ai/dsh@0.1.0-rc.6 web` | 实现最简；沿用现有等待流 | 首启慢（下载全家桶）；需系统 node/npm；离线不可用；版本漂移 | ☆☆ |
| **B. 应用内嵌 node（推荐）** | 效仿 dsh-desktop：把**独立的 node 运行时** + `@deepseek-ai/dsh` 全家桶打进 .app（`Resources/runtime/`），进程管理器用内嵌 node 直接跑 `bin.js` | 离线可用；版本锁定；真正自举 | bundle 体积大（node ~50MB + dsh 全家桶）；需下载/内置 node | ★★★ |
| **C. 首启自动安装到用户目录** | 首启检测无 dsh 时，用 `npx`/`npm` 在 `~/Library/Application Support/HarnessShell/runtime` 安装 dsh 全家桶，后续复用 | 兼顾体积（不打进 app）；一次联网后离线 | 首启需联网装；仍需系统 node | ★★ |

**推荐方案**：**B（内嵌 node + dsh 全家桶打包进 .app），以 C 作为 fallback**。
- 首选 B：与 dsh-desktop 同构，产品化"开箱即用"最彻底；进程管理器 `HarnessServiceManager` 只需把 `command` 从 `npm exec ...` 改为 `启动内嵌 node 可执行文件 + dsh bin.js 路径`，**与现有随机端口/崩溃重启状态机天然兼容**（命令形态从"shell 命令"改为"绝对路径 node + 参数"，状态机只关心进程生命周期，几乎零改动）。
- fallback C：B 打包体积不宜过大 / 离线受控分发时，首启在用户目录安装一次，含版本锁定（`@deepseek-ai/dsh@0.1.0-rc.6`）避免漂移；安装进度通过我们的「加载态覆盖层」呈现。
- 放弃 A 作为主路线（不可离线、版本漂移、首启不稳）。

**fallback 细节**：C 安装失败（无网/无 node）时，方案回退到现有"引导用户自行准备"的提示页（保持当前 `ServiceConfig` 默认命令可配置），并用 `--port 0` 自动端口避免端口冲突。

---

## ② 首启向导（OOBE：供应商选择 + API key）

### dsh-desktop 的做法（已读 `patches/@deepseek-ai+dsh-client-ui-settings-models+*.patch` 确认）
用 **patch-package** 手法**不 fork 上游**，给 `dsh-client-ui-settings-models` 的前端注入：
- 一个 **Provider Picker**（`.dshProviderPicker` 组件 + `.dshProviderSearch` 搜索框 + `.dshProviderGrid` 卡片网格 + 优先排序 `SETTINGS_PROVIDER_PRIORITY`：deepseek-official/deepseek/openai/anthropic/google/openrouter/xai/moonshot…）。
- "全选/取消全选候选模型" `toggleAllCandidates`（继承模型目录的关键交互）。
- 校验/保存写 harness 的 **Credentials API + 自动建 provider route**（patch 里走 `controller.load()`/`state.rows`），API key 只入 Credentials，不进前端明文持久化。

### 我们 Swift 壳（WKWebView 架构）的等价实现

关键约束：我们是 **WKWebView 内嵌整个 harness Web UI**，没有 Electron 的主进程 DOM 注入能力（只能通过 `WKUserScript` / JS 注入 + `evaluateJavaScript`）。因此"在 harness 页面内做 OOBE"要走以下任一：

| 路线 | 说明 | 适用 |
|---|---|---|
| **R1. JS 注入引导** | 首启通过 `WKUserScript` 注入一段引导脚本：a) 检测 harness 空模型态；b) 在设置模型的 DOM 里**插入 Provider Picker 组件与样式**（复刻 patch 的注入方式）；c) 用户选供应商+填 key → 用 harness 的 Credentials API 写入 → 自动建 route。**无需 fork harness**，与 dsh-desktop 的 patch 同思路，只是注入介质从 Node patch 变 WKUserScript | **推荐**，最贴 harness 原生模型目录 |
| **R2. 原生首启面板** | 首启时 WKWebView 之上盖一个**原生 Swift OOBE 窗口/覆盖层**（供应商下拉 + API key 输入），保存时通过 loopback 调 harness HTTP API（`DSH_WEB_URL`）写 Credentials + 建 route，完成后隐藏覆盖层"就绪即进 harness" | 实现直观；不碰 harness DOM；适合"无落地页、就绪即进" |

**推荐**：**R1（JS 注入 Provider Picker）为主，R2 的原生覆盖层作为"loading 期兜底/等待就绪"的过渡壳**。
- 「无落地页、就绪即进 harness」：首启不展示我们自建落地页，而是保持 harness 加载态覆盖层（现有视觉 chrome 的「加载态」），等到 harness ready → 若检测无模型则弹出 Provider Picker 引导；有模型则直接展示 harness。这与我们现有的「三态覆盖层 + `loadInitialURLIfNeeded`」流程天然衔接。
- **API key → Credentials**：通过 harness loopback 的 Credentials 服务接口写入（走 `DSH_WEB_URL`，与 dsh-desktop 的 loopback API 同构）；**不**在 Swift 侧持久化明文。
- 实现前提：需在 harness 里确认 Credentials API 的 loopback 契约（dsh-desktop 用 patch 注入 UI 同时靠 harness 侧 controller 处理写盘，我们 R1 注入脚本直接调同类接口）。

---

## ③ 升级安全的数据放置（profiles/plugins/sessions）

### dsh-desktop 的做法
- **release 目录结构**（`src/main/state/launch-root.ts` + bootstrap）：`app.getPath('userData')`（macOS = `~/Library/Application Support/<App>`）作为根，`launchDirectory` 由 `ensureLaunchRoot` 创建；`DSH_HOME = userData/harness`。**profiles / plugins / sessions 全部落在安装目录（.app）之外**，升级时替换 .app 不触碰用户数据。

### 我们 Swift 壳 `~/.harness-shell/` 现状对照与差距

| 维度 | dsh-desktop | HarnessShell 现状 | 差距 |
|---|---|---|---|
| 数据根目录 | `userData`（`~/Library/Application Support/<App>`） | `~/.harness-shell/config.json`（当前手工约定路径） | 应用标准 `~/Library/Application Support/HarnessShell/`（`FileManager` `.applicationSupportDirectory`）更规范、备份/沙盒友好 |
| profiles/plugins/sessions | 全在 userData/harness 下，独立于 .app | HarnessServiceManager 用 `~/.harness`（dsh 的 DSH 根，若配）驱动 | 需显式把 dsh `DSH_HOME` 指到 Application Support 下，确保不在 .app 内 |
| 升级安全性 | .app 整体替换，数据不动 | .app 不含数据（本就无内嵌数据） | **已达标**；但默认命令依赖本机 clone 仓库路径（workingDirectory），升级语义弱——改进：改为内嵌/node 自举后彻底脱离 clone，数据才真正与安装解耦 |
| 配置来源 | 无 `~/.harness-shell`；配置在 harness 侧 | `~/.harness-shell/config.json` 自定义 | 建议保留 Swift 侧薄配置（端口/命令 host），其余归 harness「profiles/settings」管理 |

**结论**：数据放置最核心差距 = **「运行时自举」(①) 未做 + 数据根未落到 Application Support**。完成 ① 内嵌自举 + 把 `DSH_HOME`/数据根迁移到 `~/Library/Application Support/HarnessShell/` 后即对齐 dsh-desktop 的"升级安全数据放置"。

---

## ④ 更新机制

### dsh-desktop 的做法
- Electron 专属：`src/main/update/update-manager.ts`（185 行）+ `merge-mac-update-metadata.mjs`（合并 ARM64/x64 两个 `latest-mac.yml` 的 zip 元数据，产出统一 `latest-mac.yml` 由 electron-updater 消费，走 GitHub Releases 分发）。核心是 **electron-updater**（基于 electron-builder 生态）。

### Swift 壳对应路线（简评）

| 方案 | 说明 | 评注 |
|---|---|---|
| **Sparkle（推荐）** | macOS 事实标准自动更新框架；edDSA 签名、支持 `.zip`/`.dmg` 增量、用户态更新（无需管理员）、SUSparkleUpdate 元数据走 appcast | 与我们已有的 ad-hoc/Developer ID 签名链路衔接；把 dsh-desktop 的"两架构 zip + 元数据合并"映射为 Sparkle 的 **appcast.xml**（arm64 条目）。成熟、社区广用、离线更新安全 |
| Squirrel.Mac | Electron 用；Swift 侧不通用 | 不推荐 |
| 自研 update | 轮询版本 + 下载 + 替换 .app | 工作量与安全（签名校验/原子替换）风险高；**不推荐**，除非要最小实现 |
| 手动更新 | 仅引导用户去官网下 DMG | 可用作 fallback |

**推荐**：**Sparkle**，接入时机放在"产品化分发（Developer ID + 公证）"之后（因 Sparkle 更新链路正式上线需已签名公证的基线 + 更新包签名）。**当前阶段（验证/内测）用「手动 DMG 更新」即可**。

---

## ⑤ 附加观察（记录为后续点子，非本任务实现）

- **patch-package 手法**：dsh-desktop 用 `patches/*.patch` 在**不改上游**前提下给 harness 前端注入 OOBE/品牌/Provider Picker。我们可在 Swift 侧用 **WKUserScript 注入**实现等价的"不打 fork 的品牌/向导注入"，是一条低成本高价值的产品化路径。
- **`.dshpreset` 预设包**（`docs/preset-packages.md`）：ZIP 内 `manifest.json` + `preset/`（agent.cordis.yml + skills/plugins），经 **loopback 导出/导入 API**（`DSH_WEB_URL/api/agent-preset.export|import`）原子交换预设、不混入 credentials/key/sessions。这与我们 `@whalepod/honeycomb` 的 **hive/roster 配置导出**有强呼应——可参照其「导出不含敏感 + 导入两阶段校验 + 不改写既有 id」的契约设计 hive/roster 预设包。**记录为后续点子**，不进本任务。

---

## 交付差距清单（从现状→目标）

| # | 差距 | 对应 dsh-desktop 手段 | 本方案动作 | 优先级 |
|---|---|---|---|---|
| G1 | 无运行时自举，依赖本机 npm/dsh/clone | 内嵌 node + dsh 全家桶 | ①方案 B（内嵌），fallback C | **P0** |
| G2 | 无首启 OOBE（供应商+API key） | patch 注入 Provider Picker | ② R1（WKUserScript 注入） | **P0** |
| G3 | 无 Credentials/route 自动配置 | harness loopback Credentials API | ② 走 loopback 写 Credentials | P1 |
| G4 | 数据根为 `~/.harness-shell` 非标准 | `userData/harness` | ③ 迁移到 Application Support | P1 |
| G5 | 更新仅手动 | electron-updater + 元数据合并 | ④ Sparkle（产品化后） | P2 |
| G6 | 无预设交换 | `.dshpreset` | ⑤ 记录点子（对齐 honeycomb hive/roster 导出） | P3 |

---

## 实施拆分建议（供排期参考）

- **里程碑 M0（可与集成测试并行）**：完成 ① 自举的**命令改造**——让 `HarnessServiceManager` 能用一个「内嵌 node 绝对路径 + dsh bin.js」命令启动，验证与现有随机端口/崩溃重启状态机无冲突（这条改的是我们已有 `ServiceConfig.command`，风险集中在 T7 叠加面，宜在集成测试回归后引入）。
- **M1（OOBE 核心）**：② R1 的 WKUserScript 注入 Provider Picker + Credentials 写入（G2/G3）。
- **M2（数据放置）**：③ 数据根迁移到 Application Support + `DSH_HOME` 指正（G4）。
- **M3（更新）**：④ Sparkle 接入，等 Developer ID 公证基线就绪（G5，P2）。
- **M4**：⑤ 预设包对齐（G6，P3，联动 honeycomb）。

**建议切入顺序**：先做 **M0 的自举命令改造 + M2 数据放置**（它们能立刻消除"开箱必失败"），再做 M1 OOBE；M3/M4 押后。

---

## 附：已核实的实现依据（防漂移）
- dsh-desktop `package.json` 依赖 `@deepseek-ai/dsh@0.1.0-rc.6`（最新版本即 rc.6）；`src/main/index.ts` 的 `dshEntryPath()`/`nodeExecutable=process.execPath`/`dshHome=userData/harness`；`src/main/runtime/harness-runtime.ts` 的 `reservePort`/子进程启动；`patches/@deepseek-ai+dsh-client-ui-settings-models+0.1.0-rc.6.patch` 的 Provider Picker 注入；`docs/preset-packages.md` 的 `.dshpreset` loopback 交换契约。
- 我们现状：`HarnessShell/Sources/HarnessShell/ServiceConfig.swift` 默认 `npm exec @deepseek-ai/dsh web` + workingDirectory=clone + `port:0` 自动端口；本机无全局 dsh/npm 包、无 `~/.harness-shell/`、无 `~/.harness/`。
