# 外部 CLI Agent 接口实测清单（连接器适配）

> 实测人：连接器-Pro
> 实测日期：2026-08-14
> 用途：供 `adapters/*` 连接器实现使用。每个 agent 一条目，含 CLI 入口、检测方式、版本、配置目录、常用 flags、输出/流式格式、后端、实测结论。

---

## 总览

| Agent | 状态 | CLI 入口 | 版本 | 后端 | 非交互模式 | 流式格式 | 实测可用 |
|---|---|---|---|---|---|---|---|
| codex | 已装 | `codex` | codex-cli 0.146.0 | ChatGPT (`chatgpt.com/backend-api`) | `codex exec` | JSONL (NDJSON) | ❌ 403 区域封锁 |
| kimi | 已装 | `kimi` | 0.34.0 | Moonshot (ark + managed) | `kimi -p` | stream-json (JSONL) / text | ⚠️ 超时 |
| opencode | 已装 | `opencode` | 1.18.16 | DeepSeek | `opencode run` | `--format json` (NDJSON) | ✅ 成功 |
| hermes | 已装 | `hermes` | v0.20.0 | opencode.ai/zen/go | `hermes -z` (oneshot) | 纯文本（非流式） | ✅ 成功 |
| claude | 未装 | `claude` | — | Anthropic | `claude -p` | stream-json (JSONL) | 未安装 |
| gemini | 未装 | `gemini` | — | Google | `gemini -p` | stream-json | 未安装 |
| aider | 未装 | `aider` | — | 多后端 | `aider --message` | 纯文本 | 未安装 |
| goose | 未装 | `goose` | — | 多后端 | `goose run` | 纯文本/JSON | 未安装 |
| qwen-code | 未装 | `qwen` / `qwen-code` | — | 通义 | `qwen -p` | stream-json | 未安装 |

---

## 1. codex（OpenAI Codex CLI）

- **CLI 入口**：`codex` → `/Users/qzp/.local/opt/node/bin/codex`（npm 全局安装，Rust 二进制经 npm 分发）
- **检测安装**：`command -v codex`
- **检测版本**：`codex --version` → `codex-cli 0.146.0`
- **配置目录**：`~/.codex/`
  - `config.toml`：`[tui] model_availability_nux`、`[projects] trust_level`、`[approvals] reviewer`
  - `auth.json`：`{ auth_mode, OPENAI_API_KEY, tokens:{ id_token, access_token, refresh_token, account_id }, last_refresh }`
  - `history.jsonl`、`sessions/`
- **常用 flags**（`codex exec --help`）：
  - `-m/--model <model>` 指定模型
  - `--json` 以 JSON 事件流输出（默认文本渲染）
  - `-o/--output-last-message <file>` 仅输出最后一条消息
  - `-s/--sandbox <mode>`：read-only / workspace-write / danger-full-access
  - `--dangerously-bypass-approvals-and-sandbox`、`--dangerously-bypass-hook-trust`
  - `-C/--cd <dir>`、`--add-dir <dir>` 添加上下文目录
  - `--skip-git-repo-check`（非 git 目录直接跑）
  - `--ephemeral`、`--ignore-user-config`、`--ignore-rules`
  - `--output-schema <json-schema>` 结构化输出约束
  - `-p/--profile`、`-c/--config`、`-i/--image`
- **输出/流式格式**：`--json` 输出 NDJSON 事件流，事件类型包括 `thread.started` / `turn.started` / `item.completed` / `error`。`item.completed` 的 `item.type` 可为 `reasoning` / `tool_use` / `text`。`-o/--output-last-message` 仅取最终助手文本。
- **prompt 通道（Task #01a0014b 确认）**：`codex exec --help` 明确 prompt 是 **[PROMPT] 位置参数（trailing argv）**，**不是 stdin**。`spawnArgs: ['exec','--json','--skip-git-repo-check']` + `send()` 把 prompt 拼到 argv 尾部 → `codex exec --json --skip-git-repo-check "<prompt>"`。`--skip-git-repo-check` 供在非 git 目录直接跑。
- **后端**：默认走 ChatGPT 后端 `wss://chatgpt.com/backend-api/codex/responses`（OAuth token 认证，模型 `gpt-5.6-sol`）。
- **实测结论（updated）**：prompt 通道**协议正确、adapter 无需改动**；CLI 能 spawn 并打出 baseline 事件（`thread.started` / `turn.started` 在挂起前正常发出）。但后端请求被 **403 Cloudflare 区域封锁**（模型表刷新 "failed to refresh available models: timeout"），改提示词无法绕过 —— 记录为**已知边界**（本机未代理/VPN 时无法 headless 完成；网络/区域允许即可用，`test` 用例对后端边界 skip，不判红）。adapter 当前无需代理逻辑。

---

## 2. kimi（Moonshot Kimi Code CLI）

- **CLI 入口**：`kimi` → `/Users/qzp/.kimi-code/bin/kimi`
- **检测安装**：`command -v kimi`
- **检测版本**：`kimi --version` → `0.34.0`
- **配置目录**：`~/.kimi-code/config.toml`
  - 含两个 provider：`managed:kimi-code`（OAuth token，`api.kimi.com`）+ `ark`（API key，`ark.cn-beijing.volces.com`）
  - 默认模型 `ark/ark-code-latest`，另有 `managed:kimi-code/...`
- **常用 flags / 命令**：
  - 非交互：`kimi -p "prompt"`（`--prompt`）
  - `--output-format text|stream-json` 选择输出格式
  - `-m/--model <model>`、`-S/--session <id>`、`-c/--continue`（继续最近会话）
  - `-y/--yolo`（跳过权限确认）、`--auto`、`--plan`
  - `--skills-dir`、`--agent`、`--agent-file`、`--add-dir`
  - 子命令：`export`、`provider`、`acp`（ACP over stdio）、`web`、`login`、`doctor`、`vis`、`migrate`、`upgrade`
- **输出/流式格式**：`--output-format stream-json` 输出 JSONL 事件流（NDJSON）；默认 `text` 为纯文本。
- **prompt 通道（Task #01a0014b 确认并修正）**：kimi 的 prompt 是 **`-p` 的取值**，**不是 trailing 位置参数**。`spawnArgs: ['--output-format','stream-json','-p']` + `send()` 把 prompt 拼到 argv 尾部 → `kimi --output-format stream-json -p "<prompt>"`。（早前误把 `-p` 放 stream-json 前面会因 `-p` 吞掉下一个 token 而报 "unknown command 'stream-json'"，现已修正。）
- **后端**：Moonshot ark / managed（api.kimi.com）。
- **实测结论（updated）**：stream-json 通道**协议已修正并验证能 spawn**，正常 emit NDJSON meta 帧（`{"role":"meta","type":"system.version","content":0.34.0}`、`{"role":"meta","type":"turn.step.retrying",...}`）。但 ark 后端当前返回 **429 周额度用尽**（"You have exceeded the weekly usage quota. It will reset at 2026-08-17"），kimi 进入指数退避重试（~10 次、单次最多等 ~18s），单轮可能在数分钟后仍不完成 —— 记录为**已知边界**（额度 08-17 重置后即可 headless 完成；`test` 用例对额度边界 skip，不判红）。meta/retry 帧由 normalizer 正确丢弃（`role:"meta"` 无 text/tool 字段 → `null`），不会污染 `stream` 事件流。

---

## 3. opencode（opencode-ai）

- **CLI 入口**：`opencode` → `/Users/qzp/.local/opt/node/bin/opencode`
- **检测安装**：`command -v opencode`
- **检测版本**：`opencode --version` → `1.18.16`
- **配置目录**：`~/.config/opencode/opencode.json`
  - 已配 `model: deepseek/deepseek-chat`、`provider: deepseek`（`apiKey` + `baseURL: api.deepseek.com/v1`）
  - `mcp: { sciverse: {...} }` 已启用
- **常用 flags / 命令**：
  - 非交互：`opencode run "message"`
  - `--format json|default`（json = 原始 JSON 事件流；default = 格式化文本）
  - `-m/--model <provider/model>`、`--agent <agent>`、`--variant <id>`
  - `-c/--continue`、`-s/--session <id>`、`--fork`
  - `-f/--file <file>` 文件输入、`--attach <id>`、`--title`
  - `--print-logs`、`--log-level <lvl>`、`--pure`、`--command`
  - `-i/--interactive`、`--auto`（全自动无提示）、`--thinking`
- **输出/流式格式**：`--format json` 输出 NDJSON 事件流，事件 `type` 为 `step_start`（part=`step-start`）、`text`（part=`text`，`text` 字段携带增量）、`step_finish`（part=`step-finish`，含 `tokens`/`finishReason`）。`--format default` 输出人类可读文本。
- **后端**：DeepSeek（OpenAI 兼容 `api.deepseek.com/v1`）。
- **实测结论**：✅ `opencode run --format json "reply with exactly OK"` 成功返回，事件序列 `step_start → text → step_finish` 抓取无误。**本机唯一端到端可用 agent，adapter 首选参考实现。** token 统计在 `step_finish.step.tokens` 中（本次为空，长回复时会填充）。

  **⚠️ stdin-EOF 行为（e2e 关键发现，2026-08-14 深夜）**：opencode 用 **piped stdio** 且 stdin **保持开启**时，会**阻塞等待 stdin EOF** 才执行 one-shot 命令（对照：40s/90s/120s 均 0 输出；spawn 后立刻 `child.stdin.end()` 则 **~9s 出完整 NDJSON**）。prompt 走 **argv**（`opencode run "<prompt>"`）而非 stdin，因此连接器对 prompt 经 argv 的 one-shot agent **必须在 spawn 后立刻关闭 stdin**（bridge `deferSpawn` 模式已实现 `child.stdin.end()`）。
  **`--pure`**：跳过外部 plugin/MCP bootstrap。本机配置了 `sciverse`/`sciverse-survey-gates` MCP（后者无 token），会偶发阻塞；`--pure` 让 one-shot 稳定（实测 ~8-9s 出结果）。adapter 已加 `--pure`（注释记录取舍：host 驱动时不需要 opencode 自带 MCP）。

---

## 4. hermes（Hermes Agent）

- **CLI 入口**：`hermes` → `/Users/qzp/.local/bin/hermes`
- **检测安装**：`command -v hermes`
- **检测版本**：`hermes --version` → `Hermes Agent v0.20.0`
- **配置目录**：`~/.hermes/config.yaml`（另有 `~/.hermes/.env`、`checkpoints/` 等）
  - 默认模型 `deepseek-v4-flash`，provider `opencode-go`，`base_url: opencode.ai/zen/go/v1`
  - 另有 `pujiang-deepseek`、`aliyun-token-plan` 等 provider
- **常用 flags**（`hermes --help`）：
  - 非交互：`hermes -z "PROMPT"`（`--oneshot`，单次提问，只打印最终答复）
  - `-m/--model`、`--provider`、`--reasoning <level>`、`-t/--toolsets`
  - `--usage-file <path>` 输出 token 用量到文件
  - `--resume <session>`、`--continue [name]`、`--no-restore-cwd`、`--worktree`
  - `--accept-hooks`、`--skills`、`--yolo`、`--pass-session-id`
  - `--ignore-user-config`、`--ignore-rules`、`--safe-mode`、`--tui`、`--cli`、`--dev`
- **子命令**（大量）：`chat`、`model`、`config`、`memory`、`mcp`、`cron`、`sessions`、`acp`、`version`、`doctor`、`backup`、`import-agent`（可导入 Claude Code / Codex CLI 配置）等。
- **输出/流式格式**：`-z/--oneshot` 为**一次性纯文本**（stdout 直接打印最终回复，非流式），可配 `--usage-file` 记录用量。交互式 `chat` 有 TUI。
- **后端**：opencode.ai/zen/go/v1（OpenAI 兼容）。
- **实测结论**：✅ `hermes -z "reply with exactly: OK"` 成功返回 `OK`。适合无流式需求的一问一答适配。

---

## 5. 未安装的 agent（检测命令 + 安装方式）

### claude（Anthropic Claude Code）
- 检测：`command -v claude` → 当前未命中
- 安装：
  - `npm install -g @anthropic-ai/claude-code`（npm 最新版）
  - 或 `brew install --cask claude-code`（原生二进制）
- 非交互：`claude -p "prompt" --output-format stream-json`；配置目录 `~/.claude/`（含 `settings.json`、认证）。流式 JSONL 事件（`system`/`assistant`/`user`/`result` 类型）。

### gemini（Google Gemini CLI）
- 检测：`command -v gemini` → 未命中
- 安装：`npm install -g @google/gemini-cli`
- 非交互：`gemini -p "prompt"`；支持 `--output-format stream-json|json|text`。配置 `~/.gemini/`。

### aider
- 检测：`command -v aider` → 未命中
- 安装：`pipx install aider-chat` 或 `pip install aider-chat`
- 非交互：`aider --message "..." --yes`（`--message`/`-m`，`--yes` 免确认）。输出为纯文本，`--dark-mode` 等。配置 `~/.aider.conf.yml`。

### goose
- 检测：`command -v goose` → 未命中
- 安装：`curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | sh` 或 `brew install goose`
- 非交互：`goose run -t "..."`（text 模式）/ `--text`。配置 `~/.config/goose/`。

### qwen-code（通义灵码 CLI）
- 检测：`command -v qwen` / `command -v qwen-code` → 未命中
- 安装：`npm install -g @qwen-code/qwen-code`（二进制名 `qwen` 或 `qwen-code`）
- 非交互：`qwen -p "prompt"`；支持 `--output-format stream-json`。配置 `~/.qwen/`。

---

## 6. adapter 实现要点

1. **统一检测入口**：`command -v <bin>` 判存在，`<bin> --version` 判版本（version 输出各 agent 格式不一，需归一化）。
2. **非交互调用约定**：
   - codex → `codex exec --json <prompt>`
   - kimi → `kimi -p <prompt> --output-format stream-json`
   - opencode → `opencode run --format json <prompt>`
   - hermes → `hermes -z <prompt>`
   - claude → `claude -p <prompt> --output-format stream-json`
   - gemini → `gemini -p <prompt>`
   - aider → `aider --message <prompt> --yes`
3. **流式解析**：codex / kimi / opencode / claude / gemini 均输出 **NDJSON（JSONL）事件流**，但事件 schema 各不相同，需各写一个 parser。hermes/aider/goose 为纯文本。
4. **本机网络现状**：codex（ChatGPT 后端）被 403 封锁需代理；kimi ark 端点超时；opencode（DeepSeek）与 hermes（opencode.ai）可用。**adapter 应支持 per-agent 的 HTTP(S) 代理注入，并对超时/封锁做明确错误上报。**
5. **配置目录**：`~/.codex`、`~/.kimi-code`、`~/.config/opencode`、`~/.hermes`、`~/.claude`、`~/.gemini`、`~/.aider.conf.yml`、`~/.config/goose`、`~/.qwen`。
6. **铁律（e2e 实测，2026-08-14）**：**prompt 经 argv 的 one-shot agent，spawn 后必须立刻 `stdin.end()`**。实测 opencode 在 piped stdin 保持开启时阻塞等 stdin EOF（>120s 无输出），关 stdin 则 ~9s 出结果。codex/kimi/hermes（同走 argv + deferSpawn）联调时照此办理。
7. **事件契约标准化路径已验证**：`detect → spawn → send(→argv prompt) → 事件流(receiver)` 全链路在真 opencode 上跑通（见 §7）。

---

## 7. 真机端到端验证结果

### 7.1 连接器链路（Task #01a000f8，opencode 参考实现）

在 `packages/honeycomb` 真机跑通完整连接器链路，测试文件 `test/connector-live.test.ts`。

- **detect 四连 HIT**：
  | Adapter | version | config 命中 |
  |---|---|---|
  | opencode | 1.18.16 | `~/.config/opencode` ✓ |
  | codex | codex-cli 0.146.0 | `~/.codex` ✓ |
  | kimi-code | 0.34.0 | `~/.kimi-code` ✓ |
  | hermes | v0.20.0 | `~/.hermes` ✓ |
  `claude-code` miss（未安装，spawn 时报"not installed + 安装指引"）。
- **事件流标准化（真 opencode）**：`stream`(chunk="OK") → `done`(exitCode=0)，8.6s 完成。simple prompt 无 tool，故仅 stream+done；tool-call/tool-result 映射由 recorded-protocol + mock-agent 确定性用例覆盖。
- **env-filter 洗清嫌疑**：filtered env 下 opencode 照常 8.6s 通，慢/挂与白名单无关。
- **根因修正**：`bridge/stdio-session.ts` — `deferSpawn` 模式 spawn 后 `child.stdin.end()`；`opencode.ts` — `spawnArgs` 加 `--pure`（跳过 MCP bootstrap 偶发阻塞）。
- **启动耗时基线**：`--pure` 下 opencode `spawn→首个事件 ~8-9s`（LLM 本身 <1s，其余为进程+MCP-free 初始化）。openopde 直跑（full-env, TTY stdio）冷启动 ~11-16s 无 `--pure` 时因 MCP sciverse 拉取可能更久或偶发挂起。

### 7.2 codex / kimi / hermes 真机验证（Task #01a0014b）

对 codex、kimi、hermes 三个 adapter 做最小 prompt 真机验证，测试文件 `connector-live.test.ts` 扩展为 7 用例（4 基础 + hermes/codex/kimi 三名 live）。

| Adapter | prompt 通道 | 真机结论 | 状态 |
|---|---|---|---|
| **hermes** | trailing argv（`-z "<prompt>"`） | ✅ **完整跑通**：`stream`(chunk="HELLO WORLD") → `done`，~10.4s；纯文本（无 NDJSON）。adapter 无需改动。 | ✅ 端到端可用 |
| **codex** | trailing argv（`[PROMPT]` 位置参数） | ✅ 协议确认正确（`exec --help`）；能 spawn 并 emit baseline `thread.started`/`turn.started`。⚠️ ChatGPT 后端 **403 Cloudflare 区域封锁**（模型表刷新 timeout），headless 无法完成。 | ⚠️ 协议在案，后端边界 |
| **kimi-code** | **`-p` 取值**（非 trailing 位置参数，已修正） | ✅ 修正后能 spawn 并 emit stream-json meta/retry 帧。⚠️ ark 后端 **429 周额度用尽**（08-17 重置）→ 指数退避重试数分钟仍不完成。 | ⚠️ 协议已修，额度边界 |

- **hermes 细节**：`hermesNormalizer` 把纯文本行映射为 `stream` 增量，`exitCode=0` → `done`。当前唯一能端到端完成真机验证的第二个 agent（连同 opencode 两个）。
- **codex 细节**：prompt 走 argv（非 stdin）再确认一次（早前基于 stderr "Reading additional input from stdin" 的错误 stdin 假设已撤销，`bridge` 仅保留 `stdin.end()` 于 `deferSpawn`）。后端 403 在本机（无代理）不可绕过，`exec --json` 挂起直至 timeout。
- **kimi 细节**：早前 `spawnArgs` 误把 `-p` 放前面导致 `-p` 吞掉下一个 token 报 "unknown command 'stream-json'"，已修正为 `['--output-format','stream-json','-p']`。stream-json 的 `meta`/`turn.step.retrying` 帧被 normalizer 丢弃，不污染 `stream` 流。
- **测试约定**：codex/kimi 的 live 用例对**后端边界 skip 不判红**（断言协议能 spawn + 出 baseline 事件/错误即通过，后端 403/429 挂起则 skip），hermes/opencode live 用例断言真实 `stream→done`。确保无后端配额/网络地区限制的主机可自动解锁为强断言。
- **临时排查脚本已清理**：`scripts/_connector-live3.ts`、`scripts/_kimi-test.ts`、`scripts/_probe-kimi-codex.ts`、`/tmp/_*.ts` probes 全部删除。子进程核验干净（仅保留 hermes 既有守护进程 ~32xxx PIDs，非本次 spawn，未动）。
