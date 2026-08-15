# 鲸群 WhalePod 版本分档设计

（2026-08-15，响应用户需求："不是每人电脑都有 NodeJS，也有些已经有了，要分开不同情况"。
另吸收 MCXCC303/deepseek-harness-desktop（Tauri v2 非 Electron、极简 Rust 壳、Slim 形态）与
zhu1090093659/dsh-web-ui（插件化生态）两个社区参照。）

## 0. 一句话结论

**发两档：全家桶版（默认）+ 轻量版（开发者）。代码零改动，只是打包开关摆哪儿。**

## 1. 现状事实

- 当前各 Release 只挂 `HarnessShell.dmg` 一个工件 = **全家桶版**：
  `.app` 里塞了 Node v22.17.0 + `@deepseek-ai/dsh@0.1.0-rc.6` 全家桶（≈460MB / DMG ≈214-224MB）。
- `RuntimeBootstrap.resolve()` 是天然的分档引擎，逐级降级、缺啥补啥（均可实测）：

  | 优先级 | 模式 | 条件 | 说明 |
  | --- | --- | --- | --- |
  | P0 | `custom` | config.json.command 非空 | 开发者后路（如 corepack pnpm dsh web 源码目录） |
  | P1 | `bundled` | Resources/node + Resources/node_modules 都在 | **免装零依赖**（全家桶版命中） |
  | P2 | `nodeProbe` | 本机 node ✓ + Resources/node_modules 在 | 系统 node + 内置 dsh（中间档可用，见 §4） |
  | P3 | `npxFallback` | 本机 node ✓ | 首次 `npx --yes @deepseek-ai/dsh@<ver> web` 拉 dsh（轻量版命中） |
  | — | `unavailable` | 以上全灭 | 报错指引安装 Node |

  **裸 .app（删 Resources/node 与 node_modules）= 轻量版、立即工作**，代码不用动一行——这是当初探测链设计时就埋好的。

## 2. 发布档位

| 档 | 受众 | 前置 | 首启体验 | 体积（DMG/ZIP 约） | 命名 |
| --- | --- | --- | --- | --- | --- |
| **Full 全家桶版**（默认主推） | 普通/测试用户 | 无 | 开箱即用 | ~214MB | `WhalePod-<ver>-macos-arm64-full.dmg` |
| **Slim 轻量版** | 已装 Node 的开发者 | Node ≥ 22（建议 22.19+） | 首启 npx 拉 dsh（一次性 ~90MB 入 ~/.npm；此后缓存） | ~5MB | `WhalePod-<ver>-macos-arm64-slim.zip` |

**只发两档的理由**：P2 中间档（带 dsh 不带 node，~100MB）能力与 Full 高度重叠、定位尴尬，
探测链已支持（nodeProbe）将来若有明确诉求随时加；alpha 阶段两档对测试者心智最简。

- 配置/深链/单实例/崩溃退避/日志落盘全部两档一致。
- Slim 无 Node 环境也友好降级：P3 失败 → 明确错误 + 安装指引（RuntimeBootstrap.unavailable 文案已有）。
- Slim 用户可再降维成 custom：conf ig.json 填自己的 dsh 源码命令——开发者极致灵活。

## 3. 平台矩阵现实

| 平台 | 现状 | 说明 |
| --- | --- | --- |
| macOS arm64 | ✅ 现发 | 两档齐 |
| macOS Intel | 🔜 可即做 | build-runtime.sh 换 node darwin-x64 tarball，一行事；真机验证缺设备，先提供、社区实测 |
| Linux | 📋 入册暂缓 | Swift 壳不可移植；参照 MCXCC303 的 **Tauri v2**（Rust+系统 WebView，源码仅 ~7KB launch-壳思想，无 Electron 全家桶）——将来「WhalePod Lite Linux/Windows」走 Tauri + Slim 形态（系统 node + npx 拉 dsh），轻快且维护面小。建议 M4 立项新包 `shells/tauri-lite/`，mac 壳与 ACP 编排底座继续 Swift/TS 主线不动 |
| Windows | 📋 同上 | Tauri 通路一并覆盖 |

## 4. 打包与自动化改动

1. `Scripts/make-slim.sh`（新）：`build-app.sh`（不跑 build-runtime.sh）→ ad-hoc 签名 → `make-zip.sh` 产出 slim zip。
   体积报告顺手打印（app skeleton ~1.4MB）。
2. 每日 20:00 cron 发版流程 + `release.yml`（手动档）：matrix 产出 **两个工件 + 双 sha256**；
   Release notes 模板加两档对照表与各自安装指引。
3. `HarnessShell/docs/handoff-distribution.md`：加「版本矩阵」一节（本文件 §2 表 + 校验值），
   网站 agent 下载页按两栏展示（普通用户→Full；开发者→Slim）。
4. e2e/CI 影响：无（slim 编译产物与 full 完全相同，只是资源不同——CI 现有 swift build 已覆盖）。

## 5. 验收口径（每档每日）

- Full：现行铁律（DMG 拷出 + 剥离 Node 冷启 → bundled 命中 → HTTP 200）。
- Slim：**带系统 node** 环境直启 → 命中 npxFallback（首次拉包可能慢，文案已就位）→ HTTP 200；
  **剥离 node** 直启 → unavailable 指引文案出现（不崩、不空转）。

## 6. 与两类社区参照的吸收记录

- Tauri（MCXCC303）：证明了「Rust 壳 + 系统 WebView + spawn dsh web + 解析 URL」在非 mac 平台的极简路数；
  其「多窗口共用自动随机端口」与我们随机端口+单实例锁同源思想；我们额外有崩溃退避/深链/日志/双档。
- dsh-web-ui：M1 皮肤中心/插件集已在北极星四卡中吸收（#9056 嵌入 + 后续皮肤中心）。
