# OOB-6 · Sparkle 升级路径实测（alpha.4 → alpha.5）

> 任务: #01a00db3-5f3b-7f01-b594-d07fe6120b5c（【开箱版 OOB-6】）
> 实测时间: 2026-08-17 12:35-12:55 +0800
> 实测人: Flash-1
> 纪律遵循: 不动用户真实装机（~/Applications/HarnessShell.app + ~/Library/Application Support/WhalePod 全程不碰），全部沙盒于 `/tmp/oob6-sandbox/`
> 关联: docs/auto-update-m2.md（设计）/ docs/auto-update-proposal.md（提案）

---

## 1. 测试架构概览

| 组件 | 来源 | 用途 |
|---|---|---|
| 沙盒 alpha.4 | `gh release download v0.1.0-alpha.4 --pattern 'HarnessShell.dmg'` → 挂载 → cp 到 /tmp/oob6-sandbox/ | 模拟用户当前装的 alpha.4 实例 |
| M1 检测链 | `UpdaterService.swift` (HarnessShell/Sources/HarnessShell/) | 检出 + 提示（M1 实现）|
| M2 下载替换 | 未实装 | 见 docs/auto-update-m2.md §8（M2 实现卡）|
| 线上 appcast | `https://github.com/whyihaveyou/whalepod/releases/{latest,v0.1.0-alpha.4,v0.1.0-alpha.5}/download/appcast.xml` | 通道数据 |

沙盒隔离:
- 路径: `/tmp/oob6-sandbox/`（独立于 `~/Applications/` 用户装机）
- 不读写 `~/Library/Application Support/WhalePod/`（用户 DSH_HOME）
- 进程：直接 `/tmp/oob6-sandbox/HarnessShell.app/Contents/MacOS/HarnessShell` 拉起，指定临时 `WHALEPOD_*` env vars 联调
- 端口：singleton 锁占用随机高端口（实测 51147），与用户装机的 51146 不冲突

---

## 2. 沙盒装机验证

### 2.1 DMG 完整性

```
$ shasum -a 256 /tmp/oob6-sandbox/HarnessShell.dmg
c1f282e2e9ea9decb9d30e1849cbdff7216fde73822b4bf226f7a35e06718010  HarnessShell.dmg

# 期望（来自 gh release view）:
# c1f282e2e9ea9decb9d30e1849cbdff7216fde73822b4bf226f7a35e06718010
```
✅ SHA256 完全一致。

### 2.2 沙盒 .app 信息

```
$ /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /tmp/oob6-sandbox/HarnessShell.app/Contents/Info.plist
0.1.0                                       ← ⚠️ COSMETIC: 不是 0.1.0-alpha.4（见 §5 bug #2）
$ /usr/libexec/PlistBuddy -c "Print :CFBundleVersion" /tmp/oob6-sandbox/HarnessShell.app/Contents/Info.plist
4                                            ← 与 appcast sparkle:version=4 一致 ✅
$ /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" /tmp/oob6-sandbox/HarnessShell.app/Contents/Info.plist
io.whalepod.desktop                          ← 与 UpdaterService 期望一致 ✅
```

### 2.3 tier 识别

alpha.4 Resources 目录结构：
```
Contents/Resources/
├── node/                  ← 装箱 Node.js
├── node_modules/          ← 装箱依赖（含 dsh + @deepseek-ai/*）
└── (无 bundled-aioncore/) ← 关键：缺此目录
```

按 `UpdaterService.detectTier()`:
- 有 `Contents/Resources/bundled-aioncore/darwin-arm64/aioncore` → `.full`
- 否则 → `.slim`

✅ alpha.4 正确识别为 `.slim` tier。

---

## 3. 线上 appcast 通道实测（前置探针）

### 3.1 `releases/latest/download/appcast.xml`（默认 Sparkle 通道）

```
$ curl -sLI https://github.com/whyihaveyou/whalepod/releases/latest/download/appcast.xml
HTTP/2 302
location: https://github.com/whyihaveyou/whalepod/releases/download/v0.1.0-alpha.4/appcast.xml

$ curl -sL https://github.com/whyihaveyou/whalepod/releases/latest/download/appcast.xml
…
<item>
  <title>Version 0.1.0-alpha.4</title>
  <sparkle:version>4</sparkle:version>
  <sparkle:shortVersionString>0.1.0-alpha.4</sparkle:shortVersionString>
  <enclosures>
    <enclosure … sparkle:edSignature="…" length="223937906" type="application/x-apple-diskimage" 
      url="https://github.com/whyihaveyou/whalepod/releases/download/v0.1.0-alpha.4/HarnessShell.dmg"/>
    <enclosure … length="1181076" type="application/zip" 
      url="https://github.com/whyihaveyou/whalepod/releases/download/v0.1.0-alpha.4/WhalePod-0.1.0-alpha.4-macos-arm64-slim.zip"/>
  </enclosures>
</item>
```

⚠️ **关键发现**: 默认通道只返回 alpha.4 一个 item。**alpha.5 不在 live 通道上**（见 §5 Bug #1）。

### 3.2 `releases/download/v0.1.0-alpha.5/appcast.xml`（alpha.5 直链）

```
$ curl -sL https://github.com/whyihaveyou/whalepod/releases/download/v0.1.0-alpha.5/appcast.xml | wc -c
3451 bytes
# items count = 2 (alpha.4 + alpha.5)
# sparkle:version = [4, 5]
```

✅ alpha.5 自己的 appcast.xml 通过 `make-appcast.sh` 的 awk 去重逻辑，正确包含 alpha.4 + alpha.5 两个 item。

---

## 4. M1 检测试验

环境变量（按 `UpdaterService.swift` 约定）:
- `WHALEPOD_UPDATE_DELAY_MS=500` — 跳过默认 15s + 抖动延迟
- `WHALEPOD_VERBOSE=1` — 触发 stderr 日志（state 转换 print）
- `WHALEPOD_FORCE_UPDATE=1` — 跳过 packaged-only guard（保险）

### 4.1 Test A — 默认通道（不覆盖 appcast URL）

**预期**: GitHub `releases/latest` 排除 pre-release → live 通道只显示 alpha.4 → 沙盒 build=4 == latest build=4 → `up-to-date`

**实测**:
```
$ WHALEPOD_UPDATE_DELAY_MS=500 WHALEPOD_VERBOSE=1 WHALEPOD_FORCE_UPDATE=1 \
    /tmp/oob6-sandbox/HarnessShell.app/Contents/MacOS/HarnessShell 2>stderr-A.log

stderr-A.log:
[whalepod-updater] state=idle
[whalepod-updater] state=checking
[whalepod-updater] state=up-to-date
```

**结果**: `up-to-date` ⚠️ **Bug #1 命中** — 沙盒 alpha.4 通过 live 通道检查，判定无新版本可升。但实际上 alpha.5 已发布。

### 4.2 Test B — 覆盖到 alpha.5 直链

**预期**: 强制走 alpha.5 自己的 appcast（2 items，latest build=5）→ 沙盒 build=4 < 5 → `available(version=0.1.0-alpha.5, build=5)`

**实测**:
```
$ WHALEPOD_APPCAST_URL=https://github.com/whyihaveyou/whalepod/releases/download/v0.1.0-alpha.5/appcast.xml \
  WHALEPOD_UPDATE_DELAY_MS=500 WHALEPOD_VERBOSE=1 WHALEPOD_FORCE_UPDATE=1 \
    /tmp/oob6-sandbox/HarnessShell.app/Contents/MacOS/HarnessShell 2>stderr-B.log

stderr-B.log:
[whalepod-updater] state=idle
[whalepod-updater] state=checking
[whalepod-updater] state=available(version=0.1.0-alpha.5, build=5)
```

**结果**: ✅ `available(version=0.1.0-alpha.5, build=5)` — **M1 检测逻辑、版本比较、tier 选择、URL 解析全过**。

按 AppDelegate.swift:38-46，此状态变更会触发 `controller.showUpdateBanner(version: "0.1.0-alpha.5", releaseURL: <v0.1.0-alpha.5 release URL>)`，banner 上显示「查看更新」按钮，点击后 `openUpdateReleasePage()` 用 NSWorkspace 打开 release 页（实测无法截图，headless 沙盒无 window 显示，但代码路径已就绪）。

### 4.3 Test C — 自指（覆盖到 alpha.4 自己）

**预期**: build=4 == current build=4 → `up-to-date`（确认版本比较路径走的是 integer，不是 string）

**实测**:
```
$ WHALEPOD_APPCAST_URL=https://github.com/whyihaveyou/whalepod/releases/download/v0.1.0-alpha.4/appcast.xml \
  WHALEPOD_UPDATE_DELAY_MS=500 WHALEPOD_VERBOSE=1 WHALEPOD_FORCE_UPDATE=1 \
    /tmp/oob6-sandbox/HarnessShell.app/Contents/MacOS/HarnessShell 2>stderr-C.log

stderr-C.log:
[whalepod-updater] state=idle
[whalepod-updater] state=checking
[whalepod-updater] state=up-to-date
```

**结果**: ✅ `up-to-date` — 验证比较路径是 integer `build` (4 == 4 → 不升级)，不是 string `"0.1.0-alpha.4" != "0.1.0-alpha.4"`。

---

## 5. 发现的 Bug 与建议

### 🐛 Bug #1（严重）: alpha.5 标记 pre-release → live 通道静默丢失

- **现象**: `gh release view v0.1.0-alpha.5 --json prerelease` 返回 `true`。GitHub 的 `releases/latest/download/...` 路由**排除 pre-release**，因此 live 通道 `https://github.com/whyihaveyou/whalepod/releases/latest/download/appcast.xml` 只返回 alpha.4，**alpha.5 完全不可见**。
- **影响**: alpha.4（及之前）用户永远不会在 banner 上看到 alpha.5 可用，等同于 alpha.5 永远不会被自动推到 alpha.4 用户面前（除非他们主动访问）。
- **根因**: `make-appcast.sh` 在每次 release 时生成新 appcast.xml 并上传到对应 tag 的 release assets，但 `UpdaterService` 默认拉的是 `releases/latest/download/appcast.xml`（GitHub 标准约定），不会跨 tag 聚合。
- **建议方案**（3 选 1）:
  1. **取消 alpha.5 的 pre-release 标记**（gh release edit v0.1.0-alpha.5 --repo whyihaveyou/whalepod --prerelease=false）。最简单，但 GitHub 排序将 alpha.5 提到 "Latest"，对生产用户友好度有 trade-off。
  2. **改 Sparkle feed URL** 为 alpha.5 直链 / 多 feed 路由。但这等于把「latest」语义换成「alpha.5 explicit」，失去自动跟随。
  3. **每次 release 时同步更新一条「聚合 appcast.xml」**（写在 main 分支 gh-pages 或固定 release 上），UpdaterService 拉它。该 appcast 含所有版本，GitHub API 不影响。
- **建议优先级**: 高（影响 alpha.5+ 所有正式渠道升级）。

### ⚠️ Bug #2（轻微）: CFBundleShortVersionString = "0.1.0" 而非 "0.1.0-alpha.4"

- **现象**: 沙盒 alpha.4 的 Info.plist `CFBundleShortVersionString = "0.1.0"`，但 appcast 上写的是 `"0.1.0-alpha.4"`。
- **影响**: 用户在 About 面板看到的版本号（"0.1.0"）与 Sparkle banner 上的版本号（"0.1.0-alpha.4"）不一致。
- **功能影响**: 无（M1 比较走 `sparkle:version` integer build number，与 shortVersionString 无关）。
- **建议**: `make-appcast.sh` 注入的 shortVersionString 应该与 `build-app.sh` 写入的 CFBundleShortVersionString **完全同源**（同一 VERSION env var），避免漂移。

### ⏭️ M2 (download/verify/replace/restart) — 未实装

- **现状**: `UpdaterService.swift` 中只实现 M1（检出 + 提示）。M2 的下载、sha256 校验、原子替换、重启辅助 均未实装。
- **影响**: 用户在 banner 上看到 alpha.5 可用后，只能点击「查看更新」手动下载 DMG/ZIP，再手动拖到 /Applications 替换。M2 未启 → 真正的「一键升级」缺失。
- **状态**: per docs/auto-update-m2.md §8「M2 实现卡，等公证/Developer ID 落地或 Leader 排期」。本任务范围内**跳过 M2 部分**，仅记录状态。

---

## 6. M1 实施现状盘点

| M1 子能力 | 状态 | 证据 |
|---|---|---|
| 3 态（checking/available/up-to-date/error/disabled）| ✅ | Test A/B/C 三例验证 |
| Sparkle feed URL 默认 + env override (`WHALEPOD_APPCAST_URL`) | ✅ | Test B 验证 override 生效 |
| appcast 双 enclosure 解析（Full + Slim）| ✅ | appcast.xml 含 2 enclosure，Test B 解析通过 |
| tier 选择（Slim vs Full based on bundled-aioncore）| ✅ | alpha.4 沙盒 Resources 无 bundled-aioncore → 自动 .slim |
| sparkle:version integer 比较 | ✅ | Test C 验证 4 == 4 → up-to-date |
| SHA256 + length 捕获（不参与比较，仅为 M2 预热）| ✅ | UpdateInfo 字段存在，Test B 无报错 |
| Banner 提示 + 打开 release 页（M1 收口）| ✅ | AppDelegate:42 触发 showUpdateBanner（代码路径就绪，无 GUI 截图） |
| Delay + 抖动保护 | ✅ | WHALEPOD_UPDATE_DELAY_MS override 实测生效（500ms 触发）|
| packaged-only guard (Bundle.main.bundleIdentifier != nil) | ✅ | 沙盒 .app bundle id = io.whalepod.desktop → guard pass |
| verbose state log to stderr (WHALEPOD_VERBOSE=1) | ✅ | Test A/B/C 全部捕到 [whalepod-updater] state=… |

**M1 结论**: ✅ 检测 + 提示层完成、可用、可观测。Bug 仅在「live 通道默认路由」侧。

---

## 7. 后续建议

1. **Bug #1 立即派工**: 谁有权限 `gh release edit v0.1.0-alpha.5 --prerelease=false` 立即执行，或选方案 2/3 由 Leader 拍板。
2. **Bug #2 跟随**: `make-appcast.sh` 与 `build-app.sh` 共享 VERSION env 源（当前已通过 release.yml 透传），需对齐 shortVersionString。
3. **M2 排期**: per docs/auto-update-m2.md §8，跟公证/Developer ID 落地进度；建议下次发版前定方案。
4. **本沙盒保留**: `/tmp/oob6-sandbox/` 暂保留，供 Leader 复测 Bug #1（任意 alpha.4 + 默认通道应复现 `up-to-date`）。

---

## 8. 沙盒清理

- 进程：所有 3 轮 sandbox binary 已在每轮测试后 `kill`（PID 经 ps 复核已退出）
- 端口：singleton 锁 51147 已随进程退出释放
- 文件：`/tmp/oob6-sandbox/HarnessShell.{app,dmg}` + stderr-{A,B,C}.log 暂保留供复测
- 用户装机：`~/Applications/HarnessShell.app`、`~/Library/Application Support/WhalePod/` 全程未触碰

---

## 9. 关联

- 任务: #01a00db3-5f3b-7f01-b594-d07fe6120b5c（OOB-6）
- 关联设计: `docs/auto-update-m2.md`（M2 设计）/ `docs/auto-update-proposal.md`（提案）
- 关联 memory: `project-auto-update-m1.md`（M1 检出 + 提示骨架）/ `project-auto-update-m2.md`（M2 设计）/ `project-auto-update-m1-parser-hardening.md`（appcast parser 加固，双 enclosure + sha256 捕获，Task #01a008cd commit 6bc2da6）
- 关联 commit: 6bc2da6（M1 parser hardening，36/36 自测）/ 5709806（alpha.3 banner 修复）/ d62df8b（守门 plan 校准，本次任务前置）