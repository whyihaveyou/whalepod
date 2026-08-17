# alpha.6 守门判据（含判据 10）

> 任务: #01a00db2-7298-7ef2-b57e-695c8727c9bd（【开箱版 OOB-3】Part B 副）
> 起草时间: 2026-08-17（Asia/Shanghai）
> 起草人: Flash-1
> 关联: engineering-Flash-4's OOB-1 → alpha.6 candidate → Leader 守门验证
> 继承: 顺延 alpha.5 守门 9 判据（见 `project-release-version-injection-appcast.md`）

---

## 1. 判据全表（alpha.6 = 9 + 1）

| # | 判据 | 验证方式 | 必过 | 来源 |
|---|---|---|---|---|
| 1 | Full DMG 产物存在且命名 = `WhalePod-<ver>-macos-arm64.dmg` | `gh release download` / `releases/latest` API | ✓ | 判据 1 |
| 2 | Slim ZIP 产物存在且命名 = `WhalePod-<ver>-macos-arm64-slim.zip` | 同上 | ✓ | 判据 2 |
| 3 | Full 档 DMG sha256 与 appcast.xml `enclosure[full]` sha256 一致 | `shasum -a 256` 对比 | ✓ | 判据 3 |
| 4 | Slim ZIP sha256 与 appcast.xml `enclosure[slim]` sha256 一致 | 同上 | ✓ | 判据 4 |
| 5 | 双档版本号与 `CFBundleVersion` 一致 = BUILD_NUMBER | 从产物 `.app/Contents/Info.plist` 读 | ✓ | 判据 5 |
| 6 | release.yml CI 全绿（macos-latest + macos-13） | GitHub Actions 列表 | ✓ | 判据 6 |
| 7 | git tag `<v新版>` 已推送且指向同一 commit | `git ls-remote --tags origin` | ✓ | 判据 7 |
| 8 | 字符串契约一致性（DMG/ZIP 命名与 release.yml/make-dmg.sh/make-appcast.sh 三处一致） | 字符串匹配 + grep | ✓ | 判据 8（alpha.4 确立）|
| 9 | appcast.xml Sparkle 2 兼容（双 enclosure + 1 item） | XML 解析 + 字段校验 | ✓ | 判据 9（alpha.4 确立）|
| **10** | **装机实例内 honeycomb 可 import / 插件已注册** | **`require('@ihewro/honeycomb')` 不抛 + 表面登记（`Honeycomb.project` 读取到当前 plugin）** | **✓** | **OOB-1 新增** |

---

## 2. 判据 10 详释（OOB-1 honeycomb 装箱落地验证）

### 2.1 背景

honeycomb 多 agent 运行时此前未装箱，发版 app 只装上游 dsh — 见 memory `project-honeycomb-not-in-release.md`。OOB-1（engineering-Flash-4）负责把 honeycomb plugin 真正打进装机实例。判据 10 验证该装箱生效。

### 2.2 验证步骤

#### 步骤 1：DMG/Slim ZIP 落盘产物中 honeycomb 物理存在

```bash
# 下载/挂载/解压任选一档（Full 优先）
DMG=$(gh release download v0.1.0-alpha.6 --pattern 'WhalePod-0.1.0-alpha.6-macos-arm64.dmg' --dir /tmp -R)
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint /tmp/wpmount6
# 拷出 app 到 sandbox
cp -R /tmp/wpmount6/HarnessShell.app /tmp/wp6.app
hdiutil detach /tmp/wpmount6

# 验证 honeycomb + 面板 双装箱（OOB-1 alpha.6 接线后产物）
ls /tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb/ 2>/dev/null
# 期望：含 lib/ (index.js) + package.json + src/
ls /tmp/wp6.app/Contents/Resources/node_modules/@deepseek-ai/dsh-client-ui-whalepod-team/ 2>/dev/null
# 期望：含 lib/ (index.js) + package.json（OOB-1 面板 tarball, dependencies=[]）
ls /tmp/wp6.app/Contents/Resources/dsh_home/ 2>/dev/null
# 期望：profiles/（含 web/cordis.yml + web/cordis.patch.yml）+ node/
ls /tmp/wp6.app/Contents/Resources/node/ 2>/dev/null | head -5
# 期望：装箱 Node.js 二进制
```

> ⚠️ **本地覆盖坑**：`dist/HarnessShell.app` 是收尾时被 `make-slim` 覆盖后的 1.5M Slim 档
> （VERSION 0.1.0-alpha.6/6 但 Resources 仅 AppIcon.icns，盒内无 runtime）。
> 本地守门必须以 `dist/WhalePod-0.1.0-alpha.6-macos-arm64.dmg` 挂载盒内为准（208M on disk / 478M .app inside）。
> 公开数据反推法（gh release download）无此问题。

#### 步骤 2：honeycomb 包可在 Node 进程中 import

```bash
DSH_HOME=/tmp/wp6.app/Contents/Resources/dsh_home
node --version  # 不重要，只确认有 node
node -e "
  const path = require('path');
  process.env.DSH_HOME = '$DSH_HOME';
  // 引导 dsh_home profiles 生效（与 harness client SDK 启动时一致）
  // 注：dsh_home/profiles/node_modules/@whalepod/honeycomb 是相对 symlink
  //     → ../../../../node_modules/@whalepod/honeycomb（OOB-1 symlink 归一化 510 条链之一）
  const honeycomb = require('/tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb');
  console.log('honeycomb module loaded:', typeof honeycomb);
  console.log('exports:', Object.keys(honeycomb).slice(0, 10));
"
# 期望：不抛 MODULE_NOT_FOUND，typeof honeycomb === 'object'（或 'function'），导出键非空
```

> 关键约束：`require` 必须走**装箱物理路径** `/tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb`，
> 不允许走开发环境 `node_modules`（如 `/Users/qzp/aion2dsh/HarnessShell/.build/checkouts/honeycomb/`）。

#### 步骤 3：plugin 已注册到 cordis runtime

```bash
node -e "
  const path = require('path');
  process.env.DSH_HOME = '$DSH_HOME';
  // 启动 harness client SDK（cordis loader），随后查 Honeycomb.project 表面
  // 注：honeycomb 包目前直接暴露根 export，未必有 ./client 子路径
  //     如失败降级为 require('@whalepod/honeycomb').start 或 runtime 相关入口
  const honeycomb = require('/tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb');
  console.log('honeycomb keys:', Object.keys(honeycomb).slice(0, 20));
  // 如果 honeycomb 暴露 start/cordis loader surface，直接调；否则查 profile seed 引导
  const profileSeed = require('/tmp/wp6.app/Contents/Resources/dsh_home/profiles/web/cordis.yml');
  console.log('profile seed loaded:', !!profileSeed);
"
# 期望：activePlugins 至少含 'honeycomb'（自身）+ 已注册的子插件（panel: ui-whalepod-team）
#      Honeycomb.project 含 ≥ 1 个已注册 surface（OOB-1 profile-seed-honeycomb.sh --register-panel
#      幂等 append 面板登记行 insert 块 id: ui-whalepod-team）
```

> 关键点: cordis 框架 `loader.activePlugins` 是 plugin 注册后的可信信号；`Honeycomb.project` 是 plugin 暴露的「表面」键空间（surface registration）。两者都非空即过。

#### 步骤 4：跨步骤一致性 — 装机实例 vs 开发实例版本对齐

```bash
# 开发环境读 manifest（pnpm workspace checkouts）
cat /Users/qzp/aion2dsh/HarnessShell/.build/checkouts/honeycomb/package.json | grep '"version"'
# 装箱产物读同字段（直接路径，因为 dsh_home/profiles/node_modules/@whalepod/honeycomb 是 symlink）
grep '"version"' /tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb/package.json
# 期望：两者完全一致（commit pin → box tarball 是只读快照）

# 面板比对
cat /Users/qzp/aion2dsh/HarnessShell/.build/checkouts/dsh-client-ui-whalepod-team/package.json 2>/dev/null | grep '"version"'
grep '"version"' /tmp/wp6.app/Contents/Resources/node_modules/@deepseek-ai/dsh-client-ui-whalepod-team/package.json
```

### 2.3 必过判据（fail loud）

| 子判据 | 失败时影响 | 反制 |
|---|---|---|
| 10.1 物理存在（步骤 1）| 用户运行实例无 honeycomb/panel → agent runtime 退化 | 重新跑 build-runtime.sh 同事务装箱（OOB-1 PANEL_TARBALL 显式传）|
| 10.2 可 import（步骤 2）| 启动时 MODULE_NOT_FOUND 崩溃 | 查 ESM 修复（c59125a）+ post-build fix-esm 是否生效；symlink 相对化（510 条链，codesign 前 3e 步）|
| 10.3 plugin 注册（步骤 3）| 表面登记为空 → agent 调不出接口 | 查 cordis loader 配置 + profile seed (f424501) + OOB-1 `--register-panel` 幂等 append 面板登记行（insert 块 id: ui-whalepod-team）|
| 10.4 版本对齐（步骤 4）| 开发/装箱 drift → 用户与开发行为不一致 | 重打 tarball，确保 build-runtime 在 git checkout 后跑 |

### 2.4 与守门链的顺序

1. **必须 1-9 全过**（继承 alpha.5 的 9 判据不变）
2. **10.1 → 10.2 → 10.3 串行**（物理存在才能 import，能 import 才能启动 SDK）
3. **10.4 可与 10.1 并行**（package.json 是静态文件，无依赖）

### 2.5 公开数据反推验证（mount-free 备选）

若 DMG mount 受阻或沙箱不允许，可用 `gh release download` 直接拉产物到 `/tmp` 后 `cp -R` 而不挂载：

```bash
mkdir /tmp/wp6-raw
gh release download v0.1.0-alpha.6 \
  --pattern 'WhalePod-0.1.0-alpha.6-macos-arm64.dmg' \
  --pattern 'WhalePod-0.1.0-alpha.6-macos-arm64-slim.zip' \
  --dir /tmp/wp6-raw
# DMG 是 sparsebundle-like，可用 7z 解（含 main executable + Resources）
# 或直接挂载 readonly
```

---

## 3. 守门执行时序

| T | 动作 | 责任人 |
|---|---|---|
| T-0 | engineering-Flash-4 提交 OOB-1 PR 并 merge | Flash-4 |
| T-0+30min | release.yml 自动跑（如果 tag 已推）→ 或 Leader 手动发版 | Leader |
| T+5min | GitHub Actions 完成 → 校验 判据 1-9 + 判据 10.1 | Leader |
| T+10min | Leader 拉产物做 10.2 + 10.3 真链验证 | Leader |
| T+15min | 公开数据反推 (gh API) 全套校验 | Leader |
| T+20min | 守门 PASS → alpha.6 公开；FAIL → 回滚 OOB-1 | Leader |

---

## 4. 关联

- **Part A**: `docs/cron-skip-investigation.md`（本任务主调查）
- **alpha.5 9 判据基线**: `project-release-version-injection-appcast.md` §守门判据全表
- **alpha.4 7 判据 PASS 记录**: `project-alpha4-milestone.md`
- **honeycomb 装箱 phase 2**: `project-honeycomb-packaging-phase2.md`
- **honeycomb 装箱 V1-V3 验证**: `reference-honeycomb-bundling-verification.md`
- **honeycomb 装箱设计卡**（解决中）: `project-honeycomb-not-in-release.md`
- **任务跟踪**: Task #01a00db2-7298-7ef2-b57e-695c8727c9bd