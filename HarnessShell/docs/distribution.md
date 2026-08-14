# DFH Workstation — macOS 分发链路（HarnessShell.app 签名/公证/安装器）

> 作者：工程-Flash-1 | 适用对象：`/Users/qzp/aion2dsh/HarnessShell/`
> 环境备注：**本机仅装有 Command Line Tools（无完整 Xcode）**。下方所有打包/签名命令均可用命令行完成；涉及公证（notarytool/stapler/altool）的步骤依赖 Xcode 组件，已在"无 Xcode 环境"下给出替代路径与可执行命令，脚本在装有 Xcode 的机器或 macOS CI 上可直接跑通。

---

## 0. 产物一览（脚本全部在 `Scripts/` 下）

| 脚本 | 作用 | 产物 |
|---|---|---|
| `make-icns.sh` | design/assets SVG → .icns | `Resources/{AppIcon,IconDarkTile,IconMono}.icns` |
| `build-app.sh` | swift build + 组 .app + 签名 | `dist/HarnessShell.app` |
| `make-dmg.sh` | .app → 可分发 DMG | `dist/HarnessShell.dmg` |
| `make-zip.sh` | .app → zip（备选） | `dist/HarnessShell.zip` |
| `sign.sh` | 三档签名/公证入口 | 见下 |
| `release.sh` | 一键：图标→构建→签名→DMG/ZIP | `dist/` |

```text
HarnessShell/
├── Sources/HarnessShell/
│   ├── main.swift           # 程序入口（含单实例守护）
│   ├── AppDelegate.swift    # 应用生命周期 + Dock 单击恢复 + 深链分发
│   ├── MainWindowController.swift
│   ├── ProcessManager.swift # 进程管理器（启停 harness）
│   ├── ServiceConfig.swift
│   ├── DeepLink.swift
│   └── Info.plist           # 含 dsh:// URL scheme（占位符由 build-app.sh 解析）
├── Resources/               # make-icns.sh 产出的 .icns
├── Scripts/
│   ├── make-icns.sh  build-app.sh  make-dmg.sh  make-zip.sh  sign.sh  release.sh
└── docs/distribution.md     # 本文档
```

**App 事实**：Bundle ID `com.aion2dsh.HarnessShell`；可执行 `HarnessShell`；deploy target 13.0；注册 URL scheme `dsh`；单实例（同 Bundle ID 已有进程则转交并退出）；进程管理器拉起 harness web（见 ServiceConfig）。

---

## 1. 代码签名

### 档位 A — ad-hoc（个人 / 本地工具，本机可直接跑）

```bash
# 手动：对 .app 做 ad-hoc 签名（--timestamp=none 避免 G2 证书时间戳联网/警告）
codesign --force --sign - --timestamp=none dist/HarnessShell.app
codesign --verify --deep --strict --verbose=2 dist/HarnessShell.app
# 预期输出: dist/HarnessShell.app: valid on disk / satisfies its Designated Requirement
# Identifier=com.aion2dsh.HarnessShell, Signature=adhoc
```

- 一键：`Scripts/build-app.sh`（默认 `SIGN_IDENTITY=-` ad-hoc，已实测通过）。
- **首次运行提示"无法验证开发者"**：ad-hoc / 无签名应用会被 Gatekeeper 拦截。解除（右键→打开，或）：
  ```bash
  sudo xattr -dr com.apple.quarantine "dist/HarnessShell.app"
  ```
- 适用场景：自己机器、抽查内部、不对外分发。

### 档位 B — Developer ID + 公证（产品化对外分发）

前置条件（本机无 Xcode 时需在装有 Xcode 的机器 / CI 完成一次性的证书与 keychain 配置）：

```bash
# 1) 需要 Apple Developer 账号 + Developer ID Application 证书（钥匙串可见）
# 2) 先建立 notarytool 凭据 profile（Xcode 环境执行一次）：
xcrun notarytool store-credentials dfh-notary \
  --apple-id "you@example.com" \
  --team-id "TEAMID" \
  --password "app-specific-password" \
  --keychain-profile dfh-notary
```

签名 .app（hardened runtime + timestamp）：

```bash
export DEV_ID="Developer ID Application: 你的名字 (TEAMID)"
codesign --force --options runtime --timestamp --sign "$DEV_ID" dist/HarnessShell.app
codesign --verify --deep --strict --verbose=2 dist/HarnessShell.app
```

一键入口：`Scripts/sign.sh devid`（对 .app 公证）或 `Scripts/sign.sh devid --dmg`（对 DMG 公证）。

---

## 2. 打包：.app → DMG / ZIP

### 可双击的 .app

```bash
Scripts/build-app.sh           # 默认 ad-hoc；如需 Developer ID：
SIGN_IDENTITY="Developer ID Application: 你的名字 (TEAMID)" Scripts/build-app.sh
# 产物 dist/HarnessShell.app
```

组装内容（脚本自动完成）：
- `Contents/MacOS/HarnessShell`（swift build -c release 产物）
- `Contents/Info.plist`（解析 `$(...)` 占位符；含 dsh:// scheme、CFBundleIconFile、deploy target）
- `Contents/Resources/AppIcon.icns`（make-icns.sh 生成）
- `Contents/_CodeSignature/`（签名嵌入）
- 单实例守护在 `main.swift` 启动期执行

### DMG（hdiutil，推荐分发格式）

```bash
Scripts/make-dmg.sh
# 产物 dist/HarnessShell.dmg —— 内附 HarnessShell.app + /Applications 软链，拖拽即安装
# 校验：hdiutil verify dist/HarnessShell.dmg
```
- 产物含 `Applications` 符号链接，用户拖 App 图标进 Applications 即完成安装。
- DMG 自身签名：产品化时 `SIGN_IDENTITY="Developer ID Application: ..." Scripts/make-dmg.sh`。

### ZIP（备选）

```bash
Scripts/make-zip.sh             # 产物 dist/HarnessShell.zip
```

---

## 3. 公证（Notarization）与 Stapler

> 公证 = 把应用提交 Apple 服务器扫描，换取"已由 Apple 公证"的门票；stapler 把凭证钉回包内，让 Gatekeeper 离线放行。
> **需要 Developer ID 证书 + Xcode 环境**（notarytool 随 Xcode/Xcode CLT 提供；本机仅有 CLT 时，在 Xcode 机器或 macOS CI 完成此节）。

### 3a. 公证 .app（zip 提交 → stapler）

```bash
ditto -c -k --keepParent dist/HarnessShell.app /tmp/harness-shell-notarize.zip
xcrun notarytool submit /tmp/harness-shell-notarize.zip \
  --keychain-profile dfh-notary --wait
# 输出 Accepted; 获得 submission ID
xcrun stapler staple dist/HarnessShell.app
xcrun stapler validate dist/HarnessShell.app   # 验证凭证
```

### 3b. 公证 DMG（推荐，公证整体安装物）

```bash
xcrun notarytool submit dist/HarnessShell.dmg \
  --keychain-profile dfh-notary --wait
xcrun stapler staple dist/HarnessShell.dmg
xcrun stapler validate dist/HarnessShell.dmg
```

### 3c. 公证 .pkg 安装器

先打带 Developer ID Installer 签名的 pkg（见 §4），再：

```bash
xcrun notarytool submit dist/HarnessShell.pkg \
  --keychain-profile dfh-notary --wait
xcrun stapler staple dist/HarnessShell.pkg
```

> **altool（旧工具，可选替代）**：老式流程也可用 `xcrun altool --notarize-app --file ... --primary-bundle-id com.aion2dsh.HarnessShell --username ... --password ...`；官方已迁移到 notarytool，新项目优先 notarytool。

---

## 4. 安装器 .pkg

```bash
# 需要 Developer ID Installer 证书；用 pkgbuild 生成 + Developer ID Installer 签名
export DEV_ID_INSTALLER="Developer ID Installer: 你的名字 (TEAMID)"
pkgbuild \
  --component dist/HarnessShell.app \
  --install-location /Applications \
  --version 0.1.0 \
  --sign "$DEV_ID_INSTALLER" \
  dist/HarnessShell.pkg
```
- 无 installer 证书时去掉 `--sign` 生成未签名 pkg（仅本地测试）。
- 若要带欢迎/协议/一键三步式安装向导，可用 `productbuild --distribution` 配 `distribution.xml`（进阶，非本次范围）。

---

## 5. 一键发布（release.sh）

```bash
./Scripts/release.sh dmg         # ad-hoc + DMG（个人本地使用）
./Scripts/release.sh zip         # ad-hoc + ZIP
./Scripts/release.sh devid       # Developer ID 签名 .app + DMG（公证需 Xcode 环境补跑 sign.sh devid --dmg）
./Scripts/release.sh pkg         # .app + .pkg 安装器（公证需 Xcode 环境补跑 sign.sh pkg）
```

---

## 6. 无完整 Xcode 的替代路径汇总

| 需求 | 本机能做？ | 做法 / 替代 |
|---|---|---|
| 编译可执行 | ✅ | `swift build -c release`（SwiftPM，CLT 自带 swiftc） |
| 组 .app bundle | ✅ |「手工目录 + Info.plist + 脚本」由 build-app.sh 完成（无 xcodebuild 也能做） |
| ad-hoc 签名 | ✅ | `codesign -s -` |
| 生成 .icns | ✅ | `qlmanage + sips + iconutil`（均为系统自带） |
| .dmg / .zip | ✅ | `hdiutil / ditto` |
| Developer ID 签名 | 需证书 | 命令通用，装了证书即可（脚本同） |
| Notarization | 需 Xcode 组件 | notarytool：在装有 Xcode 的机器/CI 执行（GitHub Actions `macos-14` runner 自带 Xcode，可直接跑 §3 命令） |
| .pkg 安装器 | ✅（需证书才签名） | pkgbuild 属 macOS 自带，CLT 环境可用 |

> **CI 建议**：GitHub Actions `macos-latest`/`macos-14` 自带完整 Xcode + notarytool + 证书导入工具（`security import`），可将 `release.sh devid` / `sign.sh devid --dmg` + 公证流程接入 CI，实现一键产品化发布。

---

## 附：本次实测结果（2026-08-14，macOS aarch64，node/swift CLT 环境）

| 步骤 | 结果 |
|---|---|
| swift build -c release | ✅ 89s，可执行 248K |
| make-icns.sh（三枚 .icns） | ✅（AppIcon 788K / IconDarkTile 930K / IconMono 93K） |
| build-app.sh（ad-hoc .app） | ✅ codesign verify 通过，dsh:// scheme 就位，无占位符残留 |
| 启动冒烟（单实例） | ✅ 二次 open 进程数保持 1；Dock 恢复逻辑就位 |
| make-dmg.sh | ✅ 1.2M，hdiutil verify 通过，内含 .app + Applications 软链 |
| make-zip.sh | ✅ 808K |
| Developer ID / 公证 | ⏭️ 未执行（需证书 + Xcode 环境），命令/脚本就绪 |
