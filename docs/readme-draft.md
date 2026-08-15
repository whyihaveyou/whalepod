<!--
  root README 草稿（等品牌收束完成后归位为仓根 ./README.md）
  作者：工程-Flash-2 | 关联 #01a0015a | 只读草案
-->

# 鲸群 WhalePod

> **A Pod of Agents, Powered by DeepSeek Harness**
> 中文译意：鲸群 —— 多智能体，共游深海。

WhalePod 是本地运行的多智能体桌面工作站：一组 agent（「鲸群」）在你的 Mac 上协作，
由 **DeepSeek Harness** 提供核心运行时，通过 macOS 桌面壳（Swift + WKWebView）承载。

> **定位声明**：本项目基于 MIT 协议的 [DeepSeek Harness](https://github.com/salathleizhang/deepseek-harness)
> 构建并致谢。多智能体编排（hive/queen/worker 等）为**独立概念重实现**，
> **不含任何 AionUi 代码**；AionUi 仅作为协作工具的参考。

---

## 快速开始（macOS）

前置：macOS 13+，本机已有可用环境（node 22+ 可选）。

```bash
# 1. 桌面壳（Swift，双交付：Xcode 工程 + SPM）
cd HarnessShell
swift run        # 或打开 HarnessShell.xcodeproj 点 Run

# 2. 启动后自动拉起 harness Web UI，并分配随机回环端口（避免端口冲突）
#    自动端口解析 + 单实例锁（防多开）+ 崩溃自动重启（退避）
```

首次运行会：
- 自动分配随机端口并加载 Web UI（无需手动指定 3080）；
- 若已有实例在跑，自动聚焦已有窗口并退出（单实例）。

配置（可选）：`~/Library/Application Support/WhalePod/config.json`
（命令/工作目录/端口 `0=自动|正整数=固定`）。

---

## 架构

```
┌─────────────────────────────────────────────┐
│            WhalePod 桌面壳 (macOS)            │
│  HarnessShell: Swift + WKWebView + 进程管理    │
│   · 自动端口 / 单实例锁 / 崩溃自动重启           │
│   · dsh → whale:// 深链                       │
└───────────────┬─────────────────────────────┘
                │ spawn node dsh web (bundled / fallback)
┌───────────────▼─────────────────────────────┐
│            DeepSeek Harness 核心运行时         │
│  @deepseek-ai/dsh（MIT）—— 本地 Web UI + 编排   │
│  honeycomb（@whalepod/honeycomb）编排框架       │
└──────────────────────────────────────────────┘
```

（架构图位：正式版可补 SVG/ASCII 细节图）

| 层 | 说明 |
|---|---|
| WhalePod Shell | Swift 桌壳：WKWebView、进程管理器、随机端口、单实例、深链、崩溃重启 |
| Harness 运行时 | DeepSeek Harness（dsh），负责 Web UI 与连接器 |
| 编排框架 | honeycomb：hive/queen/worker 多智能体编排（`@whalepod/honeycomb`） |
| 连接器 | ACP（Agent Client Protocol）接入 LSP 等 |

---

## 路线图

| 里程碑 | 状态 | 说明 |
|---|---|---|
| Mac 本地可用 | ✅ 核心 | 桌面壳可用、随机端口、单实例、崩溃重启、深链 |
| 自举运行时 | 🔄 | bundled node+bin.js 打包进 .app（OOBE-M0） |
| 品牌收束 | 🔄 | 产品名「鲸群 WhalePod」、whale:// 深链、数据根统一 |
| Windows 版 | 📌 计划中 | Mac 先行，Windows 列入路线图 |

---

## 命名分层（产品名 vs 实现词汇）

| 层 | 词汇 | 说明 |
|---|---|---|
| 产品 | 鲸群 / WhalePod | 面向用户的产品名 |
| 深链 scheme | `whale://` | 系统注册 URL scheme |
| 实现词汇 | `hive` / `queen` / `worker` / `hatch` / `dismiss` / `honeycomb` | 代码内部实现层，保持不动 |

---

## 开发

```bash
# 桌面壳
cd HarnessShell && swift build          # 0 error 0 warning 目标
# 编排框架（honeycomb）
cd packages/honeycomb && npm test
# 集成测试用例见 docs/integration-test.md
```

分支：`main`（保护） + feature 分支。版本：语义化 `v0.1.0` 起步，配 CHANGELOG。

---

## 致谢 & 许可证

- [DeepSeek Harness](https://github.com/salathleizhang/deepseek-harness)（MIT）—— 核心运行时
- 编排概念独立重实现；不含任何 AionUi 代码。
- 本仓库 LICENSE：MIT（见 `LICENSE`，含 DeepSeek Harness 致谢条款）。
