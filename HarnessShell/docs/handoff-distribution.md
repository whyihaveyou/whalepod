# 交接报告：鲸群 WhalePod 桌面版（DeepSeek Harness 中文网分发专用）

> 交接范围：**仅限「版本分发与网站建设」**。开发与缺陷修复继续由原开发团队（Aion CLI 团队）负责，接收方不需要、也不应改动任何源码或重新构建。本报告随可作为网站运营/分发 Agent 的工作输入直接使用。

## 一、交付物（主推档 = Full 全家桶；Slim 轻量档见「一·五 版本矩阵」）

| 项 | 值 |
| --- | --- |
| 文件 | `HarnessShell/dist/HarnessShell.dmg`（仓库内路径） |
| 大小 | 224,252,627 字节（≈ 214 MB） |
| SHA-256 | `2dd5baec32502070ac157908ae9975283fbed42f86a2c6ddc346d46c0a31db1d` |
| 完整性 | `hdiutil verify` CRC 校验通过 |
| 代码基线 | commit `ff4039b`（含 Bug#3 修复，2026-08-15） |
| 建议对外版本号 | `v0.1.0-alpha.2`（当前最新；每日小版本节奏更新） |

**dist/ 目录下的 `HarnessShell.zip`（850KB）是旧骨架残留，严禁对外分发，只用上文 DMG。**

> 👉 主推 Full DMG；想要轻量的开发者请看下文「一·五 版本矩阵」的 Slim ZIP。

## 一·五、版本矩阵（2026-08-15 起双档发布，两档代码同源）

> 依据 `docs/version-tiers.md`。两档的壳代码、配置/深链/单实例/崩溃退避/日志**完全一致**，
> 唯一差异是 `.app` 内是否内嵌 Node + dsh（Full 内嵌 / Slim 靠本机 npx）。

| 维度 | **Full 全家桶版**（默认主推） | **Slim 轻量版**（开发者） |
| --- | --- | --- |
| 目标用户 | 普通/测试用户 | 已装 Node 的开发者 |
| 前置依赖 | **无**（免装零依赖） | Node ≥ 22（建议 22.19+） |
| 体积 | ≈ 214 MB（DMG） | ≈ 1.1 MB（ZIP） |
| 首启体验 | 开箱即用，直接进界面 | 首次 npx 拉取 dsh（一次性 ~90MB 入 `~/.npm`，此后走缓存） |
| 无 Node 时 | —（自带） | 降级为 unavailable 指引文案（明确报错 + 安装提示，不崩不空转） |
| 探测链命中 | P1 `bundled` | P3 `npxFallback`（无 node 则 `unavailable`） |
| 产物命名 | `WhalePod-<ver>-macos-arm64-full.dmg` | `WhalePod-<ver>-macos-arm64-slim.zip` |

### 当前两个工件 + 校验值（v0.1.0-alpha.3 / 基线 tag `v0.1.0-alpha.3`）

| 档 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| Full | `HarnessShell/dist/HarnessShell.dmg` | 215,889,736 B（≈206MB） | `0f0589250de413873429d3d7ae5d92cec13f5390bd17edfe702193e163a0bcf2` |
| Slim | `HarnessShell/dist-slim/WhalePod-0.1.0-alpha.3-macos-arm64-slim.zip` | 1,154,969 B（≈1.1MB） | `e26cf1a710b97d2fa67c5d025414036eb49f55cbf6299e58dc85793f62aa2f30` |

验收快照（alpha.3）：DMG env -i 裸环境 bundled 冷启 20s 端口解析+HTTP 200 ✓；Slim 剥 node → unavailable 指引常驻不崩 ✓、正常环境 npxFallback 15s HTTP 200 ✓。

### 当前两个工件 + 校验值（v0.1.0-alpha.8 / tag `v0.1.0-alpha.8`，2026-08-20）

| 档 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| Full | `WhalePod-0.1.0-alpha.8-macos-arm64.dmg` | 209,404,277 B（≈200MB） | `695b8f108c128515f50c5011d3124c61e2e18224af6fb7b95b0362a25e4ef6ae` |
| Slim | `WhalePod-0.1.0-alpha.8-macos-arm64-slim.zip` | 1,200,673 B（≈1.1MB） | `1c7f39c62762d7e9104bc27bb6a27d9ac7ee5d8ca981ca879c399240d07420f0` |

验收快照（alpha.8）：Full DMG env -i 裸环境盒内 node 冷启 35s → honeycomb transport :4800 + dsh web HTTP 200 ✓；Slim 剥 node →『未找到可用的 Node 运行时』指引 ✓、正常环境 npxFallback dsh web HTTP 200 ✓。appcast.xml 已修复杂质（二次运行残留 `</item>` bug，已开修复卡）并挂 alpha.8 release。

> ⚠️ SHA-256 随每次构建变化，本节为**当时发布快照**；日常发布请以构建日志/make-slim.sh 输出为准。

### 安装指引（放网站两栏展示）

**—— 普通用户 → 选 Full DMG ——**

1. 下载 `HarnessShell.dmg`，双击挂载，把 `HarnessShell.app` 拖入「应用程序」。
2. ad-hoc 签名：首次打开**右键 App → 打开** → 弹窗「打开」；或 系统设置 → 隐私与安全性 → 「仍要打开」。
3. 无需装任何东西，直接进 DeepSeek Harness Web 界面。

**—— 开发者 → 选 Slim ZIP ——**

1. 确认已装 Node ≥ 22：`node -v`。
2. 解压 `WhalePod-0.1.0-macos-arm64-slim.zip`，拖出 `HarnessShell.app`。
3. 同上处理 Gatekeeper 后打开；首启自动 `npx --yes @deepseek-ai/dsh@<ver> web` 拉取退化运行时（HTTP 200 即成功）。
4. 没装 Node 想用 Slim？壳会提示安装 Node 而不是崩溃/空转；想走源码模式可在
   `~/Library/Application Support/WhalePod/config.json` 填 `command`（见第六节开发者自定义）。

## 二、这个版本是什么

macOS 桌面壳（Swift/WKWebView）包裹 DeepSeek Harness 的 Web 界面，**开箱即用：用户无需安装 Node.js 或任何依赖**——应用内已自带：

- Node.js **v22.17.0**（darwin-arm64 官方发行版）
- `@deepseek-ai/dsh` **0.1.0-rc.6** 全家桶（npm 净化安装，无 dev 依赖）

即技术路线中的「M0 开箱即用版」。同时保留了给开发者的高级模式（见第六节）。

## 三、系统要求

- macOS，**Apple Silicon（arm64）机型**（M1/M2/M3/M4）。Intel 机型本版不支持。
- 系统版本：macOS 13+（WKWebView 现代特性，建议 macOS 14 及以上获得最佳体验）。
- 无需预装 Node.js / 无需命令行环境。

## 四、安装与首次打开（网站下载页操作指引，可直接抄）

1. 下载 `HarnessShell.dmg`，双击挂载。
2. 把 **HarnessShell.app** 拖入「应用程序」文件夹（或任意位置）。
3. **首次打开**：当前为 ad-hoc 自签名（未做 Apple Developer ID 公证），Gatekeeper 会拦截。正确姿势：
   - 在 Finder 里**右键 App → 打开** → 弹窗中选「打开」；或
   - 系统设置 → 隐私与安全性 → 「仍要打开」。
4. 校验下载完整性（可选，放网站给用户自查）：
   ```bash
   shasum -a 256 ~/Downloads/HarnessShell.dmg
   # 应输出：2dd5baec32502070ac157908ae9975283fbed42f86a2c6ddc346d46c0a31db1d
   ```

## 五、产品行为要点（写 FAQ / 排障文档时用）

- **随机端口**：每次启动随机分配本地端口并自动加载 Web 界面，不占用固定端口。
- **单实例**：重复打开不会起第二个窗口/进程，新请求通过深链转发给已运行实例。
- **崩溃自愈**：内部服务异常退出会自动重启（指数退避），启动阶段连续失败才会停止。
- **深链协议**：`whale://` 可用于外部唤起/跳转。
- **数据与配置目录**：`~/Library/Application Support/WhalePod/`
  - `config.json`：启动配置（见下节）。
  - dsh 运行数据（会话等）亦在此目录（DSH_HOME）。
- **抓日志（排查问题必备）**：应用日志只输出到终端。让测试者在终端执行：
  ```bash
  /Applications/HarnessShell.app/Contents/MacOS/HarnessShell
  ```
  复现问题后把终端输出整段复制回报（日志行均带时间戳，关键行有「resolve OK / 实际端口 / 崩溃」等字样）。

## 六、两种运行模式（FAQ 用）

`~/Library/Application Support/WhalePod/config.json`：

- **默认/开箱即用**：`{"command": "", "port": 0}`（command 留空）→ 自动使用内置 Node + 内置 dsh，用户零配置。
- **开发者自定义**：把 `command` 改为任意 shell 命令（如 `corepack pnpm dsh web`），配合 `workingDirectory` 指向自己的 harness 源码目录，壳会原样执行——便于调试上游 dsh 源码。

普通测试者不要改这个文件；不存在的配置字段会取安全默认。

## 七、已知限制（如实告知测试者）

1. **ad-hoc 签名** → 首次打开有 Gatekeeper 警告（按第四节操作即可）。后续若要「双击直开无警告」，需要 Apple Developer ID 签名 + 公证（要开发者账号凭证，由开发团队另行安排）。
2. **仅 arm64**。
3. DMG 内仅有 App 本体（无 Applications 快捷方式美化，可后续迭代）。
4. 次要：错误输出中的数字偶被误识别为端口（不影响正常运行，服务正常时端口读取正确）。
5. 反馈 Bug 请附：macOS 版本、机型芯片、终端抓到的日志（第五节方法）、能否稳定复现。

## 八、网站分发建议（给建站方）

- **下载文件命名**：建议上传时改名为 `WhalePod-v0.1.0-alpha.dmg`，页面上同时展示上表的 SHA-256，方便用户校验。
- **镜像/防盗链**：221MB 文件注意托管带宽；可放 GitHub Release 或对象存储。
- **页面三要素**：① 系统要求（Apple Silicon + macOS 13+）；② 首次打开「右键→打开」教程（第四节课录）；③ 问题反馈入口（收集终端日志）。
- **GitHub 仓库**：公开仓库上线准备已就绪（LICENSE/README/checklist 齐全），正式 push + Release 由开发团队在凭证就绪后执行；网站可先以网盘直链过渡。
- **品牌口径**：产品名「鲸群 WhalePod」，本质是为 DeepSeek Harness 提供开箱即用的桌面工作站形态；网站可表述为「DeepSeek Harness 中文网 · 官方桌面版」。

## 九、验收结论（开发团队已完成，接收方可放心分发）

- 从 DMG 拷出的 App，在**无任何用户 Node 环境**（剥离 PATH）下冷启动：自动命中内置 runtime → 随机端口 → HTTP 200 返回真实 DeepSeek Harness Web 界面。
- 签名深校验通过；DMG CRC 校验通过。
- 开发者自定义模式（config.json custom command）为团队日常使用形态，持续在用。

## 十、联络边界

- 分发过程中如遇「打不开」「白屏」「端口冲突」等用户报告，收集日志后转交开发团队处理；**不要尝试替用户改 config.json 里的 command 来「修复」**（会切到开发者模式，反而引入变量）。
- 下一版本（Developer ID 公证 / Intel 支持 / DMG 美化 / 版本自动检查更新）由开发团队排期，网站侧预留「版本更新公告」位即可。
