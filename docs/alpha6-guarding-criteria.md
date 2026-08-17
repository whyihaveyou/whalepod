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
# 关键修正：boxed honeycomb package.json type=module，根导出是 ESM only
# CJS require() 会 ERR_PACKAGE_PATH_NOT_EXPORTED 或 ERR_REQUIRE_ESM，必须用 ESM import
# 入口形态：根模块导出 63 keys，含 createHoneycombClient / createOrchestrationLoop /
#          apply() 等；./client 子路径不存在

cat >/tmp/oob6-honeycomb-import.mjs <<'EOF'
import * as hc from '/tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb/lib/index.js';
console.log('typeof hc:', typeof hc);
console.log('exports count:', Object.keys(hc).length);
console.log('has apply:', typeof hc.apply === 'function');
console.log('has createHoneycombClient:', typeof hc.createHoneycombClient === 'function');
console.log('has createOrchestrationLoop:', typeof hc.createOrchestrationLoop === 'function');
EOF
node /tmp/oob6-honeycomb-import.mjs
# 期望：全部 true（hc 是 ESM object，含 apply + 两个具名导出）
```

> 关键约束：`import` 必须走**装箱物理路径** `/tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb/lib/index.js`，
> 不允许走开发环境 `node_modules`（如 `/Users/qzp/aion2dsh/HarnessShell/.build/checkouts/honeycomb/`）。
> CJS `require()` **不可用**（type=module），不要尝试。

#### 步骤 3：honeycomb apply 到 cordis runtime（裸 cordis 层）

```bash
# 关键修正：boxed @deepseek-ai/cordis ^4.0.1 只导出 Context/Service/Fiber/Inject 等 primitives
# 不导出 Loader / Plugin API；honeycomb apply() 直接调，root 模块本身就是 cordis plugin

cat >/tmp/oob6-honeycomb-apply.mjs <<'EOF'
import { Context } from '/tmp/wp6.app/Contents/Resources/node_modules/@deepseek-ai/cordis/lib/index.js';
import * as hc from '/tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb/lib/index.js';

const ctx = new Context();
await hc.apply(ctx, {
  transport: { host: '127.0.0.1', port: 0 },
});
// apply 后预期：5 个 Service 装配到 ctx
const expect = ['hive', 'roster', 'courier', 'ledger', 'mandate'];
for (const name of expect) {
  const svc = ctx.get(name);
  console.log(`service ${name}: ${svc ? '✓ present' : '✗ MISSING'}`);
}
await ctx.dispose();
EOF
node /tmp/oob6-honeycomb-apply.mjs
# 期望：5 行全部 ✓ present（hive/roster/courier/ledger/mandate）
```

> **不要尝试** `ctx.loader.activePlugins` 或 `ctx.plugin()` —— 盒上 boxed cordis 是纯 primitives，
> 这些 API 来自 dsh 运行时的 cordis-plugin-loader 层，**不在 cordis 包面上**。

#### 步骤 3b：loader 注册层（产物侧断言）

```bash
# loader 层的注册证据不能在裸 cordis 上跑，要靠 boxed dsh --dump-config 合成输出
# boxed dsh 应在 /tmp/wp6.app/Contents/Resources/node_modules/@deepseek-ai/dsh/bin/dsh.js

DSH_BIN=/tmp/wp6.app/Contents/Resources/node_modules/@deepseek-ai/dsh/bin/dsh.js
$DSH_BIN --profile web --dump-config 2>/tmp/oob6-dsh-stderr.log >/tmp/oob6-dsh-config.json
# 期望：JSON 含 honeycomb 条目（panel 也在 insert 块 id: ui-whalepod-team）
jq '.plugins[] | select(.name == "honeycomb")' /tmp/oob6-dsh-config.json
jq '.plugins[] | select(.name == "ui-whalepod-team")' /tmp/oob6-dsh-config.json
# 期望：两条 jq 输出均非空（honeycomb + 面板均被 loader 解析并注册）
```

> 这一层验证「loader 实际能解析到 honeycomb + 面板」，是步骤 3 裸 cordis 验证的补充。
> 如果两步都过，说明 plugin 既能被 cordis 直接 apply，又能被 dsh 的 loader 正确发现+注册。

#### 步骤 4：跨步骤一致性 — 装机实例 vs 开发实例版本对齐

```bash
# 开发环境读 manifest（pnpm workspace checkouts）
cat /Users/qzp/aion2dsh/HarnessShell/.build/checkouts/honeycomb/package.json | grep '"version"'
# 装箱产物读同字段
grep '"version"' /tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb/package.json
# 期望：两者完全一致（commit pin → box tarball 是只读快照）

# 面板比对
cat /Users/qzp/aion2dsh/HarnessShell/.build/checkouts/dsh-client-ui-whalepod-team/package.json 2>/dev/null | grep '"version"'
grep '"version"' /tmp/wp6.app/Contents/Resources/node_modules/@deepseek-ai/dsh-client-ui-whalepod-team/package.json

# 依赖核对（honeycomb package.json 期望 deps: agentclientprotocol/sdk + ws; peers: cordis + schemastery）
jq '.dependencies, .peerDependencies' /tmp/wp6.app/Contents/Resources/node_modules/@whalepod/honeycomb/package.json
# 期望：deps 含 @agentclientprotocol/sdk ^1.3.0 + ws ^8.21.3
#       peers 含 @deepseek-ai/cordis ^4.0.1 + @deepseek-ai/schemastery ^3.18.1
```

### 2.3 必过判据（fail loud）

| 子判据 | 失败时影响 | 反制 |
|---|---|---|
| 10.1 物理存在（步骤 1）| 用户运行实例无 honeycomb/panel → agent runtime 退化 | 重新跑 build-runtime.sh 同事务装箱（OOB-1 PANEL_TARBALL 显式传）|
| 10.2 可 import（步骤 2）| 启动时 MODULE_NOT_FOUND 崩溃 | 查 ESM 修复（c59125a）+ post-build fix-esm 是否生效；symlink 相对化（510 条链，codesign 前 3e 步）|
| 10.3 plugin 注册（步骤 3 + 3b）| cordis apply 后 5 Service 未装配 / loader dump-config 无 honeycomb 条目 → agent 调不出接口 | ① 裸 cordis 层：hc.apply(ctx, config) 后 hive/roster/courier/ledger/mandate 全装配；② loader 层：boxed dsh --profile web --dump-config 合成含 honeycomb 条目（产物侧 3d 断言）；③ profile seed (f424501) + OOB-1 `--register-panel` 幂等 append 面板登记行（insert 块 id: ui-whalepod-team）|
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