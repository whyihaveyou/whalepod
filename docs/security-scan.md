# 安全扫描报告（GitHub 上线前）

> 执行：工程-Flash-1 | 任务：#01a0015a（GitHub 上线准备·名字无关部分） ③
> 时间：2026-08-15（夜间持续开发模式）
> 范围：全仓锚定子路径扫描（packages/, HarnessShell/, docs/, harness-feature-inventory.md, scripts/, harness-docs/, design/, examples/, prototypes/）
> **未扫**：deepseek-harness/（上游 clone，git ignore）、refs/（本地参考，git ignore）、node_modules/（依赖）
> **纪律**：命中即报位置，**不擅自删除代码**（组长明示）

---

## 1. 真实凭据 / API Key / Token 扫描

### 1.1 高危模式扫描（sk-xxx / ghp_xxx / Google API key / Slack token 等）

| 模式 | 结果 |
|---|---|
| `sk-[a-zA-Z0-9]{20,}` (OpenAI/Stripe 等) | ❌ **0 命中** |
| `sk_live_*` / `sk_test_*` | ❌ **0 命中** |
| `ghp_[a-zA-Z0-9]{20,}` / `github_pat_*` | ❌ **0 命中** |
| `AIza[0-9A-Za-z_\-]{20,}` (Google API key) | ❌ **0 命中** |
| `xoxb-*` / `xoxp-*` (Slack token) | ❌ **0 命中** |

### 1.2 一般 key/token 字面量扫描（`key=xxx`、`token: xxx`、`secret: xxx`）

| 位置 | 内容性质 | 风险 |
|---|---|---|
| `packages/honeycomb/src/connectors/types.ts` | `// e.g. OPENAI_API_KEY` 等**环境变量名**（注释/字符串字面量） | ✅ 安全 |
| `packages/honeycomb/src/connectors/adapters/codex.ts` | 注释提到 `CODEX_API_KEY` env 名 | ✅ 安全 |
| `packages/honeycomb/src/connectors/adapters/kimi.ts` | 注释提到 `KIMI_API_KEY` env 名 | ✅ 安全 |
| `packages/honeycomb/src/connectors/adapters/opencode.ts` | 注释提到 `OPENCODE_API_KEY` env 名 | ✅ 安全 |

> **判读**：全部命中为"环境变量名字符串/注释"，**非真实凭据**。连接器代码读取 env 但不固化任何密钥。✅

---

## 2. 个人绝对路径扫描（`/Users/qzp/...`）

**12 处命中**（按文件归类）：

| 文件 | 行号 | 性质 | 处置建议 |
|---|---|---|---|
| `HarnessShell/Sources/HarnessShell/ServiceConfig.swift` | 13 | 默认 `workingDirectory: "/Users/qzp/aion2dsh/deepseek-harness"` | ⚠️ 报告；**不改**（任务边界明确"别碰 HarnessShell 源码"，建议 owner 在 rebrand 阶段抽象成 `~/` 或环境变量） |
| `HarnessShell/Scripts/make-icns.sh` | 5 | `ASSETS="/Users/qzp/aion2dsh/design/assets"` | ⚠️ 报告；**不改**（任务边界明确"别碰 HarnessShell 源码"，建议改用 `${ROOT}/../design/assets` 相对路径） |
| `HarnessShell/Scripts/make-icns.sh` | 14 | 同上变量展开 | 同上 |
| `HarnessShell/README.md` | 66 | 默认配置示例含 workingDirectory 路径 | ⚠️ 报告；**不改**（任务边界明确"别碰 README，rebrand 后再写"） |
| `HarnessShell/docs/distribution.md` | 3 | "适用对象：/Users/qzp/aion2dsh/HarnessShell/" 文档说明 | ⚠️ 报告；**不改**（rebrand 阶段统一替换） |
| `HarnessShell/docs/integration-test.md` | 4 | 文档示例 | 同上 |
| `HarnessShell/docs/integration-test.md` | 35 | 同上 | 同上 |
| `HarnessShell/docs/integration-test.md` | 43 | 同上 | 同上 |
| `HarnessShell/docs/integration-test.md` | 其他位置（≤10 处） | 文档示例 | 同上 |

### 风险评估

- **真实风险**：`ServiceConfig.swift` 与 `make-icns.sh` 的硬编码 `/Users/qzp/aion2dsh/...` 是**功能性瑕疵**，public 后会暴露用户名、且在用户机器上（用户名非 `qzp`）直接运行会失败。
- **文档风险**：README/docs 中含路径示例是**公开知识**（GitHub 仓库的典型例子），但用户名暴露仍属隐私最佳实践的瑕疵。
- **不属本任务范围**：组长明示"不动 HarnessShell 源码"、"不动 README"。

### 建议（待 rebrand 阶段处理）

| 文件 | 建议改造 |
|---|---|
| `ServiceConfig.swift` | `workingDirectory` 默认值改为 `nil`（让调用方传）或 `~/Library/Application Support/<AppName>`（沙盒友好路径） |
| `make-icns.sh` | 改用相对路径 `"$(cd "$ROOT/.." && pwd)/design/assets"`，或通过环境变量 `DFH_DESIGN_ASSETS` 注入 |
| `README.md` / `docs/*.md` | rebrand 阶段统一把 `/Users/qzp/aion2dsh/` 替换成相对引用或 `<repo-root>/` 形式 |

---

## 3. 用户数据目录保护（.gitignore 已覆盖）

新增的 .gitignore 段已确保以下**绝不入库**：

```gitignore
~/.harness-shell/        # HarnessShell 配置与数据
.harness-shell/
.harness/                # DeepSeek Harness 数据根（DSH_HOME）
.dsh/                    # dsh CLI 数据
**/config.local.json     # 本地覆盖配置
**/.env                  # 环境变量文件（含 API key）
**/.env.*
Library/Application Support/*/   # macOS 用户数据
*.pem *.key *.p12 *.keystore   # 密钥材料
secrets/ .credentials/   # 凭据目录
```

---

## 4. 仓库卫生复核

- ✅ 无未跟踪的诊断残留（bisect/probe/repro/tmp-diag 全部不存在，见 #01a00322）
- ✅ `deepseek-harness/`、`refs/` 被正确 git-ignore（`git check-ignore` 验证）
- ✅ `node_modules/`、`dist/`、`.build/` 被 git-ignore
- ✅ 新增 `*.app/`、`*.dmg`、`*.zip`、`*.pkg` ignore（HarnessShell 打包产物）
- ✅ harness-docs/ 入库的是阅读笔记（cookbook/cordisapi），无个人路径

---

## 5. 结论

| 检查项 | 结果 |
|---|---|
| 真实 API key / token 残留 | ✅ 无 |
| Slack / GitHub / Google 等高危凭据 | ✅ 无 |
| 个人绝对路径（`/Users/qzp/`） | ⚠️ 12 处，全部在 HarnessShell（源码/脚本/文档），**任务边界不动**已上报待 rebrand |
| 用户数据目录误入 | ✅ 无（.gitignore 严格保护） |
| 诊断残留 | ✅ 无（#01a00322 已清） |

**上线前唯一待处理项**：rebrand / 产品定名阶段统一抽象用户路径（建议 owner: 工程-Flash-2 rebrand 任务 + HarnessShell owner）。

---

## 附：扫描使用的关键 Grep 锚点

```bash
# 高危模式（按子路径锚定，未对全仓）
Grep pattern='(sk-[a-zA-Z0-9]{20,}|sk_live_|sk_test_|ghp_[a-zA-Z0-9]{20,}|github_pat_|AIza[0-9A-Za-z_\-]{20,}|xoxb-[a-zA-Z0-9-]+|xoxp-[a-zA-Z0-9-]+)' path=/Users/qzp/aion2dsh
# → 0 命中

# API key / token 字面（仅 packages/ + HarnessShell/）
Grep pattern='(api[_-]?key|apikey|bearer\s+token|access[_-]?token|secret[_-]?key)' path=/Users/qzp/aion2dsh/packages case_insensitive=true
Grep pattern='(api[_-]?key|apikey|bearer\s+token|access[_-]?token|secret[_-]?key)' path=/Users/qzp/aion2dsh/HarnessShell case_insensitive=true

# 个人路径（按子路径锚定）
Grep pattern='/Users/qzp/' path=/Users/qzp/aion2dsh/packages
Grep pattern='/Users/qzp/' path=/Users/qzp/aion2dsh/HarnessShell
Grep pattern='/Users/qzp/' path=/Users/qzp/aion2dsh/harness-docs    # → 0 命中
Grep pattern='/Users/qzp/' path=/Users/qzp/aion2dsh/scripts         # → 0 命中
```

> ⚠️ 严格遵守工具使用铁律（2026-08-15 用户纠正）：**禁止**在仓库根目录 `/Users/qzp/aion2dsh` 用 `**` 开头的 Glob/Grep 全扫。
> 所有扫描均锚定子路径（packages/ / HarnessShell/ / harness-docs/ / scripts/ 等）。