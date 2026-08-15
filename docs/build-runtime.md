# M0 运行时自举：build-runtime 使用说明

> 把 node + `@deepseek-ai/dsh` 全家桶打进 `.app`，让用户**免装 Node 一键起**。
> 实做脚本：`HarnessShell/Scripts/build-runtime.sh`
> 依据方案：`docs/m0-runtime-bootstrap-plan.md`（a+b 组合：bundled 优先 → 本机探测 → npx 兜底）

---

## 一、什么是「bundled 运行时」

| 路径 | 内容 | 大小占比 |
|---|---|---|
| `.app/Contents/Resources/node/` | node v22.17.0 二进制（`bin/{node,npm,npx,corepack}` + `lib/` 共享库） | ≈ 24% |
| `.app/Contents/Resources/node_modules/` | `@deepseek-ai/dsh` 全家桶（`--omit=dev` 净化） | ≈ 76% |
| **合计增量** | — | **≈ 90–105MB**（实测 470M total .app，含原 Swift 二进制 + 签名） |

**触发条件**：用户在 `~/Library/Application Support/WhalePod/config.json` 把 `command` 留空（或字段缺失走默认）。RuntimeBootstrap 的探测链：

1. **custom**（最高优先级）—— 用户手写的 `command` 非空时 → 原样 shell 执行（向后兼容旧配置）。
2. **bundled** —— `Resources/node/bin/node` 可执行 且 `Resources/node_modules/@deepseek-ai/dsh/lib/bin.js` 存在 → `.direct(executable: node, arguments: [bin, "web", "--port", N])`。
3. **nodeProbe** —— 本机 `/opt/homebrew/bin/node` 等命中 + bundled dsh 存在 → 用本机 node 跑 bundled dsh。
4. **npxFallback** —— 都没有 → `npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web`（需网络）。
5. **unavailable** —— 全部失败 → UI 提示「请安装 Node 或配置 command」。

详见 `HarnessShell/Sources/HarnessShell/RuntimeBootstrap.swift` 的 `resolve()`。

---

## 二、build-runtime.sh 用法

### 2.1 默认调用

```bash
# 当前 .app（HarnessShell/dist/HarnessShell.app）+ 默认版本
./HarnessShell/Scripts/build-runtime.sh
```

输出预期：
```
==> [1/4] 下载并解压 node tarball
    URL: https://nodejs.org/dist/v22.17.0/node-v22.17.0-darwin-arm64.tar.xz
    ✅ 下载完成：24M
    ✅ node 可执行：v22.17.0
==> [2/4] npm install dsh 全家桶（--omit=dev + 锁版本）
    ✅ dsh 入口存在：/tmp/whalepod-runtime.XXX/bundle/node_modules/@deepseek-ai/dsh/lib/bin.js
    ✅ package-lock.json 已保存
==> [3/4] 拷进 .app/Contents/Resources/
    ✅ 拷贝完成
==> [4/4] 自检产物
    ✅ node 版本对齐：v22.17.0（期望 v22.17.0）
    ✅ dsh CLI 可执行
==> 体积报告
    .app 总大小    : 459M
    Resources/node : 119M
    Resources/node_modules : 340M
==> ✅ M0 bundled 打包完成
```

### 2.2 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_PATH` | `HarnessShell/dist/HarnessShell.app` | 目标 .app 路径（相对/绝对均可，脚本会 anchor 成绝对） |
| `NODE_VERSION` | `22.17.0` | node 版本（三元组 X.Y.Z） |
| `DSH_VERSION` | `0.1.0-rc.6` | dsh 版本（必须与 `RuntimeBootstrap.dshVersion` 一致） |
| `ARCH` | `arm64` | Apple Silicon；CI 验证可改 `x64`（Intel） |
| `WORKDIR` | `/tmp/whalepod-runtime.<ts>` | 临时工作目录（脚本退出时自动 `rm -rf`） |
| `SKIP_VERIFY` | `0` | 设为 `1` 跳过产物自检（CI 调试用） |
| `VERBOSE` | `0` | 设为 `1` 开启 `set -x`（调试用） |

例：
```bash
# 验证 x64 链路（CI 用）
APP_PATH=/tmp/HarnessShell-x64.app ARCH=x64 ./HarnessShell/Scripts/build-runtime.sh

# 强制重打（跳过自检，跑得更快）
SKIP_VERIFY=1 ./HarnessShell/Scripts/build-runtime.sh
```

### 2.3 前置条件

- **已构建 .app**：
  ```bash
  cd HarnessShell && swift build -c release && ./Scripts/build-app.sh
  ```
  如果跑 `swift build -c debug` 即可，产物路径是 `HarnessShell/dist/HarnessShell.app`。
- **网络**：默认从 `https://nodejs.org/dist/` 下 node tarball，从 npm registry 下 dsh（首次一次性；可走公司代理）。
- **磁盘**：临时 `/tmp/whalepod-runtime.*` ≈ 200MB（node tarball + 解压 + dsh 全家桶），脚本退出自动清理。

### 2.4 确定性可复现

脚本使用 **`--save-exact=true`** 把 dsh 锁到精确版本，并把生成的 `package-lock.json` 拷到 `$WORKDIR/dsh-package-lock.json` 临时保存。后续 CI 可走「离线复现」路径：

```bash
# 首次：在线生成 lockfile（如上脚本）
# 之后 CI：用 lockfile + npm cache 离线复现
npm ci --omit=dev --offline --prefix <bundle-dir>
```

进阶方案：把 `dsh-package-lock.json` 上传到内部 artifact registry，每次 CI 拉下来 `npm ci --offline`，不联网。

---

## 三、签档三档（ad-hoc / Developer ID / Developer ID + notarize）

### 3.1 ad-hoc（开发自用 / 内部测试）

> 用 `-s -` 让 codesign 自签。无证书要求。

```bash
codesign --force --deep -s - HarnessShell/dist/HarnessShell.app
codesign --verify --verbose HarnessShell/dist/HarnessShell.app
# ✅ expected: "valid on disk" + "satisfies its Designated Requirement"
```

**限制**：用户首次打开会撞 Gatekeeper「未识别开发者」白屏，需右键 → 打开绕过。本机可接受；外发不建议。

### 3.2 Developer ID（个人分发 / 公司内分发）

需要：Apple Developer Program 账号 → 创建 Developer ID Application 证书 → `security import` 进 Keychain。

```bash
DEVID="Developer ID Application: Your Name (TEAMID)"
codesign --force --deep --options runtime \
  --sign "$DEVID" \
  --entitlements HarnessShell/HarnessShell.entitlements \
  HarnessShell/dist/HarnessShell.app
codesign --verify --strict --verbose=2 HarnessShell/dist/HarnessShell.app
```

**注意**：`--options runtime` 启用 hardened runtime（notarization 前置条件）。

### 3.3 Developer ID + notarize（产品化分发）

在 §3.2 基础上加：

```bash
# 1) 打包成 zip（notarytool 接受 zip / dmg）
cd HarnessShell/dist && zip -r ../HarnessShell.zip HarnessShell.app

# 2) 上传到 Apple 公证（需 App-Specific Password）
AC_PASS="xxxx-xxxx-xxxx-xxxx"  # appleid.apple.com → App-Specific Passwords
xcrun notarytool submit HarnessShell.zip \
  --apple-id "your@email.com" \
  --team-id "TEAMID" \
  --password "$AC_PASS" \
  --wait

# 3) 公证成功后 staple 到 .app
xcrun stapler staple HarnessShell/dist/HarnessShell.app
xcrun stapler validate HarnessShell/dist/HarnessShell.app

# 4) 再打包成 DMG 发版
./Scripts/make-dmg.sh
```

**Apple ID / 团队 ID / App-Specific Password** 属用户凭证，绝不入库；用环境变量或 `~/.notarytool-credentials.json`（gitignored）。

---

## 四、产物验证清单

| 项 | 命令 | 期望 |
|---|---|---|
| 布局 | `find HarnessShell/dist/HarnessShell.app/Contents/Resources -maxdepth 2 -mindepth 1` | `AppIcon.icns` `node/` `node_modules/` |
| node 可执行 | `HarnessShell/dist/HarnessShell.app/Contents/Resources/node/bin/node --version` | `v22.17.0` |
| node dylib 完整 | `ls HarnessShell/dist/HarnessShell.app/Contents/Resources/node/lib/ \| head -5` | macOS `.dylib` + `.node` 模块 |
| dsh bin 存在 | `ls HarnessShell/dist/HarnessShell.app/Contents/Resources/node_modules/@deepseek-ai/dsh/lib/bin.js` | 文件存在 |
| dsh 版本对齐 | `cat .../node_modules/@deepseek-ai/dsh/package.json \| grep version` | `"version": "0.1.0-rc.6"` |
| dsh CLI 工作 | `node .../node_modules/@deepseek-ai/dsh/lib/bin.js --help` | 输出 dsh usage |
| **免装 Node 冒烟** | `env -i PATH=/usr/bin:/bin .../node/bin/node .../bin.js --version` | `0.1.0-rc.6`（不依赖系统 node） |
| **真启动 web** | `env -i ... node .../bin.js web --port 0` | `dsh web: http://127.0.0.1:<随机>` |
| ad-hoc 签 | `codesign --verify --verbose HarnessShell/dist/HarnessShell.app` | `valid on disk` + `satisfies its Designated Requirement` |
| 体积 | `du -sh HarnessShell/dist/HarnessShell.app` | ≈ 450–470M |

### 4.1 实测报告（2026-08-15 工程-Flash-1）

```
.app 总大小       : 459M
Resources/node    : 119M
Resources/node_modules : 340M
sign 增量        : +11M (codesign 注入)
最终 .app 大小    : 470M

自检（全部通过）：
  ✅ node v22.17.0 可执行（与 RuntimeBootstrap 期望对齐）
  ✅ dsh 0.1.0-rc.6 可执行（与 RuntimeBootstrap.dshVersion 对齐）
  ✅ dsh --help 工作
  ✅ dsh web 真启动 → http://127.0.0.1:58984（env -i 验证不依赖系统 node）
  ✅ codesign --verify 通过

未能做（需 GUI / 用户配合）：
  ❌ 启动 HarnessShell.app 看 UI 是否走 bundled 分支
     → 用户配置 command 留空 + dsh web 冒烟已在脚本外通过
     → 真实 UI 流程留待用户 / QA
```

---

## 五、故障排查

| 现象 | 原因 | 修复 |
|---|---|---|
| `tar: unrecognized archive format` | macOS BSD tar 不识别 `.tar.xz`（罕见） | `brew install xz` 或显式 `xz -d` 后用 `tar -xf` |
| `EACCES: permission denied` 写 Resources | .app 被锁定（首次系统装过的应用会加 quarantine） | `xattr -dr com.apple.quarantine HarnessShell/dist/HarnessShell.app` |
| `node: dyld: Library not loaded` | node 找不到 dylib（多半是 lib/ 没拷全） | 重跑脚本；或手动 `cp -R $WORKDIR/node-vXX.Y.Z-darwin-arm64/lib/. <APP>/Contents/Resources/node/lib/` |
| `dsh: command not found` 在 bundled 分支 | `node_modules/@deepseek-ai/dsh/lib/bin.js` 缺失 | 重跑脚本；或检查 npm install 是否被 `--omit=dev` 误清掉了关键 dep |
| `npm install` 联网失败 | 代理 / 公司网络 / registry 改源 | `npm config get registry` 看源；用 `npm config set registry https://registry.npmmirror.com` 临时换源（仅开发） |
| `du -sh` 体积远大于 470M | node_modules 含 dev deps | 确认脚本用 `--omit=dev`；用 `npm ls --prod` 验证 |

---

## 六、相关文件

| 文件 | 作用 |
|---|---|
| `HarnessShell/Scripts/build-runtime.sh` | 主脚本（148 行，可重复执行） |
| `HarnessShell/Sources/HarnessShell/RuntimeBootstrap.swift` | Swift 端探测链（**不碰此文件**，由 M0 owner 维护） |
| `HarnessShell/Sources/HarnessShell/ServiceConfig.swift` | 配置加载（决定 command 字段是否留空 → 触发 bundled） |
| `docs/m0-runtime-bootstrap-plan.md` | 方案文档（a+b 组合 + 体积预估） |
| `HarnessShell/Scripts/make-dmg.sh` | DMG 打包（在 build-runtime + 签名后跑） |
| `HarnessShell/HarnessShell.entitlements` | 沙盒 / hardened runtime 权限声明 |
| `.gitignore` | 已 ignore `HarnessShell/dist/`、`*.app`、`*.dmg`，产物不入库 |

---

## 七、变更记录

| 日期 | 变更 | 责任人 |
|---|---|---|
| 2026-08-15 | 首次实做（修复 Flash-3 草稿 3 处 bug + CWD 锚定） | 工程-Flash-1 |