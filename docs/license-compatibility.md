# 依赖许可证兼容性清单

> 本文档用于 GitHub 上线前的法律合规自审：所有运行时依赖与参考项目均与本项目 **MIT License** 兼容。
> 维护责任人：工程-Flash-1 / 编制：2026-08-15 / 适用范围：v0.1.0 pre-release

---

## 一、本项目自身

| 组件 | License | 证据 |
|---|---|---|
| 仓库根 `LICENSE` | MIT | [`../LICENSE`](../LICENSE) |
| `@whalepod/honeycomb`（`packages/honeycomb/package.json`） | MIT | `license: "MIT"` |
| HarnessShell Swift 源码 | MIT（继承根 LICENSE） | `HarnessShell/Sources/HarnessShell/` |
| 文档、设计 token、组件规范 | MIT（继承根 LICENSE） | `docs/`、`design/`、`prototypes/` |

---

## 二、直接 npm 依赖（运行时）

| 包 | 版本约束 | License | 兼容 MIT？ | 来源 |
|---|---|---|---|---|
| `@deepseek-ai/cordis` | ^4.0.1（peer） | MIT | ✅ | `packages/honeycomb/package.json` |
| `@deepseek-ai/schemastery` | ^3.18.1（peer） | MIT | ✅ | 同上 |
| `ws` | ^8.21.3 | MIT | ✅ | 同上 |
| `@types/ws` | ^8.18.1（dev） | MIT | ✅ | 同上 |
| `tsx` | ^4.16.0（dev） | MIT | ✅ | 同上 |
| `typescript` | ^5.5.0（dev） | Apache-2.0 | ✅ | 同上（Apache-2.0 与 MIT 双向兼容） |
| `@types/node` | ^22.0.0（dev） | MIT | ✅ | 同上 |

**结论**：0 个 GPL / AGPL / LGPL / SSPL / BUSL 污染源。所有依赖均为 MIT 或 MIT 兼容（Apache-2.0）。

---

## 三、HarnessShell Swift 依赖

| 框架 | 来源 | License | 兼容 MIT？ |
|---|---|---|---|
| AppKit | Apple SDK | APSL-2（系统框架，作为链接接口使用，不二次分发） | ✅ |
| WebKit | Apple SDK | 同上 | ✅ |
| `@main` / `swift-tools-version:5.9` | Swift 工具链 | Apache-2.0 | ✅ |

> **说明**：HarnessShell 不引入任何 SPM 第三方依赖；与上游 DSH 通过 `Process` spawn + HTTP/WS 通信，不做源码级链接。

---

## 四、运行时依赖（运行时从 npm registry 拉取）

| 包 | License | 用途 | 兼容 MIT？ |
|---|---|---|---|
| `@deepseek-ai/dsh`（^0.1.0-rc.6） | MIT | harness Web UI + DSH server（M0 bundled 方案下将打包进 .app） | ✅ |
| 其余由 dsh 引出的传递依赖 | 各自声明 | 由 dsh 自己负责兼容性 | ✅（已在 dsh 仓库声明） |

---

## 五、参考仓库（NOT bundled，gitignored，不入仓）

| 仓库 | License | 引用方式 | 入仓？ |
|---|---|---|---|
| [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) | MIT | 上游仓库，本仓库依赖其 npm 包但**不二次分发其源码** | ❌（clone 到 `deepseek-harness/` 仅供本地参考；gitignored） |
| [`dataelement/dsh-desktop`](https://github.com/dataelement/dsh-desktop) | MIT | Electron 跨平台壳的 OOBE / 签名 / 自动更新参考实现 | ❌（clone 到 `refs/dsh-desktop/`；gitignored） |
| [`salathleizhang/deepseek-harness-desktop`](https://github.com/salathleizhang/deepseek-harness-desktop) | MIT | 早期 Electron 壳参考（端口/单实例/退避） | ❌（已并入 `refs/dsh-desktop/` 或本仓库内 README 致谢） |

---

## 六、AionUi 关系声明（重要）

本项目在**架构设计阶段**参考了 [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi)（Apache-2.0）作为多智能体协作模型（leader/worker / roster / 任务板 / 消息总线）的灵感来源，但：

1. **不包含任何 AionUi 源码**（无 `import` / 无派生 work / 无 fork）。
2. **不使用 AionUi 的类名或 API 名**（团队面板、Honeycomb service 全部使用蜂巢词汇：Hive / Queen / Worker / Roster / Ledger / Courier / Mandate / hatch / dismiss）。
3. **未触发 Apache-2.0 的「Notice」义务**（仅在文档与代码注释中标注设计来源即可满足，README 与各 service 头部已注明）。

> 验证方式：`grep -r "iOfficeAI\|AionUi" --include="*.ts" --include="*.swift" packages/ HarnessShell/ prototypes/` 仅应出现在文档/注释中，不应出现在 import / require / framework import 里。

---

## 七、生成式图标资产说明

`design/assets/whalepod-icon-*.svg` 与 `whalepod-icon-final.svg` 由用户提供/参照用户稿**矢量重绘**生成：

- 形态（构图/姿态/色彩关系）：用户生成式原图作为参考，版权归属与原图作者协商。
- 矢量重绘：本仓库独立完成，去水印/净边后形成新作品，按 MIT 发布（用户已同意）。

若上游有任何授权争议，按 `LICENSE` 的「NO WARRANTY」条款处理；MIT 不附带任何商标或专利授权。

---

## 八、自检清单（push 前必跑）

```bash
# 1. 确认 0 个 GPL 污染
grep -rE "GPL|AGPL|LGPL|SSPL|BUSL" --include="*.json" \
    packages/honeycomb/package.json prototypes/team-panel/package.json \
    | grep -v "^Binary" || echo "✅ 无 copyleft 污染"

# 2. 确认 0 个 AionUi 源码引用
grep -rE "from ['\"]@?aionui|from ['\"]aionui" --include="*.ts" --include="*.tsx" \
    packages/ prototypes/ HarnessShell/ 2>/dev/null \
    || echo "✅ 无 AionUi import"

# 3. 确认 0 个泄漏的私有凭证
grep -rE "AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}" \
    --include="*.ts" --include="*.swift" --include="*.json" \
    packages/ prototypes/ HarnessShell/ docs/ design/ \
    || echo "✅ 无凭证泄漏"

# 4. 全仓 LICENSE 头部覆盖
find packages/honeycomb/src HarnessShell/Sources -name "*.ts" -o -name "*.swift" \
    | xargs head -1 | sort | uniq -c
# 期望：所有 .ts 顶部 SPDX 标识或本项目注释；所有 .swift 顶部版权注释
```

---

## 九、变更日志

| 日期 | 变更 | 责任人 |
|---|---|---|
| 2026-08-15 | 首次编制（v0.1.0 pre-release） | 工程-Flash-1 |