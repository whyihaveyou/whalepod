# 自动更新 M2 设计（下载 + 校验 + 替换 + 重启）

> Task #01a0086a · 实现-Pro-1 · 2026-08-16
> 状态：**设计定稿（不写实现）**，为公证 / Developer ID 落地后即可开工做准备。
> 边界：只新增 `docs/auto-update-m2.md`，不改任何源码。
> 上游事实对齐（均已真实落地）：Flash-1 `make-appcast.sh`（双 enclosure + 自定义 sha256）+ 版本灌入链 + `release.yml`（appcast 钩子 + DMG_NAME 对齐）→ alpha.4 已带真 appcast。

---

## 0. TL;DR（结论先行）

- **下载**：从 appcast 的最新 `<item>` 取**按本机安装档位选中的那条 enclosure**（Full → 下 DMG，Slim → 下 ZIP），URL 相对 → 拼 `releases/latest/download/<filename>`；**自定义 `sha256` 属性做完整性校验**（M1 parser 目前只取第一条 enclosure，M2 必须改造成「双 enclosure + 档位选择 + sha256」）。
- **ed25519 分级**：ad-hoc 阶段用 B 方案的 `sha256` 足够（HTTPS 通道下的私密源）；Developer ID / 公证落地后，正线换 Sparkle 的 `sparkle:edSignature`（ed25519 公钥验签，自带完整性+防伪，不再依赖 sha256 自定义属性）。两套字段不混用（make-appcast.sh 注释已明确这一点）。
- **替换**：新 bundle 落临时目录 → `codesign --verify` 校验 → **原子替换**。判断安装位置是否可写：可写（~/Applications 等）→ 进程内两段式直接换；不可写（/Applications，admin 所有）→ relaunch helper（提权）或提示手动。**Slim 档特殊**：zip 解压后是完整 .app，替换语义与 DMG 一致，只是在下载体量上列表不同；Slim 更新**不**做「解压覆盖运行中的 bundle」，仍走「整包替换」以保证签名/结构一致性。
- **重启与回滚**：替换后 relaunch；替换前把旧 bundle 改名保留为 `.bak`，新起失败自动回滚旧 bundle。
- **与 M1 衔接**：状态机 `available` 之后扩展 `downloading → ready → installing → relaunching`；banner 按钮从「打开 release 页」升级为「立即更新」（进下载/进度）；`error` 覆盖下载失败/校验失败/替换失败三类，UI 静默或提示。
- **M2 边界**：**不做增量/delta（二进制 diff）**；**不做完整签名链公证**（留给 Sparkle 正式集成）。M2 目标是「有更新→下载→校验→替换→重启」闭环可用，安全走「HTTPS + sha256」这一档。

---

## 1. 下载与校验

### 1.1 数据来源（现状已定）

appcast 由 `make-appcast.sh` 生成并随 release 上传，消费端固定读生产 URL：

```
https://github.com/whyihaveyou/whalepod/releases/latest/download/appcast.xml
```

每条 `<item>`（= 一次发版）结构（Flash-1 实测格式，BUILD 4 已上线）：

```xml
<item>
  <title>Version 0.1.0-alpha.4</title>
  <sparkle:shortVersionString>0.1.0-alpha.4</sparkle:shortVersionString>
  <sparkle:version>4</sparkle:version>
  <enclosure url="WhalePod-0.1.0-alpha.4-macos-arm64.dmg"    sparkle:version="4" length="..." type="application/octet-stream" sha256="<full_sha>"/>
  <enclosure url="WhalePod-0.1.0-alpha.4-macos-arm64-slim.zip" sparkle:version="4" length="..." type="application/octet-stream" sha256="<slim_sha>"/>
  <sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion>
</item>
```

关键点：
- **item 级**有 `sparkle:version`（=BUILD 号，判定主键）与 `sparkle:shortVersionString`（用户可见版本）。
- **两条 enclosure**（Full DMG + Slim ZIP），各自带 `length` + 自定义 `sha256` 属性。
- `url` 是 **release 资产文件名**（相对路径），消费端拼到 `releases/latest/download/` 前缀。

> 历史精确性注记：实际发布的 alpha.4 appcast 的 Full enclosure 是泛名 `HarnessShell.dmg`（手动档显式传 FULL_DMG=泛名，item 内 url===asset 名自洽）；示例中的品牌名 Full enclosure 自 **alpha.5 起**才生效（make-dmg.sh DMG_NAME 覆盖 + release.yml 对齐）。两档 item 各自内部自洽即可，M1 updater 按 item 内 url 拉取各能命中。

### 1.2 ⚠️ M1 parser 缺口（M2 必须改）

M1 `UpdaterService.parseAppcast*` 只抓**第一条** `<enclosure url>`（single urlRegex / `firstCapture`）→ 永远拿到 **Full DMG**。M2 需改为：

1. 每条 item 解析出**两条 enclosure**（Full + Slim），连同各自的 `sha256`、`length`。
2. **按本机安装档位选 enclosure**：
   - 档位判定：`.app` 内是否存在 `Contents/Resources/node`（bundled node）→ 存在 = Full（自举需要 node），不存在 = Slim。
   - 命中档 → 取该 enclosure 的 `url`（拼下载）与 `sha256`（校验）。
   - 兜底：档位匹配不到（appcast 里只有一条 / 版本混档）→ fallback 到 `releasePageURL`，提示用户去网页手动选，不擅自换档（沿用 §4.3 结论）。

### 1.3 下载

- HTTP GET `releases/latest/download/<filename>`，`URLSession.downloadTask`（系统写到临时文件，自动带进度）。
- **进度**：`URLSessionDownloadDelegate` 的 `didWriteData` 累计 → 回抛进度百分比（M2 UI 侧 banner 显示进度条）。
- **断点续传**：`URLSession` 的 `downloadTask(resumeData:)`；进入 `ready` 前中断 → 存 `resumeData`，下次继续。简单档：中断重下（Slim 1.x MB / Full 200+MB 取舍由 UI 提示）。**M2 先做「中断提示重下」，resumeData 续传列为可选增强**（控制复杂度）。
- **失败重试**：指数退避（1s→2s→4s 封顶 30s）、最多 3 次；HTTP 4xx/5xx 直接 fail（不重试 4xx）。

### 1.4 校验

- **主校验（ad-hoc/B 档，M2 就用它）**：计算下载文件 `sha256`，与 enclosure 的 `sha256` 属性比对；不匹配 → 删除缓存、判 `error`（校验失败），不进入替换。
- **ed25519 分级（预留，正线）**：Developer ID / 公证落地后，`make-appcast.sh` 追加 `sparkle:edSignature`（ed25519 对更新包签名，公钥打进 app）。此时校验 = 验签（自带完整性+来源认证），`sha256` 属性退为辅助。**两套字段不混用**（沿用 generator 注释约定）。M2 不实现 ed25519，只留 `UpdateInfo` 里一个「校验方案」枚举位（`sha256` / `ed25519`）以兼容未来。
- 校验通过才把下载文件移入「就绪」缓存目录（`~/Library/Application Support/WhalePod/updates/`），并记 `ready.manifest`（build、路径、sha256）。

---

## 2. 替换策略

### 2.1 通用形态（Full 与 Slim 共用同一路径）

标准「两段式 + 原子替换」（与 dsh-desktop / Sparkle 一致，避开 run-loop 中持锁替换的坑）：

1. **渲染就绪**：apk/unzip 目标 bundle 完整落在**临时目录**（`/tmp/WhalePod-update-<build>/WhalePod.app`）。
   - Full：挂载 DMG（`hdiutil attach -nobrowse -readonly`）→ 拷出 `.app` → 卸载。
   - Slim：解压 ZIP（`ditto -x -k`）→ 得到 `.app`。
2. **校验签名**：`codesign --verify --deep --strict <new>.app`（+ `spctl` 评估可选）。失败 → 判 `error`，不替换。
3. **原子替换**：
   - 目标位置 = 当前 `Bundle.main.bundlePath` 所在目录（用户在哪儿安装的就换哪儿，不假设 /Applications）。
   - 旧 bundle → 改名 `WhalePod.app.bak-<currentBuild>`（保留下滚），新 bundle → `mv` 到目标位 → 若目标位在**用户可写目录**直接覆盖；在 **/Applications（admin）** 需提权（见 §4）。
   - 成功后删除 `.bak`。

### 2.2 Slim 档 zip 语义（明确）

Slim 的 zip 解压出来是**完整 `.app`**（非增量包），所以替换语义与 Full 完全一致——**都是整包替换**：

- **不做**「解压覆盖运行中的 bundle contents」（那会破坏签名的资源哈希、且运行中文件被占用写不进）。
- **不做** run-loop 内原地覆盖。全部走「整包落临时目录 → 校验 → relaunch 后原子替换」。
- Slim 与 Full 的唯一区别是**下载体量**（1.1MB vs 206MB）与**档位选择**；替换、校验、回滚路径共享一套代码。
- **Slim 起服务快**（实测 npx 链 2.4s 起服务）——替换后 relaunch 到服务就绪的时间预算以此为准。

### 2.3 替换触发时机

- 用户点 banner「立即更新」→ 下载+校验 → 到 `ready` 态 → 提醒「将重启以应用更新」→ 确认 → relaunch 自替换。
- 非阻塞：默认不自动重启；重启发生在**显式确认**后（M2 阶段不做静默后台替换）。

---

## 3. 重启与回滚

### 3.1 relaunch helper 形态

macOS 自更新标准做法：主进程不能在自己运行中替换自己（`.app` 被占用/签名链中断），所以：

- 写一个**独立的轻量 helper**（很小，仅做「等你退出 → 交换 .app → 重新拉起」），作为 bundle 内资源或独立可执行。
- 流程：主进程把「新 .app 临时路径 + 目标路径 + relaunch 用 `open -a`」写进 helper 参数/plist → 用 `Process`/`NSTask` spawn helper（detached）→ 主进程 `terminate()`。
- helper：等主进程 PID 退出（watch）→ 执行替换（§2.1 原子替换）→ 回滚逻辑 → `open` 新 .app。
- 断电/崩溃恢复：helper 每次启动先检查「是否有待完成替换」（读 `updates/` 的 ready.manifest + `.bak` 存在）→ 有则补完，无则直接拉起新 app。给「重启首启时收尾」语义（对齐 proposal §7.3 两段式）。

### 3.2 回滚

- 替换前旧 bundle 改名保留 `.bak`。
- 若新 .app 校验后 `open` 失败 / 首启崩溃（helper 侧检测），或用户「无法打开」→ 用 `.bak` 换回，删除新 bundle。
- helper 内回滚优先（不依赖主进程），失败近因=`.bak` 仍在则下次启动再试。
- 成功跑起后清 `.bak` 与 `updates/` 缓存。

---

## 4. 权限（两档判定）

### 4.1 判定

`Bundle.main.bundlePath` 所在目录是否可写：

```text
if FileManager.default.isWritableFile(atPath: installDir) → 用户可写目录
else → 系统级目录（/Applications，admin 所有，需提权）
```

`~/Applications`、`~/Downloads`、`~/Desktop`、`~` 下自建目录都属**可写档**；`/Applications` 属**提权档**（除非用户曾给过该目录写的授权，或 app 以 admin 权限运行）。

### 4.2 可写档（免提权，M2 主路径）

- 默认情况：用户装到 `~/Applications` 或自己选的目录 → 进程内直接原子替换（§2.1），无需授权弹窗。
- **产品引导**：安装指引 / 首启提示里强烈建议装到 `~/Applications`，把绝大多数用户带到免提权路径——这与 proposal §7.1 结论一致，且显著降低复杂度与风险。

### 4.3 提权档（/Applications）

- 现状取舍：`AuthorizationExecuteWithPrivileges`（`Security.framework`，已废弃但 macOS 仍可用）+ `SMJobBless`（正式但需要 fabric 链条较重的 helper 安装）。两者在 ad-hoc 自签下都偏重，且非公证 app 的授权弹窗对普通用户不友好。
- **M2 方案**：**不做提权自动替换**。当目标位不可写时降级为——下载+校验照做，但替换走「引导用户：提示把 .app 拷到 /Applications 或授权」，或直接打开 release 页手动更新（同 proposal P3 的保守兜底）。
- **明确**：提权自动替换（`AuthorizationExecuteWithPrivileges`/`SMJobBless`）留到 Developer ID + 公证后随 Sparkle 正式集成一并做（Sparkle 的 `SPUStandardUpdaterController` 天然处理 /Applications relocating + 提权）。M2 不实现提权，避免在 ad-hoc 下引入高风险代码路径。
- **两档判定输出**一张表放入实现参考：可写 → 进程内替换；/Applications → 提示手动/引导装用户目录。

---

## 5. 与 M1 的衔接（状态机扩展）

### 5.1 现状（M1, UpdaterService.swift）

```text
idle → checking → available(UpdateInfo) → upToDate
                  → error（拉取/解析失败，静默）
disabled（配置关 / 开发模式）
```

`UpdateInfo { version, build, downloadURL, releaseURL }`；`downloadURL` 目前是**第一条 enclosure**（M2 修正为档位命中）。

### 5.2 M2 扩展

```text
idle → checking → available(UpdateInfo{tier, sha256, downloadURL, length})
              ↘ downloadable：用户点「立即更新」→ downloading(progress)
                   → verified → ready(本地就绪路径)
                        → installing：显式确认 → relaunch（helper 收尾替换）
              ↘ error（细分下载失败 / 校验失败 / 替换失败 / 目标不可写）
```

- `available` 时 `UpdateInfo` 需补：`tier`（full/slim）、`expectedSHA256`、`downloadURL`（档位命中后）、`length`、`verifyScheme(.sha256/.ed25519)`。
- 新增状态：`downloading(progress: Float)`、`ready`、`installing`、`relaunching`。
- banner 按钮语义升级：available → **「立即更新」**（进 downloading）；downloading → 显示进度条 + 可取消（中断重下）；ready → **「重启安装」**；installing/relaunching → 显示「重启中…」。
- `error` 三态细分（下载/校验/替换），UI 只对**明确可恢复**的（如网络失败→重试按钮）提示，其余静默 + 记日志。
- 复用 M1 的调度（延时/jitter/周期/电源恢复）到「检查」不变；下载/替换是用户主动触发，不走周期。

---

## 6. M2 边界（明确不做）

1. **不做增量 / 二进制 diff（delta）**：每次全量下载（Full 206MB / Slim 1.1MB）。Slim 便宜，Full 偏贵——后续可加 HTTP Range 差分（幂等+进度），本期不做。
2. **不做完整签名链公证**：无 Developer ID、无 notarize。签名链正式化（公证 + Sparkle ed25519 正式集成 + /Applications 提权自动替换）全部**留给 Sparkle 正式集成**这条正线。
3. **不做静默后台替换**：替换必须显式确认；不做无人值守自动重启。
4. **不做断点续传的强制实现**：中断→提示重下；`resumeData` 续传列为可选增强。
5. **不做提权自动替换**：/Applications 目标位降级为「引导手动/装用户目录」。
6. **不改 M1 的检查调度与 packaged-only**：只扩展 available 之后的下载/替换态。

---

## 7. 风险与验收建议

- **替换失败/中断**：两段式 + `.bak` 回滚 + helper 首启收尾兜底（§3）。
- **非公证 Gatekeeper**：替换后的 .app 从「已信任 context」写入，通常不触发重评估（electron-updater 设 `gatekeeperAssess:false` 同理）；但 ad-hoc 签名在替换后需保持有效（`codesign --verify` 校验）。实现期**必须真机跑一次「替换后双击能正常开」**（proposal §7.5 待办）。
- **Slim 用户**：新版本若加了 bundled node / 换档（Slim→Full 语义变化），按 §1.2 兜底提示去网页手动选，不擅自换档。
- **验收建议（实现期）**：① fixture appcast（双 enclosure + sha256）→ 有新版 → 下载 → sha256 校验通过/失败两分支；② Slim 与 Full 各自命中正确 enclosure；③ 目标位可写 → 替换+重启成功 + `.bak` 回滚注入失败场景；④ /Applications 不可写 → 走引导分支不崩；⑤ `codesign --verify` 对替换后 .app 通过。

---

## 8. 交付清单

- [x] `docs/auto-update-m2.md`（本文档）
- [ ] （实现期）UpdaterService 扩展 + DownloadManager + RelaunchHelper（M2 实现卡，等公证/Developer ID 落地或 Leader 排期）

> 参考：`docs/auto-update-proposal.md`（选型/通道/风险）、`spikes/auto-update/`（fixture）、`HarnessShell/Sources/HarnessShell/UpdaterService.swift`（M1 现状）、`HarnessShell/Scripts/make-appcast.sh`（双 enclosure + 自定义 sha256）、`docs/auto-update-m1.md`（M1 交付）。
> 设计定稿，自 commit（推送归 Leader）。
