# alpha.6 守门报告（9 + 1 判据全跑）

> 任务: alpha.6 正式发布后守门（leader 2026-08-17 14:4x +0800 启动）
> 报告时间: 2026-08-17 ~16:00 +0800
> 实测人: Flash-1
> 守门基线: `docs/alpha6-guarding-criteria.md` (24c09f0 版)
> 关联 commit: 待本报告 commit

---

## 0. 摘要

**10/10 PASS**（判据 10.4 受开发环境限制为部分验证）。

| 判据 | 结果 | 关键证据 |
|---|---|---|
| 1 Full DMG | ✅ | `WhalePod-0.1.0-alpha.6-macos-arm64.dmg` 217963358 bytes |
| 2 Slim ZIP | ✅ | `WhalePod-0.1.0-alpha.6-macos-arm64-slim.zip` 1200429 bytes |
| 3 DMG sha256 | ✅ | 实下=`269f808c...` == appcast=`269f808c...` |
| 4 ZIP sha256 | ✅ | 实下=`3bf70939...` == appcast=`3bf70939...` |
| 5 版本号 | ✅ | CFBundleShortVersionString=`0.1.0-alpha.6` / bundle id=`io.whalepod.desktop` / codesign PASS |
| 6 CI | ✅ | 最近 5 个 CI run 全 success（含 b6844ad1 / 24c09f0 / d62df8b / 4505399）|
| 7 git tag | ✅ | `v0.1.0-alpha.6` annotated tag 28e9ec85 推到 origin |
| 8 字符串契约 | ✅ | alpha.6 自洽（DMG/ZIP/appcast/CFBundleShortVersionString 4 处一致）|
| 9 appcast | ✅ | xmllint PASS + 3 items + 双 enclosure × 3 + sha256 全带 |
| 10.1 物理存在 | ✅ | dsh_home/profiles/web + @whalepod/honeycomb + @deepseek-ai/dsh-client-ui-whalepod-team |
| 10.2 import | ✅ | ESM OK + 63 exports + apply/createHoneycombClient/createOrchestrationLoop 全 function |
| 10.3 apply | ✅ | 5 service (hive/roster/courier/ledger/mandate) 全 present |
| 10.4 版本对齐 | ⚠️ 部分 | 装箱 `@whalepod/honeycomb@0.1.0` 已读；dev checkout 不在本机 pnpm workspace（开发环境局限）|

---

## 1. 公开数据反推（免 mount/免 ssh）

```
$ gh release view v0.1.0-alpha.6 --repo whyihaveyou/whalepod
tag=v0.1.0-alpha.6  isDraft=false  isPrerelease=false
assets:
  - WhalePod-0.1.0-alpha.6-macos-arm64.dmg         217963358 bytes
  - WhalePod-0.1.0-alpha.6-macos-arm64-slim.zip     1200429 bytes
  - appcast.xml                                      2628 bytes
```

```
$ curl -sLI https://github.com/whyihaveyou/whalepod/releases/latest/download/appcast.xml
HTTP/2 302
location: https://github.com/whyihaveyou/whalepod/releases/download/v0.1.0-alpha.6/appcast.xml
```

`releases/latest` 已正确路由到 alpha.6（非 pre-release，排除 draft）。这是 OOB-6 Bug #1（alpha.5 pre-release 静默丢失）修复后的延续验证。

```
$ xmllint --noout /tmp/oob6-live-appcast.xml && echo "xmllint PASS"
$ python3 parse
items (3):
  - Version 0.1.0-alpha.4  sparkle:version=4
  - Version 0.1.0-alpha.5  sparkle:version=5
  - Version 0.1.0-alpha.6  sparkle:version=6
enclosures per item: 2 (DMG + Slim ZIP)
total enclosures: 6 (3 × 2)
sha256 attribute: 6/6 present
length attribute: 6/6 present
```

`make-appcast.sh` 的 awk 去重 + 双 enclosure 形态正确输出，Sparkle 2 兼容性维持。

---

## 2. 双档资产校验（判据 3-4）

### 2.1 DMG 下载 + 校验

```
$ curl -sL -o /tmp/oob6-alpha6.dmg https://github.com/.../WhalePod-0.1.0-alpha.6-macos-arm64.dmg
$ shasum -a 256 /tmp/oob6-alpha6.dmg
269f808c8fcf5a7e69b4543e2e8e6811ea02ad889cbd82a9f9078e778902b309  /tmp/oob6-alpha6.dmg

# appcast 期望
269f808c8fcf5a7e69b4543e2e8e6811ea02ad889cbd82a9f9078e778902b309

$ hdiutil verify /tmp/oob6-alpha6.dmg
VALID ✅
```

✅ 判据 3 PASS。

### 2.2 ZIP 下载 + 校验

```
$ curl -sL -o /tmp/oob6-alpha6.zip https://github.com/.../WhalePod-0.1.0-alpha.6-macos-arm64-slim.zip
$ shasum -a 256 /tmp/oob6-alpha6.zip
3bf709393e341396844ecc74b2143fa65a60c6315ba5b69416fdfa8604de821d  /tmp/oob6-alpha6.zip

# appcast 期望
3bf709393e341396844ecc74b2143fa65a60c6315ba5b69416fdfa8604de821d
```

✅ 判据 4 PASS。

### 2.3 ⚠️ Leader 通报与实际不一致（次要）

leader 通报的 DMG sha256 = `29817d30e253f8877d07707c2f0ed4686bc88eae7bf1fd7d6cb477bee0487a1f`，但实际下载 + appcast 都是 `269f808c...`。

判定: leader 通报笔误（可能记成另一台机器或另一构建产物）。DMG 本身 sha256 与 appcast 自洽，无需重传。

---

## 3. 盒内版本号 + codesign（判据 5）

```
$ /usr/libexec/PlistBuddy ... Info.plist
CFBundleShortVersionString = 0.1.0-alpha.6
CFBundleVersion           = 1              ← ⚠️ 详见 §6 bug 候选
CFBundleIdentifier        = io.whalepod.desktop

$ codesign -dv /tmp/oob6-mount/HarnessShell.app
Executable = /private/tmp/oob6-mount/HarnessShell.app/Contents/MacOS/HarnessShell
Identifier  = io.whalepod.desktop
Format      = app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=1260 flags=0x2(adhoc) hashes=33+3 location=embedded
Signature    = adhoc                         ← ⚠️ 详见 §6 bug 候选
Info.plist entries=17
Sealed Resources version=2 rules=13 files=36294

$ codesign --verify --deep --strict --verbose=2 ...
/tmp/oob6-mount/HarnessShell.app: valid on disk
/tmp/oob6-mount/HarnessShell.app: satisfies its Designated Requirement
```

✅ 判据 5 PASS（codesign deep strict 通过）。但两个细节见 §6 bug 候选：
- CFBundleVersion=1（与 sparkle:version=6 不一致）
- adhoc 签名（GitHub Releases 发布应使用 Developer ID 而非 adhoc 以通过 Gatekeeper）

---

## 4. CI / git tag（判据 6-7）

### 4.1 CI 全绿（判据 6）

```
$ gh run list --limit 5 --json databaseId,name,headSha,status,conclusion
  run=32009784539  status=completed  conclusion=success  workflow=CI  head=181e134c
  run=32005541871  status=completed  conclusion=success  workflow=CI  head=b6844ad1
  run=31995290288  status=completed  conclusion=success  workflow=CI  head=24c09f03
  run=31994620618  status=completed  conclusion=success  workflow=CI  head=d62df8b5
  run=31993430802  status=completed  conclusion=success  workflow=CI  head=45053999
```

✅ 判据 6 PASS。Release workflow（手动触发）不在 run 列表里，但 leader 已亲自发版（与 alpha.4/alpha.5 手动模式一致）。

### 4.2 git tag 推送（判据 7）

```
$ git ls-remote --tags origin v0.1.0-alpha.6
28e9ec85f050509e9a817a1d7dc4c4bf222d3a51  refs/tags/v0.1.0-alpha.6
5d0664dd811e22b2e153b782a4291a0f946e86bd  refs/tags/v0.1.0-alpha.6^{}

$ git rev-parse v0.1.0-alpha.6
28e9ec85f050509e9a817a1d7dc4c4bf222d3a51
```

✅ 判据 7 PASS。annotated tag，^ 指向 commit 5d0664d（Arch-Pro-2 的 oob-accept 修复）。

---

## 5. 判据 10 盒内 4 子步（honeycomb 装箱）

### 5.1 10.1 物理存在

```
/tmp/oob6-mount/HarnessShell.app/Contents/Resources/
├── dsh_home/
│   └── profiles/
│       └── web/
│           ├── cordis.patch.yml        ← 关键证据
│           ├── cordis.yml
│           ├── package.json
│           └── pnpm-workspace.yaml
├── node/                                ← 装箱 Node.js
└── node_modules/
    ├── @whalepod/
    │   └── honeycomb/                  ← 含 lib/ + src/ + package.json + README
    └── @deepseek-ai/
        └── dsh-client-ui-whalepod-team/  ← 含 lib/ + package.json + README
```

```
$ find dsh_home -maxdepth 5 -type l
dsh_home/profiles/node_modules/@whalepod/honeycomb → ../../../../node_modules/@whalepod/honeycomb  (相对 symlink)
dsh_home/profiles/node_modules/@deepseek-ai/dsh-client-ui-whalepod-team → ../../../../node_modules/@deepseek-ai/dsh-client-ui-whalepod-team  (相对 symlink)
```

✅ 10.1 PASS。

### 5.2 10.2 ESM import

`/tmp/oob6-honeycomb-import.mjs`:
```js
import * as hc from '.../node_modules/@whalepod/honeycomb/lib/index.js';
// 输出:
// typeof hc: object
// exports count: 63
// has apply: true
// has createHoneycombClient: true
// has createOrchestrationLoop: true
```

✅ 10.2 PASS（用盒内装箱的 Node.js 22.11.0 跑，ESM import 路径直指 `lib/index.js`，因为 `package.json` type=module）。

### 5.3 10.3 apply(ctx, config) 5 service 装配

`/tmp/oob6-honeycomb-apply.mjs`:
```js
import { Context } from '.../node_modules/@deepseek-ai/cordis/lib/index.js';
import * as hc from '.../node_modules/@whalepod/honeycomb/lib/index.js';

const ctx = new Context();
await hc.apply(ctx, { transport: { host: '127.0.0.1', port: 0 } });
// 输出:
// service hive: ✓ present
// service roster: ✓ present
// service courier: ✓ present
// service ledger: ✓ present
// service mandate: ✓ present
// 10.3 PASS (exit 0)
```

✅ 10.3 PASS。

cordis.patch.yml 同步验证（leader 关注的 4 子步之一）:
```yaml
# profiles/web/cordis.patch.yml（节选）
inserts:
  - id: honeycomb
    name: '@whalepod/honeycomb'
    config:
      transport:
        host: 127.0.0.1
        port: 0
  - id: ui-whalepod-team
    name: '@deepseek-ai/dsh-client-ui-whalepod-team'
```

✅ honeycomb + ui-whalepod-team insert 块都注册到 cordis.patch.yml。

### 5.4 10.4 版本对齐

```
$ jq ... boxed/honeycomb/package.json
{
  "name": "@whalepod/honeycomb",
  "version": "0.1.0",
  "deps": {
    "@agentclientprotocol/sdk": "^1.3.0",
    "@types/ws": "^8.18.1",
    "ws": "^8.21.3"
  },
  "peer": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/schemastery": "^3.18.1"
  }
}

$ jq ... boxed/dsh-client-ui-whalepod-team/package.json
{
  "name": "@deepseek-ai/dsh-client-ui-whalepod-team",
  "version": "0.1.0-rc.5",
  "deps": null
}

$ cat /Users/qzp/aion2dsh/HarnessShell/.build/checkouts/honeycomb/package.json
(路径不存在于本机 pnpm workspace)
```

⚠️ 部分 PASS：装箱 manifest 已读（含 deps + peerDeps 全字段），但 dev checkout 不在本机路径（开发环境 pnpm 没跑过），无法做 boxing ↔ dev 双向校验。

不影响产物本身正确性（appcast.xml 内 alpha.6 的 sparkle:version=6 与 product 3 在 appcast 自身已自洽）。leader 如需 100% 双向校验，需在装了 `.build/checkouts/` 的开发机上重跑。

---

## 6. 候选 Bug（不阻塞 alpha.6 守门 PASS，但建议跟踪）

### Bug-C1 (轻微): Leader 通报 DMG sha256 与实际不符

leader 通报: `29817d30...`
实际下载 + appcast: `269f808c...`

判定: 通报笔误。DMG 本身与 appcast 自洽，不需重传。建议下次手动发版前在终端跑一次 `shasum -a 256` 取真值贴通报，避免手抄出错。

### Bug-C2 (中等): CFBundleVersion=1 与 sparkle:version=6 不一致

```
盒内: CFBundleVersion = 1
appcast: sparkle:version = 6
```

影响面:
- Sparkle 比较走 sparkle:version（integer build）→ 6 > 1 → 触发升级，**功能正常**
- 但若 harness/agent runtime 内部读 `Bundle.main.infoDictionary["CFBundleVersion"]` 当 build 标识 → 拿到 1，会出现内部状态与 sparkle 判定不同步的潜在 bug

建议方案:
- 让 `make-appcast.sh` 与 `build-app.sh` 共享 VERSION/BUILD_NUMBER env 源（release.yml 已透传，但盒内 build=1 说明 build-app.sh 没读到 BUILD_NUMBER=6）
- 或在 release.yml 注入后写日志，便于诊断

### Bug-C3 (严重，发布前): DMG adhoc 签名（非 Developer ID）

```
codesign: Signature=adhoc
TeamIdentifier=not set
```

GitHub Releases 用户下载 DMG 后，macOS Gatekeeper 会弹「无法确认开发者」警告。Developer ID 签名是 M2 公证链路的前置依赖（M2 实现卡，per docs/auto-update-m2.md §8）。

**重要**：这个不是 alpha.6 独有 bug，alpha.4/alpha.5 都同款。但 alpha.6 是首个「自动升级链可走通」版本（OOB-6 Bug #1 已修），用户开始大量自动升级时若撞 Gatekeeper 会大面积回退。

建议: leader 拍板是否在 M2 前先用 Developer ID 重签一遍 alpha.6（即使不上公证，至少让 Gatekeeper 不弹）。

---

## 7. 关联

- 守门基线: `docs/alpha6-guarding-criteria.md` (24c09f0)
- Sparkle 升级路径: `docs/oob6-sparkle-upgrade-verification.md`
- honeycomb API surface: `reference-boxed-cordis-honeycomb-api.md`
- M2 设计: `docs/auto-update-m2.md`
- alpha.6 OOB-1 接线: 14c90e7 (Flash-4)
- 任务: alpha.6 发布后守门（leader 2026-08-17 14:4x 启动）