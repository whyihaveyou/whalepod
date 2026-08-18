# AionUi 本地 Agent 自动发现机制调研报告

> 调研人：架构-Pro-1
> 日期：2026-08-17
> 任务：#01a00fb5（A1）——作为 WhalePod（@whalepod/honeycomb）本地 Agent 自动探测链的对标蓝本
> 方法：**本机 AionUi 真实现实证**（非推断）。证据来源：
> ① `/Applications/AionUi.app/Contents/Resources/bundled-aioncore/darwin-arm64/aioncore`（Rust Mach-O 二进制，86MB）；
> ② `aioncore config capabilities` / `config agents list` / `doctor` / `config agents custom try-connect` 实跑输出；
> ③ `aioncore` 二进制 strings（版本探测 / ACP 握手错误分类）；
> ④ `hub/`（AionHub 扩展仓库）中的 ACP adapter 扩展 manifest + install 脚本；
> ⑤ app.asar 内 `@aionui/web-host/src/agent-process-registry.ts` 与 `out/main` 主进程 bundle。
>
> 置信度：AionUi 侧结论均为真机/二进制实证 ✅ high；仅「设置页刷新 vs 启动时触发」的精确时序为中等（见 §7）。

---

## 0. 一句话结论

AionUi 的「本地 Agent 自动发现」由 **aioncore 后端二进制**承担：内置一个 **43 个 agent 的 Catalog**（`agent_source: builtin`，每个条目声明 `binary_name` 与 ACP 启动命令），发现方式 = **对每个 catalog 条目的 `binary_name` 做 `$PATH` 解析**，能解析出绝对路径即可用；**权威验证 = 真实 ACP `Initialize` 握手**（非仅 PATH 存在性）。用户可在 catalog 之上**自建 custom agent（显式 command 路径）**或**对内置 agent 设 override（command/env/secret）**。

---

## 1. 发现逻辑在哪个模块、什么时机触发（Q1）

### 1.1 模块：aioncore 后端（确认先前「aioncore？」假设）

- 探测逻辑**不在 Electron 主进程 bundle**（`out/main/index.js` 328KB–3.6MB，主要为 UI/窗口装配），而在独立后端二进制 `aioncore`（Rust，Mach-O arm64）——即 AionUi 的 config/model/agent 中枢。
- aioncore 暴露一个 `agents` 配置域，命令清单（`aioncore config capabilities` 实证）：
  ```
  agents list                      # 列出 agent catalog + 自建 agents
  agents enable / agents disable   # 开关单个 agent
  agents overrides get / set       # 单 agent 覆盖（command/env/secret）
  agents custom create / update / delete   # 用户自建 agent
  agents custom try-connect        # 验证用户自建 agent 的真实 ACP 连接
  ```
- `agent-process-registry.ts`（`@aionui/web-host/src/`）为前端侧的进程注册/生命周期观察层，但**判定「本机有哪些 agent 可用」的权威在 aioncore**；前端调 `config agents list` 拿结果。

### 1.2 时机（触发点）

- **`config agents list`**：应用打开「设置 / Agent（成员）管理页」或编队刷新 roster 时，aioncore 为每个 catalog 条目做 PATH 命中 + 状态（在线/离线/缺失）判定。这是主要触发路径。
- **`aioncore doctor`**：手动自检命令，「hydrate 注册表 + 探测 `$PATH` 上每个 CLI + 输出可用性表」。适合排障 / CI。
- **会话建立时 ACP 握手**：真正把某 agent 当作 teammate/对话对象时，走完整 ACP `Initialize` 握手（见 §4）。
- **`custom try-connect`**：用户新建自定义 agent 时的手动验证（30s 超时的 ACP 握手）。

> 时序推测（中置信）：`config agents list` 是「打开相关页面即按需触发」，非守护进程持续轮询。证据：实证的 kimi 条目 `last_check_kind: "manual"`（手动/按需触发，不是周期调度）。

---

## 2. 探测手段细节（Q2）

### 2.1 PATH 解析（主探测）

- 每个 catalog 条目声明 `binary_name`（如 `claude`、`codex`、`gemini`、`kimi`、`opencode`、`cursor-agent`、`vibe-acp`、`kiro-cli-chat`）。aioncore 对这个名字做 **`$PATH` 解析（`which`/可执行判定）**。
- `doctor` 实跑输出已给出**解析到的绝对路径**，证明是 which 级解析而非简单直配：
  ```
  available: /Users/qzp/.local/opt/node/bin/codex
  available: /Users/qzp/.local/bin/hermes
  available: /Users/qzp/.kimi-code/bin/kimi
  available: /Users/qzp/.local/opt/node/bin/opencode
  ```
  本机 PATH 可解析 5 个 CLI agent（codex/hermes/kimi/opencode + 一内部 agent）；其余 38 个 catalog 条目 `installed:false`。
- **未命中表现**：`installed:false`、`command:null`、`args:null`、`status:"missing"`，但仍留在 catalog（`enabled` 默认 true），供 UI 展示「已发现但未安装」+ 引导安装。
- **PATH 继承的坑（与 WhalePod Bug#2 完全同源）**：`doctor` 输出末端明确提示——应用不保证继承 shell 的 PATH，**必须从同一 shell 复现 / 排查 launchctl 环境注入**，否则 app 内探测结果与终端不同。这印证了我们 OOBE-M0 的 PATH 探测 Bug#2 教训。

### 2.2 版本探测（capability 门控，非仅 in-path）

aioncore strings 里有完整版本判定分类 + 真实 `--version` 探测：
- 分类：`VersionMissing / VersionMismatch / VersionNotPresent / VersionTooOld / VersionTooNew / CheckAgentVersion / AgentCheckVersion`。
- **claude 实证**：`claude --version probe did not succeed`、`claude --version output not recognised; omitting --thinking-display` → AionUi 会跑 `claude --version`，解析输出来判定是否支持 `--thinking-display` 等**特性降级**。
- 运行时也对 `node --version`、`python3 --version` 做探针（managed 运行时的 node/python 版本自举）。

### 2.3 配置文件存在性 / hub 扩展安装

- ACP adapter 通过 **AionHub 扩展（`hub/aionext-*.zip`）** 分发：manifest（`aion-extension.json`）声明 `cliCommand`、`connectionType: "stdio"`、`acpArgs`、`defaultCliPath`（如 `bunx opencode-ai` 兜底安装命令）；`lifecycle.onInstall` 负责把 CLI 装到全局。
- 因此「catalog 命中 + 已安装」是**两层**：PATH 命中二进制 且 可选地由 hub 扩展完成 CLI 安装保障。

### 2.4 用户自定义路径（Q2 直接答案：支持）

两种用户定制：
1. **custom agent**（`config agents custom create { name, command }`）：用户用一个显式 command 路径注册全新 agent。`config agents custom try-connect` 用**真实 ACP 握手**验证（见 §3 实跑）。
2. **per-agent override**（`config agents overrides set { agent_id, ... }`）：对内置 agent 覆盖 `command` / `env` / `secret`（模型字段 `has_command_override`、`env_override_key_count` 实证；capabilities 显示 override 支持 env 与 secret 覆盖）。

---

## 3. 被识别 Agent 的建模（Q3）

实证 `config agents list` 单条（本机已装的 ACP agent，Kimi 后端）完整字段：

```json
{
  "id": "e241c49c", "name": "Kimi Code", "backend": "kimi",
  "agent_type": "acp",
  "agent_source": "builtin",
  "agent_source_info": { "binary_name": "kimi" },
  "command": "kimi", "args": ["acp"],        // ACP 启动方式
  "agent_version": "...",                      // 版本
  "enabled": true, "installed": true,
  "status": "online",
  "last_check_status": "online",
  "last_check_kind": "manual",
  "last_check_latency_ms": 1294,              // ACP 握手健康检查往返
  "last_check_at": "...", "last_success_at": "...", "last_failure_at": null,
  "has_command_override": false,
  "env_override_key_count": 0,
  "behavior_policy": { "supports_side_question": true, "supports_team": true, ... },
  "config_options": { ... },                  // provider/models 等
  "available_modes": [ ... ],                 // ACP 握手所得
  "available_models": [ ... ],
  "available_commands": [ "compact","status","usage","mcp","tasks","help", ... ], // ACP 握手所得
  "native_skills_dirs": [ ... ],
  "sort_order": 0, "icon": "...",
  "team_capable": true
}
```

要点（Q3 答案）：
- **连接方式**：`agent_type: "acp"`（CLI adapter 均为 ACP，经 `command + args:["acp"]` 拉起）；strings 里还有其它母线：`Acp / OpenclawGateway / Nanobot / Remote / Aionrs / Antigravity / GeminiCodex` → 命名注册表按 `agent_type` 分派连接。
- **注册表**：aioncore 数据库（本机 `aionui-backend.db` 实证存储了 agent 目录）；`config agents list` 是读接口。
- **版本**：`agent_version` 单独字段，另由 §2.2 版本探测门控能力。

---

## 4. 发现 → 接入链路（ACP 握手）（Q4）

1. **PATH 解析** catalog `binary_name` → 在 PATH，则 `installed:true`、可列。
2. **健康检查**：`last_check_latency_ms`（Kimi 实证 1294ms）≈ 一次 ACP `Initialize` 握手往返；失败则 `status` 降级。
3. **会话接入**：对话/编队建立时拉 `command + args:["acp"]` → stdio → **ACP `Initialize` 握手**（交换 `available_commands` / `available_modes` / `available_models`，即 §3 那些握手所得字段）→ `new_session` → prompt 流式。
4. **`custom try-connect` 实证（核心证据）**：对 `opencode` 显式路径 `try-connect` 返回
   ```
   fail_acp  ACP initialize failed: Initialize handshake timed out after 30s
   ```
   ——证明**权威可用性判定 = 真实 ACP 握手**（不是 PATH 有就算数），且默认 30s 超时。opencode 需 `acp` 子命令/交互上下文，故裸命令握手超时。
5. **失败分类**（strings）：`UserAgentHandshakeFailed / HandshakeTimeout / AcpInitFailed / ProtocolMismatch / NotInstalled / StartupFailed / Disconnected / AuthRequired / CommandNotFound / MissingEnv / NoHandlerToProcessMessage（进程异常退出）`。

---

## 5. 失败 / 降级处理（Q5）

- **未安装**（PATH 不命中）：`installed:false`、`command:null`、`status:"missing"`，仍在 catalog，UI 展示缺装 + 引导（hub 扩展安装 / defaultCliPath）。
- **版本不符**：`VersionMissing/Mismatch/NotPresent/TooOld/TooNew` → 能力降级（例：claude `--version` 识别失败则**省略 `--thinking-display`** 特性，不硬报错）。
- **启动/握手失败**：`UserAgentStartupFailed` / `UserAgentAcpInitFailed`（30s 超时）→ 会话重试 / 恢复策略，配 `turn_recovery_policy` 与 `saw_visible_output` / `saw_tool_or_side_effect` / `persisted_assistant_output` 判定是否可恢复。
- **断连**：`UserAgentDisconnected` → 重连 / 会话失败转移。
- **鉴权缺失**：`AuthRequired` / `CheckAgentLogin` → 引导登录（`.codex/auth.json`、API key 等）。
- **UI 表现**：`doctor` 打印可用性表（available/missing 分列）；`config agents list` 每条带 `status`；缺失 agent 在 roster/设置页以「可安装」姿态展示，不隐藏。

---

## 6. WhalePod（@whalepod/honeycomb）可复用设计要点清单

以 AionUi 机制为蓝本，结合我们已旗舰收口的 `AcpAdapter`（`packages/honeycomb/src/connectors/adapters/acp.ts`）与真机 CLI 清单（`docs/cli-agent-inventory.md`：本机已装 codex/kimi/opencode/hermes）映射：

| # | AionUi 做法 | WhalePod 对应 / 复用点 | 结论 |
|---|---|---|---|
| R1 | **内置 Catalog（binary_name 表）驱动发现** | 我们已有 `ACP_CATALOG`（`acp.ts` 内数组，追加一行即接入） | **直接复用**：把 AionUi 的「catalog + PATH 解析」形态固化为我们 detect() 的默认源 |
| R2 | **PATH 解析命中 = 可发现，ACP 握手 = 权威可用** | 我们 detect() 目前多停在「PATH 命中」；应加「握手级 liveness」 | **增强（A2 重点）**：`installed`（PATH）与 `online`（ACP Initialize 成功）分离为两个状态位 |
| R3 | **custom agent（显式 command 路径）+ per-agent override（command/env/secret）** | 我们 connector 骨架有 `registry.register/resolve` + `adapters/*`，但缺「用户指定路径」入口 | **复用形态**：detect() 之上加 custom/override 层（A2 设计项） |
| R4 | **版本探测 → 能力降级**（claude `--version` → 省 `--thinking-display`） | cli-agent-inventory 已录各 agent `--version` 输出形态；AcpAdapter 按能力降级 | **复用**：capability 门控（kind 精确化已在 ACP 课题做过 kind=gemini-cli 等） |
| R5 | **状态位 + 健康检查往返**（`status` / `last_check_latency_ms` / `last_check_kind`） | 我们的 roster/member 有 MemberStatus×WorkState 状态机 | **对齐**：把「installed/missing/online/offline」落到 roster 注册表，复用现有事件 |
| R6 | **PATH 继承坑显式提示**（app 与 shell PATH 不一致） | OOBE-M0 的 PATH 探测 **Bug#2 教训** | **复用且必须重述**：探测器用与用户一致的环境；WhalePod 内嵌 node 需自举 PATH（node --version / 固定位置探测已做过） |
| R7 | **ACP 握手即权威验证**（`try-connect` 30s 超时） | 我们 `acp-kimi-live.test.ts` 已证明真机 live 可跑 | **补个测试形态**：把「PATH detect + 握手 liveness」做成 pinned live 用例（真机标注 skip 语义） |
| R8 | **失败降级的用户可见性**（missing 留在目录 + 引导安装） | 我们 roster/面板缺 state 呈现 | 面板成员 state 补 available/missing 区分（与取消链路 task-cancelled 类似的位置） |

### 6.1 三条关键对比结论（供 A2 采用）
1. **发现层与可用层分开**：PATH 命中只是「可发现」，ACP Initialize 成功才是「可用」——A2 的探测链应产出 `{ discovered, available }` 双状态，避免把「装了但合不上手」误标为可用（我们连接器真机验证时 codex 403 / kimi 超时正是这种「PATH 有但不可用」的实例）。
2. **Catalog 优先 + 用户覆盖**：默认内置 catalog（复用我们 `ACP_CATALOG` + cli-agent-inventory），用户可 custom/override——不需要用户从零写 detect。
3. **版本/能力的降级而非硬失败**：达不到能力就降级使用（省 feature），不阻止接入——降低接入失败面。

---

## 7. 置信度与缺口声明

- **已实证（high）**：aioncore 承担发现；catalog 43 条目；PATH 解析到绝对路径；未命中表现；custom try-connect 走真实 ACP 握手（30s 超时）；per-agent override（command/env/secret）；版本探测与降级（claude `--version` / `--thinking-display`）；失败分类字符串；状态位建模。
- **中置信**：触发时序的精确性（「设置页打开时」vs「启动时」vs 两者皆有）——从 `last_check_kind:"manual"` 与 `config agents list` 命令推断为「按需/页面触发」，未读 aioncore 源码内调用点（Rust 二进制已编译，无源码）。
- **未覆盖**：aioncore 内部调度/缓存策略（如是否按 TTL 缓存 PATH 结果）；Electron 主进程与 aioncore 的 IPC 触发细节。如需深挖可进一步 strings 逆向，但已不影响 A2 设计取向。

> 备注：本报告从 `/Applications/AionUi.app`（已安装正式版）实证，未修改任何 AionUi 文件；`aioncore doctor` 在本机产生的临时 `data/` 已清理。
