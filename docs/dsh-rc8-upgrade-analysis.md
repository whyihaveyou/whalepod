# dsh rc.5 → rc.8 升级侦察分析（Task #01a01d27-e559）

> 状态：**DONE — 侦察/分析/方案产出完成，未动源码改码（符合本卡"先做分析"边界）**
> 归属：连接器-Pro（slot 019ffff3-38f9-75a1-b2ff-3e331085cf6d）
> 完成：2026-08-20
> 关键结论速览：**① 我们基线(=rc.5 fork)零引用上游 agent-team → 改名不动我们文件；② npm 是可达主通道，rc.8 已在 npm；③ 推荐方案 A（box 层 npm 升级）。**

## 0. 目标

上游 deepseek-ai/deepseek-harness 已发布 `dsh-v0.1.0-rc.8`（我们 vendored 基线为 **rc.5**）。
用户要求跟进适配最新版。本卡做**侦察分析**（不动手改码），产出：

1. 拉取 rc.8 源码树（探索可行通道）
2. diff rc.5→rc.8 完整变更清单，重点 agent teams 重命名前后的 **路径/service key/package 名 映射表**
3. 影响评估：逐项对我们的 patch 清单打标（不受影响/需改路径/需重写）
4. 产出本文档 + 升级实施方案（重放顺序、验证清单、回退预案）

## 1. 基线事实（待核实后固化）

| 项 | 值 | 备注 |
|---|---|---|
| vendored 基线 commit | `47f9438`（upstream origin/master） | 待核实是否 rc.5 |
| vendored 本地叠加 commit | 9 个（含 ui-whalepod-team 面板接线） | 待核实 |
| 上游 rc.8 tag | `dsh-v0.1.0-rc.8`（141eb6fe） | 侦查已确认 |
| 上游 rc.7 tag | `dsh-v0.1.0-rc.7` | 侦查已确认 |
| 无 rc.5/rc.6 tag | 上游无对应 tag | 侦查已确认 |

## 2. rc.8 关键变更（高危，倍关注）

- **PR #2783 系列**（高危）：
  - `refactor: rename agent teams service key`
  - `rename experimental agent team directories`
  - `prefix experimental package names`
  - → 直接威胁 `ui-whalepod-team` 面板接线 + harness profile seed + 3e 归一化 patch
- **顺带收益**：
  - `fix(llm-deepseek) reasoning content 每轮回传`（PR #2786）
  - `brand guidelines i18n`

## 3. 关键发现：upstream agent-team 重命名映射表（PR #2787 / commits 已获取）

**重大发现：我们 vendored 基线（rc.5，`47f9438`）中根本不存在 `packages/experimental/*` agent-team 包。**
全仓 grep `ctx.teams|agent-team|tool-agent-team|dsh-team|dsh-tool-team|experimental` 在
`packages/**/*.ts` 下**零命中**。upstream 的 agent-team 服务是在我们 fork 之后才引入的。

因此 PR #2787 的 service key + 目录 + 包名三重改名，**不与我们的 fork 文件直接冲突**。
但 rc.8 引入了全新的 `ctx.agentTeams` / `@deepseek-ai/dsh-experimental-agent-team` API 面，
是我们的**策略决策点**（要不要跟进采用，替代/并存我们的 ui-whalepod-team 面板）。

### 3.1 上游 agent-team 三连改名（PR #2787，merge `b862725e`）

上游演进路径（4 步，我们基线全无）：

| 阶段 | commit | 目录 | 包名 | service key | 插件 id |
|---|---|---|---|---|---|
| 初始 | — | `packages/experimental/team/` | `@deepseek-ai/dsh-team` | `ctx.teams` | `team` |
| 初始 | — | `packages/experimental/tool-team/` | `@deepseek-ai/dsh-tool-team` | — | `tool-team` |
| ①目录改名 | `cb93304e` | `team/`→`agent-team/`，`tool-team/`→`tool-agent-team/` | — | — | — |
| ②包名加前缀 | `0e51d5ff` | — | `dsh-team`→`dsh-experimental-agent-team`，`dsh-tool-team`→`dsh-experimental-tool-agent-team` | — | — |
| ③service key | `4dd1be1a` | — | — | `ctx.teams`→`ctx.agentTeams` | `team`→`agent-team`，`tool-team`→`tool-agent-team` |

**rc.8 最终态**（我们升级后要面对/可采用的）：

- 目录：`packages/experimental/agent-team/`、`packages/experimental/tool-agent-team/`
- 包：`@deepseek-ai/dsh-experimental-agent-team`、`@deepseek-ai/dsh-experimental-tool-agent-team`
- service key：`ctx.agentTeams`
- 插件 id：`agent-team`、`tool-agent-team`
- inject：`['agents', 'agentTeams', 'tools', 'systemPrompt']`
- 版本：`0.1.0-rc.7`

### 3.2 我们的 ui-whalepod-team 面板是解耦的（关键降险）

- `packages/client/ui-whalepod-team/`（`@deepseek-ai/dsh-client-ui-whalepod-team`）
- 数据源：`src/app/services/{honeycombApi,api,transportDto,localHoneycombClient}.ts` → **whalepod/honeycomb transport**
- cordis 面：仅 `inject: ['slots','locale','theme']` + `id: whalepod-ui`
- **完全不用 upstream `ctx.teams` service** → 重命名不直接影响面板

## 4. 我们的 patch 清单与打标（定稿）

| # | patch | 涉及路径/service key/package | 影响打标 | 详情 |
|---|---|---|---|---|
| P1 | aurora theme patch（ui-theme-aurora） | `deepseek-harness/packages/client/ui-theme-aurora/`（未提交 untracked 新包） | ✅ **不受影响** | 独立 client 新包；不涉 agent-team/cordis service key |
| P2 | 3e 归一化（three-equation CSS 归一化） | 归档脚本（`deepseek-harness/.agents/...`）+ aurora 主题内部 | ✅ **不受影响** | 纯前端归一化，不依赖上游 service key |
| P3 | profile seed（cordis.patch.yml insert whalepod-ui） | `@deepseek-ai/dsh-client-ui-whalepod-team` + `web-app/cordis.patch.yml` | ⚠️ **需复核/重放** | 不涉 ctx.teams；但 patch.yml 需在新 fork 树重放 + 版本对齐 |
| P4 | harness client plugin 接线（ui-whalepod-team 面板） | `@deepseek-ai/dsh-client-ui-whalepod-team` ↔ honeycomb transport | ⚠️ **需复核 slots/transport** | 面板经 honeycomb transport 取数，主体解耦；peer `dsh-client-ui-slots`/`cordis@^4.0.1` 两版稳定 |
| P5 | build-runtime.sh dsh 依赖假设 | `@deepseek-ai/dsh@$DSH_VERSION`（默认 rc.6） | ⚠️ **需改版本号(低)** | 仅 `DSH_VERSION=0.1.0-rc.8` + `RuntimeBootstrap.dshVersion` 对齐；面板 tarball 手动 extract，版本无关 |

**版本对齐事实（实测）：**
- `HarnessShell/Sources/.../RuntimeBootstrap.swift:11` → `static let dshVersion = "0.1.0-rc.6"`
- `HarnessShell/Scripts/build-runtime.sh:61` → `DSH_VERSION=${DSH_VERSION:-0.1.0-rc.6}`
- fork 根 `deepseek-harness/package.json` version = `0.1.0-rc.5`（源码树申明，未发 npm）
- 面板 tarball `deepseek-ai-dsh-client-ui-whalepod-team-0.1.0-rc.5.tgz`（`pnpm pack` 将 `workspace:^` peer 改写为 `^0.1.0-rc.x`/`^4.0.1`）
- base `@deepseek-ai/dsh` 依赖树 rc.6/rc.8 均 cordis `^4.0.1`

## 5. 拉取通道探索（完成）

✅ **npm registry 可达（最优通道）—— 升级部署主通道，绕开 github 墙**

`npm view @deepseek-ai/dsh versions`（成功）：
```
0.0.1-rc.1 / 0.0.1-rc.2 / 0.0.1-rc.5 / 0.1.0-rc.2 / 0.1.0-rc.3 / 0.1.0-rc.6 / 0.1.0-rc.7 / 0.1.0-rc.8
```
- **`@deepseek-ai/dsh@0.1.0-rc.8` 已在 npm 发布**（与 github `dsh-v0.1.0-rc.8` tag 对应）。
- 我们 `build-runtime.sh` 已走 npm 拉包 → 发 rc.8 **完全不需要 github**。
- 已 `npm pack` 拉取 rc.6 与 rc.8 两个 tarball 做包面 diff（见 §6.3）。

其他通道核验：
- [x] gh api 单点/单 commit diff：可用（重试可过）；大 compare 分页易 stream error。
- [x] commit 级 diff：`Accept: application/vnd.github.v3.diff` 成功（3 个改名 commit 全量 patch 已取）。
- [ ] github tarball（当日超时）——**已被 npm 通道取代，无需再绕行**。
- [ ] git shallow fetch（ghproxy 超时）——不必要，配额留给精细 diff。

> 注：`0.1.0` 档无 rc.5（仅 rc.2/rc.3），存在 `0.0.1-rc.5`。我们 fork 声明的 `0.1.0-rc.5` 从未发 npm；
> 盒内实际 dsh 已是 `0.1.0-rc.6`（`RuntimeBootstrap.dshVersion` + `build-runtime.sh DSH_VERSION` 均 rc.6）。

## 6. 变更清单（rc.5→rc.8，完成主体 + 包面 diff）

### 6.1 高危（agent-team 系列，已确认）— 见 §3.1
### 6.2 顺带收益（侦查确认）
- `fix(llm-deepseek) reasoning content 每轮回传`（PR #2786）
- `brand guidelines i18n`
### 6.3 已发布包面 diff（rc.6 → rc.8，npm tarball，权威）

`@deepseek-ai/dsh` meta 包依赖树：
- cordis：`^4.0.1` **两版不变**（honeycomb/面板 peer 均仍满足）
- 全部 `@deepseek-ai/dsh-*` 子包：rc.6 → **rc.8** 整体版本滚动
- **工具改名**：`@deepseek-ai/dsh-tool-bash-persistent`（rc.6）→ **`@deepseek-ai/dsh-tool-pwsh-persistent`**（rc.8）
  - ⚠️ 影响任何依赖 bash-persistent 的配置/插件注入点
- **base 包不含 agent-team experimental**：`@deepseek-ai/dsh` 依赖树里**没有** `dsh-experimental-agent-team`/`dsh-tool-agent-team`（它们是独立 opt-in experimental 包）→ **装箱 rc.8 不引入 agent-team 断链**

## 7. 影响评估逐项（定稿）

**核心结论：上游 agent-team 实践（`ctx.teams`→`ctx.agentTeams` 三重改名）不动我们的 fork 文件**
（我们基线零引用 → 见 §3）。升级主风险收敛为三处：

1. **版本号对齐**（P3/P5）：box 从 rc.6 → rc.8，需同步 `DSH_VERSION` + `RuntimeBootstrap.dshVersion`。
2. **重放我们的 patch 层**（P3/P4）：把 10 个本地 commit + untracked 补丁（aurora、cordis.patch.yml insert whalepod-ui）重放到 rc.8 fork 树上。
3. **策略决策**：是否跟进采用 upstream `ctx.agentTeams` / `@deepseek-ai/dsh-experimental-*` 作为团队服务替代我们自建面板数据链路（量级大，非本卡范围，另立卡）。

**rc.8 → rc.6 包面实质差异（会对我们的 box/脚本产生影响的仅一处）：**
- `dsh-tool-bash-persistent` → `dsh-tool-pwsh-persistent`（若我们的 config/plugin 有 inject/依赖 bash-persistent 处需跟随改名）

### P3/P4 具体复核点（升级时逐一验证）
- `web-app/cordis.patch.yml`：`whalepod-ui` 插件 insert 段在 rc.8 web-app 树仍存在同名 slot 位置
- 面板 peer：`@deepseek-ai/dsh-client-ui-slots` 在 rc.8 存在且 slots id 未变（`id: whalepod-ui`）
- honeycomb box 的 cordis `^4.0.1` peer 与 rc.8 兼容（两版均 `^4.0.1`，应满足）

## 8. 升级实施方案（重放顺序 / 验证清单 / 回退预案）

### 8.1 方案 A（推荐，低风险）：npm 运行时升级 — 只动 box 不动 fork 源码树
适合"先吃到 rc.8 修复（reasoning 回传等），不动自研面"。

1. `build-runtime.sh`：`DSH_VERSION=0.1.0-rc.8`
2. `RuntimeBootstrap.swift`：`dshVersion = "0.1.0-rc.8"`
3. 重打盒：`npm install @deepseek-ai/dsh@0.1.0-rc.8` + 面板 tarball `pnpm pack` 重打（版本滚到 rc.8）
4. 回归：六断言 + 面板接线 + aurora 主题 + 多 agent 冒烟
   - ⚠️ 关注 `dsh --dump-config` 输出（3e 归一化须全部 dump-config 后）
   - ⚠️ 关注 `dsh-tool-pwsh-persistent` 改名点
5. 收尾：重打 DMG + Slim，跑守门判据

### 8.2 方案 B（激进，大工程）：fork 源码树整树同步到 rc.8 + 重放自研 patch
- `47f9438`→rc.8 跨 647 commits 且主线分歧 → **git rebase 不可行** → 用 `git reset --hard` 到 rc.8 或
  `git fetch --depth` 新鲜 checkout，然后 cherry-pick 我们 10 个本地 commit + 重挂 untracked 补丁。
- 适用于：想长期跟随上游 master / 想采用 upstream `ctx.agentTeams`。
- 需先评估我们 10 个 commit 对上游重命名轨迹的适配度（尤其 `feat/npm-public` merge 前的破坏性改动）。

### 8.3 验证清单（两方案共用）
- [ ] 盒内 `@deepseek-ai/dsh` 版本 == `0.1.0-rc.8`
- [ ] 面板 `id: whalepod-ui` 正常挂载（真机主窗口冒烟）
- [ ] aurora 主题不崩启动
- [ ] 多 agent 面板 roster/任务板数据链路正常（honeycomb transport）
- [ ] `dsh --dump-config` + 3e 归一化结果正确
- [ ] 无 `ctx.teams`/`dsh-tool-bash-persistent` 残留引用
- [ ] 六断言 exit=0 ×3 + 守门判据

### 8.4 回退预案
- box 层：`DSH_VERSION` 回 `0.1.0-rc.6` 重打盒即回退（面板 tarball 版本一并回档 rc.6）。
- 源码层：fork 当前 10-commit 层完整保留在 `master`（HEAD `9d9e910`），升级在分支/工作副本做，
  `master` 不动 → 一键 checkout 回退。
- 无需动 `whalepod` 数据 / profiles（dsh box 升级与数据层解耦）。

### 8.5 建议下一步（本卡之外的落地卡）
- 若选方案 A：开一张"box 升级 rc.8"实施卡（低风险，1-2 步）。
- 若选方案 B 或采用 upstream agent-team：开一张"评估采用 ctx.agentTeams 替代自建面板"的设计卡。

## 9. 真实 commit/tag hash 核验清单（gh api 实测）

| 对象 | 短 hash | 完整 hash |
|---|---|---|
| 上游 rc.8 tag | `141eb6fe` | `141eb6fef83422698aef7a981029e843e8161534` |
| 上游 rc.7 tag | `99f6f02f` | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` |
| 目录改名 commit | `cb93304e` | `cb93304ec916c05023b01039171e53d116dc923b` |
| service key 改名 commit | `4dd1be1a` | `4dd1be1a1fbb5e77ee627a90957d95cfab8aa0af` |
| 包名加前缀 commit | `0e51d5ff` | `0e51d5ffae532f6f6f31f1a7c883a0a51a12a56d` |
| **我们 fork 基线**（upstream `feat/npm-public` merge） | `47f9438` | `47f943859bef60e4160492346772ded9b24f765a` |
| **我们 fork HEAD**（基线 + 10 本地 commit） | `9d9e910` | `9d9e91002d90cfd8ef6aaffc16a3d40c0d813e94` |

*以上 hash 均经 `git rev-parse`（本地 fork）或 `gh api`（上游）实测取真值。*

---
*铁律：先落盘骨架再深挖；每阶段产出写文件；报真实 commit hash。*
