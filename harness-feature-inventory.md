# DeepSeek Harness 完整功能对齐清单

> **用途**：作为桌面工作站（Mac 应用）"功能一模一样 + 可扩展"的验收基准。
> **数据来源**：deepseek-harness 文档站点（https://deepseek-harness.github.io/deepseek-harness/）全部 81 个中文页面，已抓取到 `harness-docs/` 目录。
> **源码仓库**：`github.com/deepseek-ai/deepseek-harness`（master 分支，`docs/**/*.zh.md`）。
> **框架**：Cordis（`@deepseek-ai/cordis`，vendor 引入的插件框架），纯 TypeScript。

---

## 0. 总体架构（决定"可扩展"的根）

- **一切皆插件，无特权内核**：没有"核心内核"持有特权。模型适配器、工具注册表、会话日志、agent loop 本身都是插件。
- **四层组合**：`Foundation` → `Capability` → `Domain` → `Composition`（靠后层依赖靠前层，组合层只做装配）。
- **Profile / Bundle**：`dsh` 启动即一棵由多层拼成的插件树。Profile = Harness home 里的具名装配；Bundle = Cordis 配置 + 挂载代码的分发格式。
- **核心包**：`session`、`system-prompt`、`tools`、`agent`、`agent-loop`、`scope`、`llm`。
- **事件三大域**：
  - *会话事件（session events）*：仅追加的持久事实（`SessionEvent`）。
  - *agent 事件（agent events）*：实时控制（`agent/*`）。
  - *能力事件（capability events）*：各 seam 的扩展钩子（`tools/*`、`approval/*`、`fs/*`…）。
- **能力 seam 模式（可扩展性的机制核心）**：绝大多数能力都拆成"三分法"——
  - *Service Definition*（抽象服务契约，如 `ctx.fs`）
  - *Service Provider*（可互换实现，如 `dsh-fs-local`）
  - *Consumer*（面向模型/用户的使用方，如 `dsh-tool-fs`）
  - 同一上下文通常只允许一个 Provider；少数（subagent、llm adapter、web）用**命名注册表**允许多个并存。

### 事件 dispatch 模式（Cordis）
| 模式 | 语义 |
|---|---|
| `emit` | 通知后不管，观察者失败被隔离 |
| `waterfall` | 链式改写/短路决策（`next()` 委派默认），如 `tools/pre-execute` 的 allow/deny/ask |
| `parallel` | 全部执行、全部 await，如 `session/flush` |
| scope-filtered | 经 `@deepseek-ai/dsh-scope` 按 agent 作用域过滤分发 |

---

## 1. 功能清单总表（全部子系统）

> 按文档"子系统"目录归类。"seam"= 可替换能力（三分法）；"registry"= 可多实现注册；"可选"= 不在 agent loop 主干上。

### 内核与作用域
| 子系统 | ctx 服务 | 角色 | 扩展方式 |
|---|---|---|---|
| core（核心） | `ctx.agents`（AgentRegistry）等 | agent 生命周期/会话/工具等的共享类型与主干 | 插件通过服务扩展 |
| scope（作用域注册） | （库原语，非服务） | 身份/载体/作用域层词汇，同一注册上下文按 agent 分可见性与共享生命周期 | 作用域路由 |
| invariants（运行时不变式） | `ctx.invariants` | 可配置的包自有不变式检查注册表 | 每个包 `./invariant` 配套插件注册 |

### 会话与持久化
| 子系统 | ctx 服务 | 角色 | 扩展方式 |
|---|---|---|---|
| session（会话） | `ctx.sessions`（SessionStore） | 内存事件溯源日志，唯一真源；派生 LLM 历史 | 插件可 declaration-merge 新事件类型 |
| persistence（会话持久化） | `ctx.sessionPersistence` | 抽象持久化 seam，flush 检查点、崩溃恢复 | JSONL / SQLite 两个可换后端 |
| session-query（会话查询） | `ctx.sessionQuery` | 逻辑会话语料库查询（全文索引、关系、语义提取） | SQLite 提供方 |
| session-reference（会话引用） | `ctx.sessionReferenceResolver` | 跨会话结构化引用（规范 URI、安全 JSON） | 宿主适配器消费 |
| session-title（会话标题） | `ctx.sessionTitle` | 持久、后写覆盖的标题 + 异步 LLM 提供方 | 提供方可换 |
| session-projection（会话投影） | `ctx.sessionProjections` / `ctx.sessionProjectionCache` | 领域 host 插件向客户端推送按会话的派生状态 | 每个领域注册一个纯单元 |
| spill（spill 存储） | `ctx.spillStore` | 超大工具输出落盘，返回定位符给模型 | local provider |
| session-telemetry（遥测） | `ctx.sessionTelemetry` | 会话上报（捕获点、脱敏 waterfall、OTel 后端） | OTel 提供方 |

### 模型与上下文
| 子系统 | ctx 服务 | 角色 | 扩展方式 |
|---|---|---|---|
| llm-streaming（LLM 流式） | `ctx.llm`（LlmRuntime） | 对话/流式类型、Message/ContentBlock、适配器契约、assembler | LLM 适配器注册表 |
| token-meter（Token 计量） | `ctx.tokenMeter` | 回放快照：请求压力 + 按位置定价 | — |
| system-prompt（系统提示词组装） | `ctx.systemPrompt` | 提示词贡献者管理与单次组装 | 插件注册贡献者，可排序/作用域 |
| compaction（上下文压缩） | `ctx.compaction` / `ctx.toolResultPruner` | 压缩 seam，把长历史 summarize 成 replace 节点 | 可换后端（basic） |

### 执行与工具
| 子系统 | ctx 服务 | 角色 | 扩展方式 |
|---|---|---|---|
| tools（工具） | `ctx.tools`（ToolRuntime） | 工具注册表 + 可扩展执行流水线 | 注册/作用域限制/守卫，全 pipeline 可 hook |
| shell（Bash 执行器） | `ctx.shell` / `ctx.shellEnv` | bash 执行 seam（无任务概念进程句柄） | local / sandbox 后端 |
| subprocess（子进程） | `ctx.subprocess` / `ctx.e2b` | 受管子进程 seam（收集/管道/ptty/ndjson） | local / e2b |
| terminal（持久 PTY 会话） | `ctx.terminals` | PTY 后端 + 面向模型的消费方 | 后端可换 |
| jobs（后台任务运行时） | `ctx.jobs` | 长任务生产方 + 任务控制命令 | — |
| filesystem（文件系统） | `ctx.fs` | 带可选守卫的原子文本操作（read/write/edit） | local 后端 + 观察策略 |
| lsp（LSP 导航） | `ctx.lsp` | 语义代码导航 seam | stdio provider 注册表 |
| code-runtime（代码运行时） | `ctx.codeRuntime` | 运行模型编写的程序，报告打印与返回值 | worker-thread 等后端 |
| web（Web 访问） | `ctx.web` | search + fetch 两项操作 | 多 provider 注册表（Exa/Perplexity/…） |
| skills（Skills） | `ctx.skills` | 技能目录合并与发现（本地/随包） | 多提供方注册 |
| workflow（工作流） | `ctx.workflowEngine` | 运行模型编写、可启动 subagent 的编排脚本 | 单引擎（worker-thread） |
| subagent（Subagent） | `ctx.subagents` | agent 委派子 agent（命名注册表，可多实现） | 按名注册（含 ACP/进程外后端） |

### 策略与交互
| 子系统 | ctx 服务 | 角色 | 扩展方式 |
|---|---|---|---|
| approval（用户审批） | `ctx.approval` | 共享请求/结果词汇 + `approval/request` 应答者 waterfall + ask/never 策略 + 审计 | UI/ACP 提供应答者 |
| permission-presets（权限预设） | `ctx.permissionPresets` | 把 sandbox/mode + approval/policy 绑成具名预设 | — |
| sandbox（进程沙箱） | `ctx.sandbox` / `ctx.sandboxPolicy` | 文件效果策略包裹子进程 | bwrap/Landlock/macOS Seatbelt/Win ACL 后端 |
| plan（计划模式） | `ctx.planMode` | 逐 agent 软性指引状态（`exit_plan_mode` 工具 + `/plan` 命令） | — |
| user-questions（用户交互） | `ctx.userQuestions` | 工具/权限插件需要人类回答时用的中立词汇 | UI 提供 Provider |
| commands（用户命令） | `ctx.commands` | 插件拥有的命令注册表（`/xxx`，直接执行不建模型消息） | 插件注册 |
| goal（同会话目标） | `ctx.goals` | 事件溯源的目标服务（持续目标/轮次） | — |
| schedule（Session 内 Schedule） | — | 持久提醒，以普通后续轮次返回原 live Session | — |

### 平台与接入
| 子系统 | ctx 服务 | 角色 | 扩展方式 |
|---|---|---|---|
| web-server（HTTP 服务器） | `ctx.webServer` | 浏览器 HTTP 载体：具名路由、index 转换、回退处理器 | 插件注册路由 |
| client-modules（Client 模块） | `ctx.clientModules` | Web 插件表：扫描 `dsh.client` 包 → 组合 `window.__DSH_BOOT__` → bundle 路由 | 包声明 `dsh.client` |
| typert（远程调用） | `ctx.apiProxy` / `ctx.typert` / `ctx.typertGateway` | 生成 Remote 产物 / Host Gateway / 消费方 API | — |
| storage（存储） | `ctx.storage` / `ctx.storageDomain` | 会话日志之外的一切持久数据（领域数据） | json 等 provider + 领域注册 |
| workspace（工作区） | `ctx.workspaceRegistry` / `ctx.directoryPicker` | 工作目录持久记录（稳定 id/标题/会话账本），对模型不可见 | — |
| settings（用户设置） | `ctx.settings` | 按 namespace 的用户文档（schema 默认 + base + 用户分节） | 插件注册 namespace schema |
| credentials（用户凭据） | `ctx.credentials` | 把机密挡在配置外（存引用，值归 provider，每次请求解析） | local provider |

---

## 2. 分类详解（验收要点）

### 2.1 Agent 对话（会话与消息）
- **事件溯源模型**：`Session` 是一份仅追加的类型化 `SessionEvent` 日志，是交互历史的**唯一真源**；LLM 消息历史从日志*派生*（`deriveMessages()`），从不单独存储；回放 = 从同一组事件重新派生。
- **核心事件词汇**（`SessionEventMap`，可声明合并扩展）：
  - 边界：`turn/start`、`turn/end`（含 `TurnEndReason`：completed/aborted/blocked/error/max-tokens/interrupted）、`step/start`、`step/end`、`session/end-seed`
  - 消息：`user/message`（直接提示 / 注入上下文 / steering，靠 `source` 区分）、`assistant/chunk`（token 级原始分片）、`assistant/message`（组装消息 + usage）
  - 工具：`tool/call`（模型原始 arguments 字符串，未解析）、`tool/result`
  - 其他：`todo/write`（全量待办快照）、`request/header`（请求信封快照）、`request/context`（路由元数据）
- **Surface 机制**：三种产生消息的事件（`user/message`/`assistant/message`/`tool/result`）带 `surfaceOp`（`append` / `replace`），决定它如何进入有序 surface；compaction 用 `replace` 遮蔽被概括的范围。
- **派生规则**：`user/message`→user 消息；`assistant/message`→assistant 消息（空内容跳过，但保留 usage）；`tool/result`→`tool-result` 块的 user 消息；其余结构事件不投影。
- **验收**：桌面端必须能无损重建同一份事件日志、按同一规则派生历史、支持 token 级回放与 surface 重写。

### 2.2 工具系统（tools）
- **ToolDefinition**：`schema`（面向模型）+ 强制的 `output` 声明 + `execute` + 可选 `finalizeContent`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult`。执行/展示回调绝不泄漏进模型请求（`schemas()` 只白名单 name/description/parameters）。
- **统一 JSON Schema DSL**：`string/number/integer/boolean/null/array/object/json/oneOf`，`enum`/`const` 须匹配节点类型，显式对象声明 `additionalProperties`。`defineTool()` 自动校验 + 收窄参数类型 + 推导返回类型。
- **执行流水线（可扩展 waterfall + 单调策略）**：
  `tools/pre-execute`（allow/deny/ask waterfall）→ 单调 guard → `tools/execute`（环绕分派包装）→ `tools/post-execute`（检查/替换）→ `finalizeContent` → `tools/result`（冻结的权威结果）。
  - `PreToolDecision`：allow / deny / ask；只有 `allowed-once` 才继续。
  - `PostToolDecision`：accept / replace / block（转纠正反馈为 error）。
- **执行模式**：`parallel`（可与兄弟并行）/ `exclusive`（独占屏障）。Code Mode 桥接把子分派暴露给 `tools/code-dispatch-log`。
- **UI 展示词汇（提供方无关）**：`presentCall`/`presentResult` 返回 `card` 标签渲染意图 —— generic / terminal / diff / search / read / web；`ToolCallKind` 选图标；`FileLocation`/`FileDiff`/`ReadFileLine` 共享文件卡片。
- **ToolRestriction**：按作用域 allow/deny 继承工具的实时过滤。
- **验收**：桌面端必须复刻整条流水线（含 ask→审批、guard、并行/独占调度、卡片渲染、错误归一到 `UNKNOWN_TOOL`/`INVALID_ARGS`/`INVALID_TOOL_OUTPUT`）。

### 2.3 审批（approval）与权限
- **语义**：回答"这个具体操作是否可以继续"。共享请求/结果词汇、`ctx.approval` 分发服务、`approval/request` 应答者 waterfall、`approval/asked`+`approval/decided` 审计事件对、按会话 `ask`/`never` 策略。
- **结果（闭合）**：`allowed-once`（唯一授权，仅授权所询问的那一个操作）/ `rejected` / `cancelled` / `unavailable`（fail-closed）。
- **按会话策略**：`ask`（默认，委托应答者链，无应答者→unavailable）/ `never`（确定性拒绝，CI/无人值守）。生效值 = 会话日志最后一条 `approval/policy`，回退服务配置；`setApprovalPolicy` 是唯一写路径。
- **审计仅写日志**，不进模型 transcript。
- **permission-presets**：把 `sandbox/mode` + `approval/policy` 两个独立 knob 绑成具名预设，作为客户端单一"权限"选择器；只记录意图，不拥有强制执行。
- **验收**：桌面端要提供人类应答者 UI（对应 UI answerer），并支持 ACP 一次性机器决策、ask/never 切换、审计事件对。

### 2.4 Providers（模型提供商）与凭据
- **LLM 适配器契约**：每个 provider 实现同一 adapter contract（请求组装、流式 `StreamChunk`、usage 记账）；命名注册表支持多 provider 并存。
- **路由**：注册 provider 路由（provider + model），含可选的 `contextWindow` 容量，记录在 `request/context`。
- **目录提供方**：DeepSeek（官方）、Anthropic、OpenAI、Bedrock（AWS 凭据+区域）、Vertex（ADC 项目）、Azure（`api-version`）、Codex（OAuth）等；已安装目录提供端点/协议/模型列表。
- **自定义提供方**：Provider ID（**永久**，请求/会话/默认值/凭据引用都依赖它）、显示名、基础 URL、API 协议、凭据、模型；支持"获取可用模型"查询。
- **多模态输入**：`settings.yaml` 中按模型声明 `input: [text, image]`（或路由级 `defaultInput`），否则手动录入模型一律按纯文本、发图前拒绝。
- **凭据（credentials）**：机密不进配置——settings 只存*引用*，密钥只写、存 `$DSH_HOME/.credentials.yaml`（UI 永远只收到脱敏描述符），**每次模型请求解析一次**。
- **热生效**：模型变更在**下一次请求**生效，无需重启服务器。
- **验收**：桌面端要能配置目录/自定义 provider、模型路由、多模态输入声明、按请求解析凭据、模型热切换。

### 2.5 Python SDK
- `deepseek-harness-sdk`（pip 包），Python 3.10+，支持 **Linux x64/arm64、macOS 14+ arm64**（与桌面工作站目标一致）。
- SDK 自带同版本 Node 运行时（**无需系统 Node**），通过 JSON-RPC agent 调用与 Web UI 同一套 API。
- 核心 API：`DeepSeekHarness(provider=, model=, max_tokens=, cwd=, session_root=, cordis=)` + `harness.run(prompt, session_id=)` → `result.final_response`；会话目录产出 JSONL 日志（含组装后的模型请求 + 工具调用）。
- **验收**：桌面端需保留 Python SDK 的接入路径（程序化客户端，而非主语言），对齐 `DeepSeekHarness` 的构造参数与 `run()` 返回契约。

### 2.6 持久化（persistence）
- **抽象 seam**：`ctx.sessionPersistence`（locate/create/append/prepare/load/inspect/readFrom/list/listSnapshots），无平行持久化事件类型。
- **两个可换后端**：
  - `jsonl`：每会话一份仅追加逻辑 JSONL（默认带 checksum 的连续 Zstandard frame，可配原始行），崩溃安全原子写入、被中断轮次恢复。
  - `sqlite`：基于 `node:sqlite`，每 `SessionEvent` 一行（`session_id, seq, type, time, data, source_event_seqs, surface_op`），1:1 映射。
- **flush 检查点**：`session/event` 是同步通知；持久化插件异步缓冲，固定批处理窗口；`session/flush` 排空至停稳。
- **崩溃恢复**：重载发现未闭合 `turn/start` 时，用合成 `turn/end { reason: interrupted }` 关闭遗留轮次（不截断日志）。
- **SessionHeader**（日志旁元数据）：`version/id/createdAt/cwd/parentSession/seedLength/origin/delegationDepth/agentPreset`。
- **格式拒绝**：未知版本报升级方向（不是"损坏"）；不认识的必需事件类型被拒绝，除非 `ignorable: true`。
- **验收**：桌面端必须支持"无损日志 + 崩溃恢复 + 可换后端 + 版本拒绝"。

### 2.7 配置与设置
- **插件配置目录（config-catalog）**：每个 `config:` 块可由 `cordis.yml` 条目设置；由源码生成 + 与运行时 schema 交叉核对。
- **用户设置（settings）**：按 namespace 分节，解析为 schema 默认值 → 注册方 `base` → 用户分节；provider（`settings-file`）存原始文档并推送外部编辑。
- **验收**：桌面端要提供 `cordis.yml` 组合配置 + 用户可编辑设置（settings UI），且配置可热生效。

### 2.8 生命周期（Agent / turn / step / 恢复 / fork）
- **Agent 生命周期**：`spawn` / `resume`（`ctx.agents.resume({ resumeSessionId })`）/ `stop`；agent 事件实时控制。
- **Turn/Step 流**：turn（一次模型循环执行）内含多个 step（一次模型调用 + 它请求的工具执行）。
- **恢复与 fork**：`ctx.sessions.create(id, { seed })` 回放/fork；`SessionStore.fork(source, boundary)` 从稳定轮次间位置 fork 子会话（拒绝开放轮次内）。
- **goal / schedule**：同会话目标 + 持久提醒（以普通后续轮次返回）。
- **验收**：桌面端要能 spawn/resume/stop agent、恢复/分支会话、处理 goal 与 schedule。

### 2.9 执行与工具能力
- **filesystem**：`ctx.fs` 原子文本操作 + 可选守卫；`dsh-tool-fs` 提供 read/write/edit 工具 + 窗口渲染 + 观察策略。
- **shell / subprocess / terminal / jobs**：bash 执行、受管子进程（收集/管道/ptty/ndjson/继承 stderr）、持久 PTY 会话、后台长任务（job id/所有权/控制）。
- **lsp / code-runtime**：语义代码导航（stdio 语言服务器）、运行模型编写的程序（打印 + 返回值）。
- **web / skills**：search+fetch、技能目录合并与发现。
- **workflow / subagent**：模型编写的编排脚本（可启动 subagent）、agent 委派子 agent（命名注册表）。
- **sandbox**：Linux bwrap/Landlock、macOS Seatbelt、Windows ACL；文件效果策略。
- **验收**：这些是桌面工作站"基本功能"的主体，MVP 至少覆盖 filesystem + shell + terminal + jobs + web + subagent。

### 2.10 平台与接入
- **web-server**：`node:http` 载体，具名路由 + index 转换 + 回退处理器；`/api` 桥接、插件 bundle、HMR 事件流由其他插件注册。
- **client-modules**：Web 插件表（`dsh.client` 声明 → `window.__DSH_BOOT__` 图 → `/plugins/<id>/client.js` bundle → index 注入启动 manifest）。
- **typert**：Remote 调用 / Host Gateway / 消费方 API assembly。
- **workspace / storage / credentials**：工作区记录、领域数据存储、凭据。
- **验收**：桌面端的"Web UI 载体"可复用这套 HTTP + client-modules 机制；插件 UI 扩展走 `dsh.client`。

### 2.11 可观测与诊断
- **invariants**：包自有运行时不变式检查注册表。
- **session-telemetry**：OTel 上报 + 脱敏 waterfall。
- **session-projection / query / reference / title / token-meter**：派生状态推送、会话检索、跨会话引用、标题、Token 计量。

---

## 3. 可扩展性验收要点（"可无限组合插件"的关键）

1. **插件 = 导出 `apply(ctx)` 的 TS 模块**；通过 `cordis.yml` 组合；支持**热重载（HMR）**与副作用清理（dispose 可逆）。
2. **能力 seam 三分法**：Service Definition（抽象）+ Provider（可换实现）+ Consumer（使用方）——桌面端必须原样保留这一替换机制，不得把任何 Provider 写死。
3. **命名注册表**：llm adapter、subagent、web、lsp 等支持多实现并存。
4. **事件扩展**：`tools/*`、`approval/*`、`fs/*` 等 waterfall 钩子 + `SessionEventMap` 声明合并。
5. **作用域（scope）**：同一注册上下文按 agent 分可见性与共享生命周期（`ctx.agent.ctx` 作用域注册）。
6. **Client 模块**：UI 层扩展经 `dsh.client` 声明 + bundle 路由，Node 半/浏览器半分离。
7. **配置扩展**：`cordis.yml` 条目 + settings namespace + credentials 引用，三者分离。

---

## 4. 分阶段落地映射（桌面工作站）

| 阶段 | 必须对齐的能力 | 说明 |
|---|---|---|
| **MVP（阶段 1）** | core + session + persistence + llm-streaming + tools + shell + filesystem + terminal + jobs + web + subagent + approval + settings + credentials + web-server + client-modules + system-prompt | "打开就能用"的最小闭环：对话 + 工具调用 + 文件/终端 + 审批 + 可持久化 + Web UI 载体 |
| **增强（阶段 2）** | subagent + workflow + goal + schedule + plan + sandbox + permission-presets + commands + user-questions + scope + skills + lsp + code-runtime + compaction + spill + token-meter | 多 agent 编排 + 策略/交互 + 上下文管理 |
| **完整对齐（阶段 3）** | session-projection + session-query + session-reference + session-title + session-telemetry + invariants + storage + workspace + typert + config-catalog/tool-catalog/persistence-catalog 生成 + Python SDK 桥 | 检索/可观测/工作区/远程调用 + 文档目录生成 + 外部 SDK 桥 |

---

## 附：关键 ctx 服务速查（约 60 个）

`agents` · `sessions` · `sessionPersistence` · `tools` · `llm` · `systemPrompt` · `compaction`/`toolResultPruner` · `approval` · `permissionPresets` · `sandbox`/`sandboxPolicy` · `planMode` · `userQuestions` · `commands` · `goals` · `fs` · `shell`/`shellEnv` · `subprocess`/`e2b` · `terminals` · `jobs` · `lsp` · `codeRuntime` · `web` · `skills` · `workflowEngine` · `subagents` · `spillStore` · `sessionProjections`/`sessionProjectionCache` · `sessionQuery` · `sessionReferenceResolver` · `sessionTitle` · `sessionTelemetry` · `tokenMeter` · `invariants` · `storage`/`storageDomain` · `workspaceRegistry`/`directoryPicker` · `settings` · `credentials` · `webServer` · `clientModules` · `apiProxy`/`typert`/`typertGateway`
