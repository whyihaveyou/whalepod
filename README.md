# 鲸群 WhalePod

[![CI](https://github.com/whyihaveyou/whalepod/actions/workflows/ci.yml/badge.svg)](https://github.com/whyihaveyou/whalepod/actions/workflows/ci.yml)
[![Release](https://github.com/whyihaveyou/whalepod/actions/workflows/release.yml/badge.svg)](https://github.com/whyihaveyou/whalepod/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **A Pod of Agents, Powered by DeepSeek Harness**

鲸群（WhalePod）是一个面向 macOS / 后续跨平台的桌面工作站，基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建并致谢。围绕 Harness 的多智能体编排核心，我们独立设计并实现了名为 **蜂巢（Honeycomb）** 的 `@whalepod/honeycomb` 编排框架——它把 leader/worker 角色、roster 注册表、任务板、消息总线、spawn/shutdown 生命周期等概念映射到 Cordis 原语（service / events / lifecycle / config / persistence），是一份**概念级的重实现**，不包含任何 AionUi 代码。

> 简称：**WhalePod**（中文常用「鲸群」；本仓库内一律以此为准）

---

## ✨ 它做什么

- **桌面壳 HarnessShell**（macOS Swift + WKWebView）：一个自举的薄壳，启动 harness Web UI，无需用户在终端跑命令。
- **多智能体编排 @whalepod/honeycomb**：以蜂巢词汇（Hive / Queen / Worker / Roster / Ledger / Courier / Mandate / hatch / dismiss）建模多 agent 协作。
- **连接器层**：把外部 CLI agent（Claude Code / Codex / Kimi Code / OpenCode / Hermes 等）自动识别并包装成可被编排的 teammate。
- **运行时自举（M0）**：壳自动探测或 provision 运行时——bundled node + `@deepseek-ai/dsh` bin.js 优先，本机 node 探测其次，npx 兜底。
- **开箱即用首启（OOBE）**：首次启动进入 Provider Picker → 填写 API key → 直接进入 Harness，无需预先装 Node / clone 仓库。

---

## 🚀 快速开始

> **目标用户**：开发者；首次启动会让你在壳内选模型供应商并填 API key。

```bash
# 1) 克隆
git clone <remote-url>   # 待最终仓库名确认（建议 whalepod）
cd whalepod

# 2) 安装依赖（pnpm workspace）
pnpm install

# 3) 构建壳（macOS）
cd HarnessShell
swift build

# 4) 启动壳
.build/debug/HarnessShell

# 5) 跑一次蜂巢 quickstart（验证全链路）
cd ../packages/honeycomb
pnpm run example
```

更多细节见 `HarnessShell/docs/integration-test.md` 与 `docs/shell-oobe-proposal.md`。

---

## 🏗️ 架构总览

```
┌──────────────────────────────────────────────────────────┐
│  HarnessShell (macOS Swift + WKWebView)                  │
│  ├─ RuntimeBootstrap (M0)  └─ ServiceManager (状态机)   │
│  └─ WKWebView ←→ Harness Web UI (DSH client)            │
└────────────────┬─────────────────────────────────────────┘
                 │ http://127.0.0.1:<随机端口>
                 ▼
┌──────────────────────────────────────────────────────────┐
│  Harness Web UI (React)         + DSH server             │
│  ├─ TeamPanel (proto)            ├─ agents / tools      │
│  └─ @dfh/honeycomb-plugin                                 │
└────────────────┬─────────────────────────────────────────┘
                 ▼
┌──────────────────────────────────────────────────────────┐
│  @whalepod/honeycomb                                       │
│  ├─ services/    hive ledger courier mandate roster      │
│  ├─ persistence/ facts.ndjson (append-only + 重放)       │
│  ├─ runtime/     MemberRuntime (registry + agent bridge) │
│  ├─ connectors/  detect → spawn (claude/codex/...)       │
│  ├─ consumer/    orchestration-loop (event-driven)      │
│  └─ transport/   HTTP + WS for team panel                │
└──────────────────────────────────────────────────────────┘
```

完整设计见 `docs/honeycomb-orchestration-architecture.md`、`docs/honeycomb-orchestration-loop.md`、`docs/honeycomb-transport-api.md`。

---

## 📚 命名分层：产品名 vs 实现词汇

| 层 | 用语 | 说明 |
|---|---|---|
| **产品层** | 鲸群 / WhalePod | 用户可见的产品名（窗口标题、DMG 卷名、关于面板、官网） |
| **外壳层** | HarnessShell | 源码目录名 / Xcode 工程名（CFBundleDisplayName 用「鲸群 WhalePod」） |
| **包层** | `@whalepod/honeycomb` | npm scope（仅 scope 重命名；包内 vocabulary 不变） |
| **实现词汇** | Hive / Queen / Worker / Roster / Ledger / Courier / Mandate / hatch / dismiss | 编排框架的领域模型与 API 词汇，对外暴露在 service / event 名 |
| **承载平台** | DeepSeek Harness | 下游依赖，致谢但不二次分发其源码 |

**这意味着**：你在代码里看到的是「蜂巢词汇」，但产品本身叫「鲸群」——这是有意区分的（产品名属于用户，实现词汇属于工程师心智模型）。

---

## 🗺️ 路线图

- [x] **macOS 桌面壳 + 蜂巢核心 + 品牌收束**（当前里程碑 v0.1.0）
  - [x] Swift + WKWebView 薄壳
  - [x] 随机端口 + 单实例锁 + 崩溃退避重启 + `whale://` 深链
  - [x] `@whalepod/honeycomb` 编排核心（5 services + persistence + transport + connectors）
  - [x] 品牌收束：产品名 / 深链 / 数据路径 / 包 scope / 图标
- [ ] **OOBE 首启向导（M1）**：壳内 Provider Picker → API key → 直接进入 Harness
- [ ] **打包链路（build-runtime.sh）**：把 node + `@deepseek-ai/dsh` 全家桶打进 `.app`
- [ ] **代码签名 + 公证（Developer ID）**：从 ad-hoc 升级到 notarized 分发
- [ ] **Windows 桌面壳**：Swift → Tauri / Electron 复刻相同能力
- [ ] **团队面板 v1 上线**：React + 真实 transport API 替换 mock
- [ ] **GA 1.0**：稳定 API + 完整文档 + 自动更新（Sparkle / Squirrel）

---

## 📦 仓库目录

| 路径 | 用途 |
|---|---|
| `HarnessShell/` | macOS Swift + WKWebView 桌面壳源码 |
| `packages/honeycomb/` | `@whalepod/honeycomb` 多智能体编排核心 |
| `prototypes/team-panel/` | React 团队面板原型（mock 数据层，可切真实 API） |
| `design/` | 设计 token、组件规范、视觉识别 |
| `docs/` | 架构设计、OOBE 方案、集成测试、安全扫描、GitHub 上线清单 |
| `scripts/` | 通用脚本 |
| `honeycomb-adaptor/` | harness 插件接入验证 |
| `refs/` | 参考仓库（gitignored，不入仓） |
| `deepseek-harness/` | upstream clone（gitignored，不入仓） |

---

## 📄 License 与致谢

本项目以 **MIT License** 发布，详见根目录 [`LICENSE`](./LICENSE)。

构建于以下开源项目之上，谨此致谢：

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —— MIT，本仓库的核心依赖；我们引用其 Cordis 原语与多智能体编排语义，但**所有蜂巢词汇与 service 实现均为概念级重实现，不包含其源码或 AionUi 代码**。
- **[Cordis](https://github.com/deepseek-ai/cordis)** —— MIT，蜂巢框架的底层插件原语。
- **[dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop)** —— MIT，开箱即用与运行时自举的参考实现。

依赖许可证兼容性清单见 [`docs/license-compatibility.md`](./docs/license-compatibility.md)。

---

## 🤝 贡献

内部团队通过任务板协作；外部贡献请先开 issue 讨论再发 PR。本仓库尚处于早期（v0.1.0 pre-release），公开 API 可能在 1.0 之前调整。

---

## 中文语境译意

> 鲸群 —— 多智能体，共游深海。