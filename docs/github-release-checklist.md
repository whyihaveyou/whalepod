# GitHub 上线准备 — 仓库卫生盘点报告（Checklist）

> 作者：工程-Flash-2 | 关联任务：#01a0015a | 类型：**只读盘点**（不 push）
> 状态：盘点完成，待本地可用绿灯 + 品牌收束后执行清理与推送
> 目标：项目作为公开 GitHub 仓库上线（用户指令 2026-08-15 睡前），Mac 先行，Windows 入路线图。

---

## 1. 仓库卫生现状（已实测）

### 1.1 gitingore 覆盖检查 ✅（基本到位）

```gitignore
node_modules/  dist/  .build/  lib/  *.tsbuildinfo
deepseek-harness/  refs/          # 上游 clone + 参考仓库（不入库）
*.log  coverage/  .DS_Store
```

**实测**：
| 项 | 状态 | 证据 |
|---|---|---|
| `deepseek-harness/`（上游 clone） | ✅ 已 ignore，git 跟踪 0 文件 | `git ls-files deepseek-harness` = 0 |
| `refs/`（参考仓库 dsh-desktop） | ✅ 已 ignore，git 跟踪 0 文件 | `git ls-files refs` = 0 |
| `node_modules/ dist/ .build/ lib/` | ✅ 已 ignore | .gitignore 第 2-6 行 |
| 构建产物（.o/.a/.dylib/.app/） | ✅ 无被跟踪 | 扫描无命中 |

### 1.2 需要补强的卫生项（执行阶段处理）

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| H1 | **`.aionrs/` + `.kimi/` 被 git 跟踪**（各 4 个 skill：aionui-config/cron/officecli/skill-creator） | `git ls-files` 含 `.aionrs`、`.kimi` | **public 前必须 ignore**：这是 aion/kimi 工具配置+skill（本团队私有，`aionui-config` 可能有 MCP/模型/凭据路径）。加 `.aionrs/` `.kimi/` 到 .gitignore，`git rm --cached` 出跟踪。 |
| H2 | `HarnessShell/Scripts/make-icns.sh` 内**绝对路径** `/Users/qzp/aion2dsh/design/assets` | 脚本写死个人路径 | 改为相对 `$ROOT/design/assets`，public 后贡献者可用。 |
| H3 | 多文件含 `/Users/qzp/` 路径（README/docs） | 文档路径说明（非泄漏），但 public 不友好 | 改 `~/` 或相对表述（README/文档层） |
| H4 | `*.icns` 中间产物 | Resources/ 3 个**成品 icns** 是交付物（AppIcon/IconDarkTile/IconMono），**该入库**；make-icns.sh 若有临时层应 ignore | 成品保留；若生成过程有 `*.png` 中间层按需 ignore |

### 1.3 密钥 / 个人路径 / 敏感信息扫描 ✅（无真实泄漏）

| 扫描项 | 命中 | 判定 |
|---|---|---|
| `api_key/api_secret/access_token/sk-*/bearer` | 仅 `docs/cli-agent-inventory.md:32` | **误报**：是 `auth.json` **结构字段名说明**（`{OPENAI_API_KEY, tokens:{...}}`），非真实密钥值。保留。 |
| `/Users/qzp` 个人路径 | 20+ 文档命中 | 均为**文档路径说明**（如 `~/Library/Application Support/WhalePod/`、示例路径），非用户数据泄漏。public 前统一改 `~/`/相对。 |
| `~/.dsh` profile 数据 | 无命中 | ✅ 无 `.dsh` 配置/凭据数据被跟踪（dsh CLI 数据在本机某处，不在仓内） |
| AionUi / 私有 token | — | 无（README 将声明"不含 AionUi 代码"） |

**结论**：**无真实 API key / token / 凭据残留**，唯一实质卫生动作是 **H1（.aionrs/.kimi）**和 **H2（绝对路径）**。

---

## 2. 推送前必做清单位（public 绿灯后执行）

- [ ] **H1**：`.gitignore` 加 `.aionrs/` `.kimi/`；`git rm -r --cached .aionrs .kimi`（不删本地文件）
- [ ] **H2**：make-icns.sh 绝对值 → 相对 `$ROOT/design/assets`
- [ ] **H3**：README/docs `/Users/qzp` → `~/`（文案层）
- [ ] 确认 `.build/ HarnessShell/.build/` 已 ignore（SPM 产物不入库）
- [ ] 「鲸群 WhalePod」改名收束完成后，顶层目标结构：`HarnessShell/ packages/ prototypes/ honeycomb-adaptor/ docs/ design/ examples/ scripts/`（均已有）

---

## 3. README / LICENSE / 版本化（见草稿文档）

| 交付 | 位置（草案） | 说明 |
|---|---|---|
| 根 README 草稿 | `docs/readme-draft.md` | 等改名完成归位到根 `README.md` |
| LICENSE（MIT+致谢） | `docs/LICENSE-draft.md` | 归位根 `LICENSE` |
| CHANGELOG 骨架 | 拟 `CHANGELOG.md` | 0.1.0 起步，语义化 |
| git tag 规范 | 见 §4 | `v0.1.0` 起步 |

---

## 4. 版本化 / 推送规范建议

- **语义化版本**：起步 `0.1.0`（本地已可用，非 1.0 前的内部里程碑可 0.y.z 起步）
- **git tag**：格式 `v<major>.<minor>.<patch>`（`v0.1.0`），tagged commit = 可推送发布点
- **分支保护**（push 后）：`main` 加保护——需 review、禁直接 push、要求 CI 绿（若配）。团队持续开发用 feature 分支。
- **仓库名建议**：`whalepod`（最终以用户确认为准）
- **首次 push 步骤**（需用户 GitHub 授权/凭证，现只准备不执行）：
  ```bash
  # ① 清理（H1/H2）
  # ② 改名收束完成、本地可用绿灯
  # ③ 首次提交（含 LICENSE/README/CHANGELOG）
  git add -A && git commit -m "chore: init WhalePod 0.1.0"
  git tag v0.1.0
  # ④ 推送（需凭证）
  git remote add origin git@github.com:<user>/whalepod.git
  git push -u origin main --tags
  ```

---

## 5. 依赖许可证兼容性（上线前锁定）

| 依赖 | 许可证 | 处理 |
|---|---|---|
| `@deepseek-ai/dsh`（harness） | MIT | ✅ README/LICENSE 致谢 |
| `cordis` / DeltaTea | MIT | ✅ README 声明参考，无源码拷贝入仓 |
| AionUi | — | **仅概念参考，无代码** → README 声明「多智能体编排为独立概念重实现，不含 AionUi 代码」 |

---

## 6. 与【品牌收束】协同

- 本报告为**只读准备**；H1/H2/H3 清理动作与改名**无文件交集**，可在改名后一起做。
- 根 README / LICENSE 归位要等**改名收束完成后**（避免 `docs/readme-draft.md` 里写死后又要改）。
- **实际 push 需用户 GitHub 授权** → 只准备不执行，等用户醒来。
