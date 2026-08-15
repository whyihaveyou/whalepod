# Changelog

All notable changes to **鲸群 WhalePod** (formerly "DFH Workstation") will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 命名：产品已定名「鲸群 WhalePod」（slogan：A Pod of Agents, Powered by DeepSeek Harness）。
> 包名已从 `@dfh/*` 迁移到 `@whalepod/*`，深链 scheme 已从 `dsh://` 迁移到 `whale://`（详见 `docs/whalepod-rename-plan.md`）。

---

## [Unreleased]

### Added
- GitHub 上线准备：MIT LICENSE（含 DeepSeek Harness 致谢）+ 完整 `.gitignore`
  （用户数据目录、构建产物、密钥等不入库）+ 安全扫描清单
  (`docs/security-scan.md`)。

### Changed
- 品牌收束（rebrand）落地：
  - 包 scope `@dfh/honeycomb` → `@whalepod/honeycomb`（src/docs/adaptor/team-panel 共 61 文件）
  - Bundle ID `io.whalepod.desktop`、应用标题「鲸群 WhalePod」
  - 深链 scheme `dsh://` → `whale://`
  - 产品名「DFH Workstation」→「鲸群 WhalePod」（全仓文案、文档编号 DFH-WS → WP）
  - 数据路径收束到 `~/Library/Application Support/WhalePod/`（旧路径 `~/.harness-shell/` 仍兼容）

### Removed
- 临时诊断脚本 `scripts/_connector-live3.ts` / `_kimi-test.ts` / `_probe-kimi-codex.ts`（公开前清理）。

---

## [0.1.0] - 2026-08-15

> **首个公开预发布 (Pre-release)。** 已在 macOS 本地完成联调（`HarnessShell/docs/integration-test-results.md`）；
> Windows 版列入路线图，Mac 先行。
>
> ⚠️ **API 仍可能小幅调整**：包名 `@dfh/*` → `@whalepod/*`（rebrand 中）；
> 深链 scheme `dsh://` → `whale://`（rebrand 中，集成测试预案 T4 已留位 whale:// 全用例回归）。

### Added
- **`packages/honeycomb/` — `@whalepod/honeycomb` 多智能体编排核心插件**
  - Cordis 原语适配层（service / events / lifecycle / config / persistence）
  - Roster 服务（成员注册表）、任务板服务、消息总线、角色权限、idle 状态机、spawn/shutdown 生命周期
  - 连接器骨架（registry / types / adapter / detect / bridge），覆盖 Claude Code / Codex / Kimi / OpenCode / Hermes 的 `detect()` 基线
  - 内置工作流/目标/计划/技能子模块、调度/会话/持久化/上下文管理/压缩、护栏/审批/反馈
  - 传输层 + 客户端 SDK（task-board / team / permission / idle / spawn / shutdown）
  - 示例：`examples/hive-quickstart/`
  - 单元/集成测试：smoke / e2e-core / persistence / transport-* / orchestration-loop / connector-live

- **`HarnessShell/` — macOS 桌面壳（Swift + WKWebView）**
  - WKWebView 内嵌 harness Web UI（指向 `127.0.0.1:<随机端口>`）
  - 进程管理器（启停 harness 服务，崩溃退避 1→30s 封顶，5 次放弃）
  - 自动端口（`--port 0`）+ stdout 解析 + 子进程组清理（`killpg` SIGTERM→SIGKILL）
  - 单实例守护（flock 文件锁 + `FD_CLOEXEC` 防子进程继承 + NSRunningApplication 兜底聚焦）
  - `dsh://` URL Scheme 接入（`open?port=N` / `session/<id>` / `unknown`），冷启动 `pendingDeepLink` 补注
  - 视觉 chrome：暗色优先 / 4 色状态点（active/progress/idle/danger）/ 三态覆盖层（加载/未运行/错误）
  - 打包/分发：`Scripts/build-app.sh` / `make-dmg.sh` / `make-zip.sh` / `sign.sh`（ad-hoc | devid | pkg 三档）/
    `release.sh`（一键）；ad-hoc + Developer ID + 公证全链路；HMDI DMG + zip

- **`docs/`**
  - `repo-map.md` — deepseek-harness 仓库结构 + 构建/运行说明 + 与本项目关联
  - `shell-oobe-proposal.md` — HarnessShell 开箱即用（OOBE）改造方案（自举/OOBE/数据放置/更新；推荐 B 内嵌 + C fallback + WKUserScript 注入 Provider Picker）
  - `harness-feature-inventory.md` — 完整功能 inventory（对齐基准）
  - `HarnessShell/docs/integration-test.md` / `integration-test-results.md` — 全功能集成测试预案 + 执行结果（T1-T7 全绿，含 Bug#1 复盘）
  - `HarnessShell/docs/distribution.md` — macOS 分发链路（sign/notarize/pkg 三档命令）
  - `design/` — 设计 token + 组件规范 + 视觉识别（与 `harness-shell-design` 任务对接）

### Fixed
- **Bug#1（集成测试 T7.1 抓出）**：`HarnessServiceManager.startNewProcess()` 重启时未清空
  `outputBuffer`，导致 `handleOutput` 从残留旧缓冲误解析旧端口、新端口被错过、服务卡死
  `starting`。修复方式：`startNewProcess()` 内 `resolvedPort` 赋值处追加 `outputBuffer = ""`。

### Security
- 见 `docs/security-scan.md`（GitHub 上线准备扫描清单）。
- 用户数据目录（`~/.harness-shell/`、用户级 `Library/Application Support/...`）通过
  `.gitignore` 严格不入库。

---

## 版本化与 Git Tag 规范

### 语义化版本（Semantic Versioning）

格式 `MAJOR.MINOR.PATCH`，前缀 `v`（用于 Git tag），版本号 **不带** `v` 前缀写入 `package.json`/`CFBundleShortVersionString`。

| 等级 | 触发条件 | 示例 |
|---|---|---|
| **MAJOR** | 不兼容的 API/协议变更（如深链 scheme 改名 `dsh://` → `whale://`、包名 scope 改 `@dfh` → `@whalepod`） | `1.0.0` |
| **MINOR** | 向后兼容的功能新增（如新增 connector adapter、新增 cordis service） | `0.2.0` |
| **PATCH** | 向后兼容的 bug 修复（如 Bug#1） | `0.1.1` |

预发布标识：
- `0.1.0-rc.1` —— 候选版本（集成测试全绿但尚未产品化分发）
- `0.1.0` —— 公开发布
- `1.0.0` —— API 稳定、签名公证链路就绪、产品视觉识别定稿

### Git Tag 规范

- **格式**：`v<MAJOR>.<MINOR>.<PATCH>`，例如 `v0.1.0`、`v0.1.0-rc.1`。
- **推送策略**：
  - 本地仓库 `git tag -s v0.1.0 -m "release: 0.1.0"`（GPG 签名 tag，由 release owner 决定）
  - 推送到 origin：`git push origin v0.1.0`
  - **禁止**本地重写已推送 tag（`git tag -f`）—— 改用递增版本号（如 `v0.1.0` → `v0.1.1`）
- **发布说明**：每次打 tag 必须同步更新本 `CHANGELOG.md` 顶部 `[Unreleased]` 段，归并到 `[X.Y.Z] - YYYY-MM-DD`。
- **预发布 tag**：在产品化分发（Developer ID + 公证）尚未就绪时，统一打 `vX.Y.Z-rc.N`。

### 配套脚本（建议）

```bash
# 约定俗成的发布脚本（项目根 .github/workflows/release.yml 或 scripts/release.sh）
git tag -s v0.1.0 -m "release: 0.1.0 — 首次公开预发布"
git push origin v0.1.0
```

---

[Unreleased]: https://example.com/compare/v0.1.0...HEAD
[0.1.0]: https://example.com/releases/tag/v0.1.0