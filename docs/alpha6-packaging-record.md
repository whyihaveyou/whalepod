# alpha.6 打包记录（OOB-1 收尾，commit 14c90e7 + [oob-1b]）

> 任务: #01a00db1（【开箱版总装 OOB-1】alpha.6 = honeycomb 进盒 + 面板接线）
> 时间: 2026-08-17（Asia/Shanghai）
> 状态: **未发版**（不打 tag 不发 release；产物留 `HarnessShell/dist/`，供 OOB-3 守门验收取用）

---

## 1. 产物

| 档位 | 产物 | 体积 | SHA-256 |
|---|---|---|---|
| Full | `dist/WhalePod-0.1.0-alpha.6-macos-arm64.dmg` | 208M | `f5f92ff6872b52d9fe4fde6bb95576ab65d518ada88de673a0b279291a871b57` |
| Slim | `dist/WhalePod-0.1.0-alpha.6-macos-arm64-slim.zip` | 1.1M | `918a869286e5d4908dfa2e9c9576007e3101f437cae7208b82d80c0cbc4a86fd` |

版本注入：`VERSION=0.1.0-alpha.6 BUILD_NUMBER=6`（`CFBundleShortVersionString=0.1.0-alpha.6` / `CFBundleVersion=6`，双档一致）。

> 以上 SHA-256 即 appcast 判据 3/4（Full/Slim enclosure sha256）的输入值，发版时直接复用。

## 2. 盒内内容（Full 档，DMG 内 app = 478M）

| 组件 | 形态 | 验证 |
|---|---|---|
| honeycomb 运行时 | `Resources/node_modules/@whalepod/honeycomb`（同事务 tarball）| 真 Node ESM import 63 exports ✅、cordis/schemastery 单实例（4.0.1/3.18.1）✅ |
| 团队面板 | `Resources/node_modules/@deepseek-ai/dsh-client-ui-whalepod-team`（insert 形态手动 extract，tarball 0.1.0-rc.5）| 真 Node ESM import 冒烟 ✅、无运行时 npm 依赖 |
| 内置 dsh_home | `Resources/dsh_home/profiles/web/cordis.patch.yml` | 含 honeycomb + `ui-whalepod-team` 双 insert 条目；dump-config 合成断言过 |
| 共享层链接 | `profiles/node_modules/*` | **0 条绝对 symlink**（510 条→相对 + 面板补链），`.app` 可挪位 |

codesign：`--force --sign -` + `codesign --verify --deep --strict` **PASS**（hdiutil verify VALID）。

## 3. 本次收尾改动（[oob-1b] 无脚本改动）

打包链路全部为环境变量驱动（`VERSION`/`BUILD_NUMBER`/`PANEL_TARBALL`/`RUNTIME_BUNDLE=0`），
`make-dmg.sh`/`make-slim.sh`/`build-app.sh` 本轮零改动。本 commit 仅记录产物与哈希。

## 4. 已知遗留（不阻塞验收）

- **传播缺口**：内置 `dsh_home` 无用户首启复制机制（HarnessServiceManager 无条件注入用户本地
  DSH_HOME），honeycomb/面板与 dsh 同受限于此 —— 三选项已报 Leader，待决策。
- alpha.6 未发版：appcast 未生成、release.yml 未触发（按 Leader 指示）。
- `docs/alpha6-guarding-criteria.md` 判据 10 验证路径仍写 `@ihewro/honeycomb`（旧命名），
  实际装箱为 `@whalepod/honeycomb` —— OOB-3 验收时需按新路径执行（Flash-1 文档所有权，未代改）。

## 5. 关联

- 面板接线设计: `docs/panel-tarball-install.md`
- 装箱设计: `docs/honeycomb-app-bundling.md` + `docs/honeycomb-bundling-verification.md`
- 验收判据: `docs/alpha6-guarding-criteria.md`
- 版本分档: `docs/version-tiers.md`
