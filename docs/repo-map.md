# deepseek-harness 仓库结构图与构建/运行说明

> 本文档由【工程-Flash-1】在环境搭建任务中产出，服务于本项目 **鲸群 WhalePod**（多智能体编排核心包暂定 `@whalepod/honeycomb`，NPM 名 `dsh-honeycomb`）的选型与二次开发参考。
> 文档描述的是**本地实测**状态（2026-08-14 克隆验证）。

---

## 0. 仓库元信息

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/deepseek-ai/deepseek-harness |
| 分支 | `master` |
| 克隆 commit | `47f943859bef60e4160492346772ded9b24f765a`（Merge PR #2519 feat/npm-public） |
| 版本 | `0.1.0-rc.5` |
| 包管理器 | `pnpm@11.7.0`（package.json `packageManager` 字段锁定，需 Corepack） |
| Node engines | `^22.19.0 \|\| >=24.0.0` |
| lockfile | `pnpm-lock.yaml`（lockfileVersion 9.0） |
| 本地实测环境 | macOS aarch64，node v22.17.0，corepack 解析出 pnpm 11.7.0（安装依赖 OK；engines 略低于要求，仅警告，未阻断） |
| 运行入口 | `pnpm dsh web`（=`dsh --profile web`），默认端口 **3080** |

---

## 1. 仓库结构图

```text
deepseek-harness/                          # pnpm monorepo root
├── apps/                                  # 可交付应用
│   ├── cli/                               # @deepseek-ai/dsh — CLI 入口（bin: dsh）
│   │   └── src/                           #   bin.ts（mode 分发）、args.ts（参数解析）、profile-boot.ts
│   └── web/                               # @deepseek-ai/dsh-web-frontend — Web UI 前端（Vite + React）
├── packages/                              # 工作区包（约 48 个真实包组，见 §2 分组表）
│   ├── core/                              # ★ 核心运行时
│   │   ├── agent/  agent-loop/            #   Agent 接口/注册表 + 默认驱动循环
│   │   ├── agent-default-model/           #   默认模型选择策略
│   │   ├── agent-tool-presentation/       #   工具呈现层
│   │   ├── scope/  session/  tools/       #   作用域原语 / 会话日志 / 工具注册与执行管线
│   │   └── system-prompt/                 #   Prompt 分节与工具 schema 装配
│   ├── boot/                              # 启动引导（dsh-app-boot、cmdline、分层 env 加载）
│   ├── bundle/                            # Profile bundle（Cordis 装配层）
│   │   ├── base/                          #   基础 bundle
│   │   ├── headless/                      #   无头 bundle
│   │   └── web-app/                       #   ★ web profile（cordis.patch.yml，端口 3080）
│   ├── client/                            # 浏览器侧 client 面（connection、ui-primitives、ui-workspace）
│   ├── host/                              # 主机侧 host 面（node 侧能力）
│   ├── llm/                               # LLM 适配 seam（消息/流词汇 + 适配器接口，ctx.llm）
│   ├── tools/  fs/  subprocess/  shell/   # 能力 seam：工具、文件系统、子进程、shell
│   ├── subagent/  workflow/  goal/  plan/ # 智能体编排：子智能体、工作流、目标、计划
│   ├── skill/  todo/  schedule/  jobs/    # 技能、待办、调度、后台任务
│   ├── session/  session-query/           # 会话持久化与查询
│   ├── sandbox/  code-runtime/  e2b/      # 沙箱/代码执行（本地 + e2b 远程）
│   ├── mcp/                               # MCP 集成
│   ├── api/  acp/  sdk/                   # 对外 API、Agent Client Protocol、SDK
│   ├── credentials/  identity/  settings/ # 凭据、身份、配置
│   ├── storage/  context/  compaction/    # 存储、上下文管理、压缩
│   ├── guard/  approval/  feedback/       # 安全护栏、审批、反馈
│   ├── lsp/  terminal/  attachment/       # 语言服务器、终端、附件
│   ├── util/  typert/  runtime-diagnostics/  # 工具库、类型运行时、诊断
│   └── web/                               # 网页工具类（tool-web、web、web-search-*）
├── native/                                # 原生模块
├── scripts/                               # 开发脚本（dev-web.ts — `pnpm dev:web` 热更入口）
├── docs/                                  # ★ 架构文档（architecture.md、subsystems/*、事件图谱等）
├── vendor/                                # 第三方 vendor 代码
├── package.json                           # workspace root（scripts: build / build:lib / build:web / dev:web）
├── pnpm-workspace.yaml                    # workspace globs
├── pnpm-lock.yaml
└── tsconfig.host.json / tsconfig.client.json   # 双面 TS 工程（host 面 = node 侧，client 面 = 浏览器侧）
```

---

## 2. 关键目录/包分组说明

| 分组 | 包（packages/ 下） | 职责 |
|---|---|---|
| **核心运行时** | `core/*` | Agent 接口与默认驱动（agent-loop）、会话事件日志（session，append-only `SessionEvent`）、工具注册/执行管线（tools）、Prompt 装配（system-prompt）、作用域原语（scope） |
| **双面架构** | `host` / `client` | 同一代码库编译为 **host 面**（Node 侧）与 **client 面**（浏览器侧）；`build:lib` 用 tsconfig.host/client 两套配置分别 tsc+tsdown 出产物 |
| **LLM** | `llm` | 消息/流词汇表 + 适配器 seam（`ctx.llm`），厂商适配在此插拔 |
| **能力 seam** | `tools` `fs` `subprocess` `shell` `terminal` `lsp` | 可替换能力：Service Definition / Provider / Consumer 三角；换 provider 即整体换能力（如指向远程沙箱） |
| **编排** | `subagent` `workflow` `goal` `plan` `skill` `todo` `schedule` `jobs` | 子智能体、工作流、目标/计划、技能、待办、定时调度、后台任务 —— **与本项目 @whalepod/honeycomb 最相关** |
| **Profile 装配** | `bundle/*` | Cordis 补丁层：`base` / `headless` / `web-app`；`dsh --profile web` 即装载 `web-app` bundle（端口 3080 定义于其 `cordis.patch.yml`） |
| **前端** | `apps/web`（dsh-web-frontend） | Vite + React UI，`build:web` 产物由 web profile 静态托管 |
| **集成** | `mcp` `api` `acp` `sdk` | MCP 服务、HTTP API、Agent Client Protocol、SDK |
| **运行环境** | `sandbox` `code-runtime` `e2b` | 本地沙箱 + e2b 远程代码执行 |
| **支撑** | `boot` `credentials` `identity` `settings` `storage` `context` `compaction` `guard` `approval` `feedback` `util` `typert` | 启动引导、凭据、身份、配置、存储、上下文管理/压缩、安全护栏/审批、反馈、通用工具 |

---

## 3. 构建 / 运行说明（本地实测流程）

### 3.1 前置要求

```bash
node >= 22.19   # 推荐 22.19+ 或 24.x（engines 声明）；实测 v22.17.0 可跑通
corepack enable # 让 pnpm 版本跟随 package.json 的 packageManager 字段（=11.7.0）
```

### 3.2 克隆 + 安装依赖

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
corepack pnpm install
# 实测：monorepo 大，约 8~9 分钟；若跳过 corepack 用本机低版 pnpm 可能因 lockfile/版本差异报警
```

> 安装末尾出现 `Couldn't find package "x" needed by ... node_modules/x/bin.js` 之类的 WARN 属正常 —— 本地 workspace 包尚未构建出 lib 产物，`pnpm run build` 后即消失。
>
> ⚠️ **实测补丁（必读）**：`pnpm run build` 在 tsdown（host 面）阶段会因 `Failed to import module "unrun"` 失败——`unrun` 是 tsdown 的 optional peerDependency，pnpm 默认不装，但本仓库的 tsdown 配置会实际 import 它。需补装（已实测通过）：
> ```bash
> corepack pnpm add -Dw unrun@0.3.1
> ```
> 这会向根 package.json 写入一条 devDependency（本地环境修复，非上游改动）。

### 3.3 构建

```bash
corepack pnpm run build
# 等价于：
#   pnpm build:lib   -> tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host
#                       + tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client
#   pnpm build:web   -> pnpm --filter dsh-web-frontend build  (Vite 构建前端)
```

- `build:lib` 是全仓最大耗时步骤（TypeScript 工程编译），在本次实测机器上 **超过 10 分钟**，建议用 `nohup ... > build.log 2>&1 &` 后台执行并轮询日志。
- `dsh web` 依赖**两个构建产物都就位**：lib（host/client 面）供 CLI 运行时 import，前端 dist 供 web profile 静态托管。

### 3.4 运行 Web UI

```bash
corepack pnpm dsh web          # 即 dsh --profile web；默认监听 3080
```

可选参数：

```bash
pnpm dsh web --help            # web app 自身参数
pnpm dsh web --port 3080       # 显式指定端口（webStartup.port，缺省即 3080）
pnpm dsh web --patch ./x.yml   # 叠加自定义配置层
pnpm dsh web --dump-config     # 打印最终装配树后退出
```

### 3.5 验证

```bash
curl -sI http://localhost:3080        # 期望 HTTP 200
# 浏览器打开 http://localhost:3080 即可看到 Web UI
```

### 3.6 常用命令速查

| 命令 | 作用 |
|---|---|
| `corepack pnpm install` | 安装依赖（pnpm 11.7.0） |
| `corepack pnpm run build` | 全量构建（lib + web 前端） |
| `corepack pnpm build:lib` | 仅构建 host/client 面库 |
| `corepack pnpm build:web` | 仅构建前端 |
| `corepack pnpm dsh web` | 启动 Web UI（:3080） |
| `corepack pnpm dev:web` | 开发热更模式（tsx scripts/dev-web.ts --poll） |
| `corepack pnpm test` | 运行测试（仓库内置大量 host/client 双面 spec） |

---

## 4. 与本项目（鲸群 WhalePod / @whalepod/honeycomb）的关联

1. **架构范式可直接借鉴**：host/client 双面编译、Cordis 插件式装配（bundle = patch 层叠）、"seam = Service Definition + Provider + Consumer" 的可替换能力设计、append-only 会话事件日志作为模型上下文唯一来源 —— 这些与 鲸群 WhalePod 多智能体编排的诉求高度吻合。
2. **编排相关包是重点研究对象**：`subagent`（子智能体 seam，可换成"另一个产品内的委托 turn"）、`workflow`、`goal`、`plan`、`skill`、`agent-loop`（turn/step 循环、waterfall 事件）是 honeycomb 包设计时最直接的参考实现。
3. **NPM 名规划**：官方包为 `@deepseek-ai/dsh-*` 命名空间；我们的核心包定为 `@whalepod/honeycomb`（NPM 名 `dsh-honeycomb`）时，注意与官方 `dsh` CLI 命名区分，避免抢占/混淆官方保留名。
4. **运行依赖注意**：本仓库对 Node/pnpm 版本敏感（engines `^22.19.0`、packageManager 锁定 11.7.0），后续 CI/本地统一用 Corepack 锁定版本，避免环境漂移。

---

## 附：本次实测执行记录（2026-08-14）

| 步骤 | 结果 |
|---|---|
| `git clone`（master @ 47f9438） | ✅ |
| `corepack pnpm install`（pnpm 11.7.0） | ✅ 8m44s |
| `corepack pnpm run build`（tsc host + tsdown + client + vite） | ✅ 首轮 10min 超时被中断 → nohup 后台重跑成功；中途修复 tsdown 缺 `unrun`（`pnpm add -Dw unrun@0.3.1`） |
| `corepack pnpm dsh web`（:3080） | ⚠️ 3080 已被 **npx 安装的 dsh** 实例占用（PID 19383，`~/.npm/_npx/.../dsh web`，启动 19:04:59，HTTP 200 且带活跃浏览器连接，非本仓库构建）。本仓库构建改用 `--port 3081` 验证：✅ HTTP 200 |
| 文档产出 | ✅ `/Users/qzp/aion2dsh/docs/repo-map.md` |

> **待组长决策**：是否停掉 3080 上的 npx dsh 实例（PID 19383），改用本仓库本地构建接管标准端口 3080（`pnpm dsh web`）。当前本地构建实例在 3081 保持运行中。
