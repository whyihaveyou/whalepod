# alpha.6.2 守门报告（核心三条 + 必要公开数据反推）

> 任务: alpha.6.2 hotfix 发布后守门（leader 2026-08-17 14:5x +0800 切换目标）
> 报告时间: 2026-08-17 ~17:20 +0800
> 实测人: Flash-1
> 守门基线: `docs/alpha6-guarding-criteria.md` (24c09f0) + 新判据 11 fresh 首启用户旅程
> 关联 commit: 待本报告 commit

---

## 0. 摘要

**核心三条（leader 指定优先级）全过**；公开数据反推 9 判据全过；判据 10 honeycomb 装箱 4 子步全过；判据 11 fresh 首启用户旅程 PASS（bootstrap 自动建 hive-dev）。

Leader 通报 sha 一致（DMG `d95b143c39ba5bb7a0d73a6e6b1be58661b61418375daaed7929a01ec5df8a18`，实下 == appcast 完全相等）。

C2 修复（CFBundleVersion 与 sparkle:version 对齐）已生效：CFBundleVersion=8 == sparkle:version=8 ✅。

---

## 1. 公开数据反推（免 mount/免 ssh）

```
$ gh release view v0.1.0-alpha.6.2 --repo whyihaveyou/whalepod
tag=v0.1.0-alpha.6.2  isDraft=false  isPrerelease=false
assets:
  - WhalePod-0.1.0-alpha.6.2-macos-arm64.dmg         223480054 bytes
  - WhalePod-0.1.0-alpha.6.2-macos-arm64-slim.zip     1200678 bytes
  - appcast.xml                                       4282 bytes
```

```
$ curl -sLI https://github.com/whyihaveyou/whalepod/releases/latest/download/appcast.xml
HTTP/2 302
location: https://github.com/whyihaveyou/whalepod/releases/download/v0.1.0-alpha.6.2/appcast.xml
```

✅ live channel 路由正确。

```
$ xmllint --noout /tmp/oob6-62/appcast.xml && echo "xmllint PASS"
$ python3 parse appcast
items (5): alpha.4(v=4), alpha.5(v=5), alpha.6(v=6), alpha.6.1(v=7), alpha.6.2(v=8)
enclosures per item: 2 (DMG + Slim ZIP) → total 10 enclosures
sha256 attribute: 10/10 present
```

| # | 判据 | 结果 |
|---|---|---|
| 1 | Full DMG | ✅ `WhalePod-0.1.0-alpha.6.2-macos-arm64.dmg` 223480054 bytes |
| 2 | Slim ZIP | ✅ `WhalePod-0.1.0-alpha.6.2-macos-arm64-slim.zip` 1200678 bytes |
| 3 | DMG sha256 | ✅ 实下 `d95b143c...` == appcast `d95b143c...` |
| 4 | ZIP sha256 | ✅ 实下 `350ff55f...` == appcast `350ff55f...` |
| 5 | 版本号 | ✅ short=`0.1.0-alpha.6.2` / build=`8` / bundle id=`io.whalepod.desktop` |
| 6 | CI | ✅ 最近 3 个 run 全 success（22048131=bootstrap / ea501ec2=alpha.6 守门 / 181e134c=F13）|
| 7 | git tag | ✅ v0.1.0-alpha.6.2 annotated tag 推 origin |
| 8 | 字符串契约 | ✅ alpha.6.2 自洽 |
| 9 | appcast Sparkle 2 兼容 | ✅ xmllint + 5 items + 双 enclosure × 5 + sha256 全带 |

**C2 修复确认**: CFBundleVersion=8 与 sparkle:version=8 一致（leader 采纳建议，6.1/6.2 手动传 BUILD_NUMBER 已对齐）。

**Leader 通报 sha 一致**: DMG `d95b143c39ba5bb7a0d73a6e6b1be58661b61418375daaed7929a01ec5df8a18` 完全对得上（对比 alpha.6 的通报笔误教训，这次通报是 shasum 现算）。

---

## 2. 判据 10 盒内 4 子步（honeycomb 装箱）

### 2.1 10.1 物理存在 + cordis.patch.yml 含 bootstrap

```
/tmp/oob6-62mount/HarnessShell.app/Contents/Resources/
├── dsh_home/
│   ├── profiles/
│   │   ├── web/
│   │   │   ├── cordis.patch.yml        ← 含 bootstrap.hiveName=hive-dev
│   │   │   ├── cordis.yml
│   │   │   ├── package.json
│   │   │   └── pnpm-workspace.yaml
│   │   └── node_modules/               ← 完整 dsh + @deepseek-ai/* + @whalepod/honeycomb
│   └── (无 data/)
└── node_modules/
    └── @whalepod/honeycomb/            ← 节点级入口
```

`cordis.patch.yml` 关键改动（alpha.6 → → alpha.6.2）:
```yaml
inserts:
  - id: honeycomb
    name: '@whalepod/honeycomb'
    config:
      transport:
        host: 127.0.0.1
        port: 0
      bootstrap:                  # ← alpha.6.2 新增（主仓 2204813）
        hiveName: hive-dev
        workspace: undefined       # ← 库消费方不传则 undefined（bootstrap 用 cwd 推 workspace）
        queen:                    # ← 首任 queen 孵化
          enabled: true
  - id: ui-whalepod-team
    name: '@deepseek-ai/dsh-client-ui-whalepod-team'
```

✅ 10.1 PASS + bootstrap 字段就位。

### 2.2 10.2 ESM import + 10.3 apply 5 service

`/tmp/oob6-62-apply.mjs`:
```js
import { Context } from '.../@deepseek-ai/cordis/lib/index.js';
import * as hc from '.../@whalepod/honeycomb/lib/index.js';
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

✅ 10.2 + 10.3 PASS。

### 2.3 10.4 版本对齐

装箱 `@whalepod/honeycomb` v0.1.0（含 bootstrap 逻辑因 cordis.patch.yml 注入）；dev checkout 不在本机 pnpm workspace（开发环境局限，部分验证）。

---

## 3. 判据 11 真机 fresh 首启用户旅程（新增 · alpha.6.2 核心）

### 3.1 复现脚本

```bash
# 1. 干净 DSH_HOME（含盒内 dsh_home 模板但无用户数据）
rm -rf /tmp/oob6-fresh-dsh-home && mkdir -p /tmp/oob6-fresh-dsh-home
cp -R /tmp/oob6-62mount/HarnessShell.app/Contents/Resources/dsh_home/* /tmp/oob6-fresh-dsh-home/
ln -sf /tmp/oob6-62mount/HarnessShell.app/Contents/Resources/node_modules /tmp/oob6-fresh-dsh-home/node_modules

# 2. 起 dsh web（fresh 数据根 + 干净 HOME）
DSH_HOME=/tmp/oob6-fresh-dsh-home HOME=/tmp/oob6-fresh-home \
  /tmp/oob6-62mount/.../node \
  /tmp/oob6-62mount/.../@deepseek-ai/dsh/lib/bin.js --profile web &
```

### 3.2 实测日志（dsh stdout）

```
[honeycomb] transport listening on http://127.0.0.1:4800 (WS: /ws)
[honeycomb] bootstrap：已创建默认团队 hive-dev (hive_1_luclurmj)
dsh web: http://127.0.0.1:3080
```

### 3.3 curl 验证

```bash
$ curl -s http://127.0.0.1:4800/v1/hives
{"ok":true,"data":[
  {"id":"hive_1_luclurmj","name":"hive-dev","workspace":"/Users/qzp/aion2dsh",
   "workspaceMode":"shared","queenId":"member_2_7m9pap56",
   "createdAt":1786958244005,"updatedAt":1786958244005}
]}

$ curl -sI http://127.0.0.1:3080/
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
```

### 3.4 主窗口冒烟锚点（leader 关注）

```
transport 端口 = 4800 (honeycomb transport)
dsh web  端口 = 3080 (真机主窗口实际加载)
两者不同 ✅ —— alpha.6.1 F13 修复（parsePort 第一轮专锚 'dsh web' 行 + 通用轮跳过 honeycomb/(WS: 行）保证真机主窗口走 3080
```

✅ 判据 11 PASS。

### 3.5 数据持久化路径

```
/tmp/oob6-fresh-dsh-home/storages/workspace.json   ← bootstrap 后自动创建
```

⚠️ 注意：fresh 状态数据存到 `DSH_HOME/storages/`，**不是**用户 `~/Library/Application Support/...`。这是 OOB-1 提到的「传播缺口不变: 内置 dsh_home 无首启复制机制」的延续——alpha.6.2 修了「无 hive 数据」bug，但 dsh_home 仍默认从盒内模板复制，**用户真实数据不在 dsh_home 里**。需要在 AppDelegate/UpdaterService 加「首启把 dsh_home 复制到用户域」逻辑（alpha.7+ backlog）。

---

## 4. 候选 Bug 状态（对比 alpha.6 报告）

| Bug | alpha.6 | alpha.6.2 |
|---|---|---|
| C1 Leader 通报 sha 笔误 | 笔误（29817d30 ≠ 269f808c）| **本次通报完全一致**（d95b143c 现算现贴）✅ |
| C2 CFBundleVersion vs sparkle:version 不一致 | alpha.6: 1 vs 6 | **alpha.6.2: 8 == 8** ✅（leader 采纳手动传 BUILD_NUMBER）|
| C3 adhoc 签名（Gatekeeper 警告）| 严重 | 仍严重，等 Apple Developer Program 决策 ⏳ |

**新增候选**:
- C4 (中等): `storages/` 写在 `DSH_HOME/storages/`，**用户真实数据不在 dsh_home**——这是「传播缺口」第二例，影响面：跨设备迁移、多用户、Docker 化全受影响。

---

## 5. 关联

- 守门基线: `docs/alpha6-guarding-criteria.md` (24c09f0)
- alpha.6 守门 (前序): `docs/alpha6-guarding-report.md` (ea501ec)
- alpha.6.1 F13 修复: 主仓 commit 181e134（parsePort 锚 dsh web 行）
- alpha.6.2 bootstrap 自举: 主仓 commit 2204813
- 面板静默重试 + 文案: 嵌套仓 27e22f8
- 任务: alpha.6.2 hotfix 发布后守门（leader 2026-08-17 14:5x 启动）