# 自动更新调研 + 骨架（ad-hoc 签名下的 appcast 更新通道）

> Task #01a00567 · 实现-Pro-1 · 2026-08-15
> 状态：**调研 + 最小验证已完成，选型待 Leader 拍板后进实现**
> 边界遵守：本任务只产出 `docs/` + `spikes/`，**未碰 Sources/**。

## 0. TL;DR（结论先行）

- **推荐选 B（自研轻量 updater 骨架），形态借鉴 dsh-desktop 的 electron-updater 状态机，但协议走 appcast.xml（Sparkle 2 兼容格式）**。
  理由：我们的签名是 ad-hoc（无 Developer ID、无公证），Sparkle 2 虽支持 EdDSA 签更新包，但它在 /Applications 站点下做替换需要权限处理，且引入一整套 Objective-C framework 与我们的「轻量壳 + 每日 alpha」节奏不匹配；自研轻量版协议简单、可在发版时随产物一把生成、Slim/Full 双档都好接。
- **但实现路径不唯一**，A（Sparkle2）在有正式 Developer ID 后再启用即可，本方案文档同时给出两档，Leader 拍板选 A 或 B。
- **有一个阻塞性前置改造点（必须先于任何选型解决）**：`CFBundleShortVersionString / CFBundleVersion` 在发版时需要**每次递增并落入 .app 的 Info.plist**，否则任何 updater 都永远判定「已最新」。详见 §5。

---

## 1. 背景与目标

- 产品：WhalePod（鲸群）macOS 桌面壳（Swift + WKWebView 包裹 DeepSeek Harness）。
- 现状：每日 20:00 cron 自动发版（alpha 序列，如 `v0.1.0-alpha.3`），发布在 GitHub Releases（Full DMG ~206MB + Slim ZIP ~1.1MB 双档）。
- 痛点：用户每天手动去 GitHub 下 DMG，很累。开箱即用最后一块短板 = 自动更新。
- 目标：app 启动后能自动检查 GitHub Releases 上的新版本，检出「有新版」→ 提示下载（本骨架阶段**不求真替换 .app**）。

## 2. 参照形态：refs/dsh-desktop 的 update 模块（Electron 路线）

借鉴形态，不抄实现（Electron vs Swift）：

| dsh-desktop（electron-updater） | 我们可借鉴的点 |
|---|---|
| `update-manager.ts`：状态机 idle→checking→available/progress→downloading→downloaded/up-to-date/error/unsupported，瞬态 8s 自动复位 | **更新状态机形态**（Swift 侧照搬这套 transition） |
| `update-policy.ts`：启动延时 15s + jitter 15s；周期检查 6h；电源恢复后若已过间隔则补检查 | **检查节奏策略**（防启动卡顿 + 不扰民） |
| `electron-builder` 生成 per-arch YAML（url/sha512）→ `merge-mac-update-metadata.mjs` 合并 | **发版时顺手生成 appcast 元数据**（我们是 shell 脚本，不是 builder） |
| GitHub Releases provider | **通道载体用 GitHub Releases**（我们已在用） |
| 下载最新 → diff/zip → `quitAndInstall` 进程内替换 .app contents | **替换形态**：Swift 侧 = 重启后自替换（见 §7 风险） |
| `supportsAutoUpdates` = packaged && darwin | 打包模式才走更新；开发模式跳过 |
| 非公证场景 `gatekeeperAssess: false` | **非公证 app 的关键**：自替换后不要每次触发 Gatekeeper 重评估 |

结论：dsh-desktop 的「状态机 + GitHub Releases + 启动/周期检查策略 + 进程内替换」这套**形态**我们 1:1 借鉴，只是传输协议从 electron-updater 的 per-arch yaml 换成更标准的 appcast.xml（Sparkle 2 兼容）——这样以后想切 Sparkle 也不用重做通道。

## 3. 选型：A（Sparkle 2）vs B（自研轻量）

### A. Sparkle 2
- **优点**：macOS 事实标准；成熟（下载/断点/安全（EdDSA 签 delta）/UI（系统通知 + 升级窗））；`sparkle:version` 用整数 build 排序、语义清晰。
- **ad-hoc 自签的现实路径**：Sparkle 2 不要求 Developer ID，可用 **EdDSA 密钥（`generate_keys` → `sign_update`）签更新包**，把公钥打进 app。**但它仍要处理替换**：
  - app 在 /Applications（admin 所有）→ 替换需要提权（Sparkle 自带的 `SPUStandardUpdaterController` 在 relaunch 阶段做替换，非可写站点会请求授权/弹窗）。ad-hoc 自签 app 在有权限弹窗时表现不够顺滑。
  - 引入一整个 Objective-C framework（二进制 + 签名），与「轻量壳」当前形态冲突；我们的 daily alpha 每出一个版本都要 EdDSA 重签一次 delta，通道成本比 B 高。
- **何时值得**：拿到正式 Developer ID + 公证后，换 Sparkle 是显然最优（它有签名公证链路最好的配合）。

### B. 自研轻量 updater 骨架（推荐）
- **协议**：appcast.xml（Sparkle 2 兼容格式，见下）。
- **流程**：启动延时+抖动后，拉 appcast → 按 build 号找最新 → 与本地 CFBundleVersion 比 → 有新版发通知 → 用户确认 → 下载到缓存 → 校验 sha256 → 重启后自替换。
- **复杂度可控**：因为**不生产 delta**（每日 alpha，DMG 体量直接全量下也行；或下 HTTP Range 差分——先不做），骨架只做「检出版本」。
- **通道成本最低**：发版时 shell 脚本顺手 append 一条 item 到 appcast.xml 并随 release 上传即可，与现有 make-dmg/make-slim/release 一套串起来。
- **Slim/Full 双档**：各自维护一条 item（同一 appcast，不同 enclosure url），按用户装的是哪个档下哪个。简化版：都指向 Full DMG 也成立（Sl 用户更新后变 Full，但会多下载——记入风险）。

> **拍板建议（B）**：本骨架阶段按 B 推进，appcast 用 Sparkle 2 格式，**未来切 A 零通道成本**（格式同源）。若 Leader 想一步到位上 Sparkle 也行，我按 A 出实现清单，但建议留给「有公证」之后。

## 4. appcast 通道设计

### 4.1 产物形态（发版时生成）
`appcast.xml`（站点根 / GitHub Release asset 均可）：

```xml
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <title>WhalePod 更新通道</title>
    <item>
      <title>Version 0.1.0-alpha.5</title>
      <sparkle:shortVersionString>0.1.0-alpha.5</sparkle:shortVersionString>
      <sparkle:version>5</sparkle:version>   <!-- CFBundleVersion，严格递增 build -->
      <enclosure url="WhalePod-0.1.0-alpha.5-macos-arm64-full.dmg" sparkle:version="5" length="..." type="application/octet-stream"/>
      <sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion>
    </item>
    <!-- …每次发版往里 append 一条最新 item，旧的可留可清 -->
  </channel>
</rss>
```

- `sparkle:version` = **build 号（CFBundleVersion）**，作为排序/判定主键（避开 semver 预发/稳定歧义，§6）。Slim 与 Full 的 build 号**共用同一递增序列**（同一发版 = 同一 build）。
- 真实部署 sha256 写进 item（本骨架未列，实现时加 `sparkle:edSignature`/sha256 字段；B 方案用 `sha256` 属性校验）。

### 4.2 GitHub Releases 作为通道
- 每个 release tag 挂：`WhalePod-<ver>-macos-arm64-full.dmg`、`...-slim.zip`、`SHA256SUMS`、**`appcast.xml`**。
- app 读 `https://github.com/whyihaveyou/whalepod/releases/latest/download/appcast.xml`（latest/download 指向最新 release 的 asset，永远拿到最新 appcast）。
- 优点：单源、现有发布流程顺带；走 latest/download 免去解析 API 页。

### 4.3 Slim/Full 双档
- 同一 appcast，item 里放两条 enclosure（或两条 item 同 build、不同 `title` 尾缀 full/slim）。
- 壳启动时知道自己装的档（判断 .app 内是否有 bundled node → Full；否则 Slim），只取匹配的 enclosure url。
- 简化兜底：取不到匹配档就提示用户去 release 页手动选，不擅自换档。

## 5. ⚠️ 阻塞性前置改造点（先于实现）

**现状**（已核实）：
- `build-app.sh` 支持 `VERSION` → `CFBundleShortVersionString`、`BUILD_NUMBER` → `CFBundleVersion` 注入。
- 但 `release.yml` 手动档调用 `build-app.sh release` **没传 VERSION** → .app 里 CFBundleShortVersionString 恒为默认 `0.1.0`。
- 而 release tag 是 `v0.1.0-alpha.N`（肉眼递增），artifact 文件名也带版号，**只有 .app 内部版本号没跟着涨**。

**后果**：无论 A 还是 B，updater 拿「本地 .app 的 CFBundleVersion/CFBundleShortVersionString」和 appcast 的 build 比对。如果 .app 里 build 恒为 1、CFBundleShortVersionString 恒为 0.1.0，则**永远判定已最新** → 自动更新形同虚设。

**必须**：
1. **发版链路统一把「本次版本号 + 严格递增的 build 号」灌进 build-app.sh**（两种 tier 都灌，改 release.yml 手动档 + 外部每日 cron 的调用点）。每日 alpha：`VERSION=0.1.0-alpha.N`、`BUILD_NUMBER=N`（N 单调 +1）。
2. 把「版本号只有一个可信来源」收拢：tag（`vX.Y.Z-alpha.N`）→ 解析出 `VERSION` 与 `BUILD_NUMBER` → 传 build-app.sh。不要让 artifact 文件名、Info.plist、tag 三处各写各的（现在正是这样）。

这属于 `HarnessShell/Scripts/` + `release.yml` + **cron 调用点** 的改造——**超出本任务「docs/+spikes/」边界**，我把它作为**发版钩子改造点**列给 Leader，等拍板实现阶段一起做（也可能派给分发 owner）。

## 6. 版本比较语义（spike 已验证）

- 用 **build 号（整数）主键排序**：`0.1.0-alpha.5`(build 5) > `0.1.0-alpha.4`(build 4)。单调、无歧义。
- **不要**手写 semver 字符串比较器：`0.1.0-alpha.5` vs 稳定 `0.1.0`，严格 semver 里预发 **小**于稳定；但 build 号天然 +1 避开此坑（spike 第 3 个用例演示了 naive 比较器的这个误判）。实现阶段用整型 build 判定即可，或引真正的 semver 库，不要自造。

## 7. 风险提示

1. **/Applications 不可写**（admin 所有）：
   - 替换需要 relaunch+helper：app 退出 → helper（单独小二进制）把新 .app 拷进 /Applications → 重新拉起。
   - 非公证 + ad-hoc：拷贝行为来自「已信任 context 内自更新」vs 用户双击外部下载的 quarantine 不同——进程内替换通常**不**触发 Gatekeeper 重评估（这也是 electron-updater/dsh-desktop 设 `gatekeeperAssess:false` 的原因）。但 ad-hoc 签名在替换后 code signature 需仍有效（重签或保守保留原签名）。
   - 若 app 被用户装到**用户可写处**（~/Applications、下载目录），替换可免提权——引导用户可装这里能大幅降低难度（推广文案可建议）。
2. **每日 alpha 全量下载**：DMG 200+MB 每次全量成本不算低；Slim ~1MB 便宜得多。可后续加 HTTP Range 差分（幂等/进度条），本期不做。
3. **崩溃/替换中断**：替换不是原子的，做「先下载到缓存+校验 → 重启首启再换」两段式，换失败回滚原 .app（保目录 `.app-update-bak`）。
4. **daily alpha 口碑**：自动更新会让用户每天都收到更新通知——可配「顺滑：仅当新 alpha 非破坏才推」，或默认只提示不打扰。UX 层建议。
5. **无公证 + Gatekeeper**：`spctl` 对自更新后的 app 评估见上；建议实现阶段实测一次「替换后双击能否正常开」再定搬运 helper 是否要走提权。

## 8. 骨架交付（已完成 —— spikes/auto-update/）

- `spikes/auto-update/appcast.xml`：样例 appcast（alpha.4/alpha.5 两条）。
- `spikes/auto-update/check-version.mjs`：Node 最小验证——
  - 拉 appcast（支持 file:// 或 http:// 静态服务）→ 解析条目 → **按 build 号找最新** → 与传入的 installed 版本比对 → 输出「检出有新版 / 已最新」。
  - **已验证**：file 源 + 本机 `python3 -m http.server 4833` 静态 http 通道，`installed=4 → 有新版(5)`、`installed=5 → 已最新`、`installed=0.1.0-alpha.4 → 有新版`。✅ 「样例 app 能检出有新版」达成，未做真替换（按任务要求）。

> Swift 侧的最终 updater（实现阶段）就是把 `check-version` 的「拉 appcast→按 build 判定」搬成 Swift（URLSession + 整型比较），再套 dsh-desktop 那套状态机 + 启动延时/抖动/周期策略 + 两段式替换。

## 9. 实施拆解（等 Leader 拍板选型后）

- **P0 前置**：发版链路版本/build 灌入（§5）——归分发 owner 或按 Leader 派。
- **P1 通道**：发版脚本生成 `appcast.xml` + 上传 release（含 `latest/download` appcast 地址可用）。
- **P2 壳内检查**：Swift 侧启动 schedule 拉 appcast → build 判定 → 有新版通知（`UserNotifications`），**不替换**（本期骨架闭口）。
- **P3 替换（下一期）**：下载+sha256 校验 → relaunch 自替换 helper → 失败回滚 → Gatekeeper 实测。
- **P4（可选）**：真上 Sparkle 2（需 Developer ID + 公证后）。

## 10. 交付清单

- [x] `docs/auto-update-proposal.md`（本文档）
- [x] `spikes/auto-update/appcast.xml`
- [x] `spikes/auto-update/check-version.mjs`（file/http 双源已验证）

> 未 commit；等 Leader 拍板选型 + 内容确认后一并 commit（推送归 Leader）。边界内未动任何 `Sources/`。
