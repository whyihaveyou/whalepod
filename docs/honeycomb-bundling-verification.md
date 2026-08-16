# honeycomb 装箱 V1-V3 验证

> 任务 `#01a0091a-488f-7002-80dd-cad5fdd6d466`。对 `docs/honeycomb-app-bundling.md`（Q4 路线 B）的三个待验证点做**证据驱动**验证。
> 本卡只验证、不写实现。所有结论均带源码路径/行号或命令输出。

---

## V1 — profile 自举是否认外部依赖（谁把 `@dsh-suite/*` 写进 profile package.json）

### 结论
**profile 自举（`initProfile`）只写 `dependencies: {}` + 模板 bundles，本身不认任何额外依赖。**
装机里 `@dsh-suite/plugin-deus`、`@dsh-suite/plugin-manager` 是被 **`dsh plugin --profile <name> add <pkg>`**
命令写进去的（它先 `pnpm add` 写进 `dependencies`，再 reconcile 把「导出 patch 的依赖」追加进 `dsh.profile.bundles`）。
而运行时 `loadProfile` 的 patch 合成**只读 `dsh.profile.bundles`（bundle 声明列表），不读 `dependencies`**——
`pnpm install` 才读 `dependencies`。二者分工：**`dependencies` = 安装清单，`bundles` = 合成顺序清单。**

### 证据

**① 自举模板不含任何额外依赖** — `packages/boot/app-boot/src/profile.ts`：
```ts
114  export const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
115    web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],   // 仅 2 个标准 bundle
116    headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
117  }
152  export function initProfile(dir, bundles): void {
159      dependencies: {},                                        // 自举时 dependencies 恒为空
160      dsh: { profile: { bundles: [...bundles] } },             // bundles = 模板传入的 2 个
```

**② `loadProfile` 只枚举 bundles、不读 dependencies** — 同文件 `profile.ts`：
```ts
387  const bundles = manifest.dsh?.profile?.bundles ?? []
388  const layers = bundles.map((packageName): ProfileLayer => {
389    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
```
`resolveBundleDir`（`profile.ts:344`）从「安装锚点 → profile 目录」双锚解析，参与的是 **bundle 名**，与 `dependencies` 无关。

**③ 谁写进 `@dsh-suite/*`：`dsh plugin` 命令** — `apps/cli/src/plugin.ts`：
```ts
120  export function runPlugin(profile, args): number {
129    const result = spawnSync('pnpm', args.map(...), { cwd: dir, ... })  // pnpm add 写 dependencies
144    reconcilePlugins(before, dir)                                       // 再同步 bundles
59   function reconcilePlugins(before, profileDir): void {
62    const dependencies = Object.keys(after.dependencies ?? {})
65    for (const packageName of dependencies) {
66      const isBundle = exportsPatch(packageName, profileDir)   // manifest.dsh?.bundle?.patch !== undefined
72      if (isBundle) plugins.push(packageName)                  // 导出 patch → 追加进 bundles
89    after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } }
36   function exportsPatch(packageName, profileDir): boolean {
44    return manifest.dsh?.bundle?.patch !== undefined
```

**④ 装机实况** — `~/Library/Application Support/WhalePod/harness/profiles/web/package.json`：
```json
{
  "dependencies": {
    "@dsh-suite/plugin-deus": "...",       // ← 非模板，由 dsh plugin add 写入
    "@dsh-suite/plugin-manager": "..."      // ← 同上
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
                            "@dsh-suite/plugin-deus", "@dsh-suite/plugin-manager"] } }
}
```

### 对装箱 Q4 路线 B 的含义
- 「dsh 只认 bundle 声明的包」**不准确**——运行时 patch 合成认 `bundles`，但**谁进 node_modules 由 `dependencies` + pnpm 决定**。
- 离线装箱要注入 `@whalepod/honeycomb`，等价于预置一个「bundle 型插件」：既要在 `bundles` 里声明（被 loader 枚举做 patch 合成），
  也要让包在 node_modules 里可解析（`dependencies` 或直接预置 node_modules / shared flat fallback，见 V2）。
- 这证实了设计文档「resources 侧预置 + profile 侧 sync 两步都是**脚本改动**、非 Swift」的判断。

---

## V2 — cordis-plugin-loader 解析插件 name 的 node_modules 层级

### 结论
**两者都用，且是有序的 Node 裸说明符父目录上溯（parent-walk），profile 私有层优先、共享层兜底：**
1. **`profiles/<name>/node_modules`（profile 私有）** — 先查；pnpm 为该 profile 管理的外部（out-of-tree）插件在这里
   （实测 `@dsh-suite/*` 就在 `profiles/web/node_modules/@dsh-suite/`）。
2. **`profiles/node_modules`（跨 profile 共享 flat fallback）** — profile 自己的 node_modules 里没有时，父目录上溯命中；
   由 `healProfilesModuleFallback` 维护（对 app manifest 依赖闭包 BFS，每个包装一个 symlink，实测 195 个 `@deepseek-ai/*`）。

不是「二选一」，而是一条上溯链：**私有层 wins，共享层兜底**。loader 的 `baseUrl` = profile 目录。

### 证据

**① loader 的 import 路径（裸说明符 → Node 解析，baseUrl 起）** — `apps/cli/node_modules/@deepseek-ai/cordis-plugin-loader/src/config/tree.ts`：
```ts
145  async import(name, stack, options) {
154    if (loader mirror is active) return internal.import(name, this.ctx.baseUrl, {})
156    if (name.startsWith('.')) return import(new URL(name, this.ctx.baseUrl))
159    return import(name)        // 裸包名 → Node 默认解析 = 自 baseUrl 起父目录上溯
```
Entry 调用点是 `src/config/entry.ts`：`this.parent.tree.import(this.options.name, ...)`（name = 插件模块说明符）。
loader `baseUrl` 由 profiling 设置，= profile 目录（`src/index.ts:80` `ctx.baseUrl = config.baseUrl`）。

**② 双锚 + 共享 flat fallback 的官方声明** — `packages/boot/app-boot/src/profile.ts` module doc 与实现：
```
15  Module resolution is two-anchor ... The Loader's `baseUrl` is the profile
16  directory, whose `node_modules` pnpm manages for out-of-tree plugins, while
17  the maintained flat fallback directory `$DSH_HOME/profiles/node_modules`
20  ...makes every in-box plugin Node-resolvable from any profile through the
21  ordinary parent-walk.
```
```ts
207  // over `dependencies` from the app manifest), each resolved from its own
210  // resolves without pnpm ever managing it — the exact "bundles come from the
211  // installation" contract.
223  export function healProfilesModuleFallback(...) {
255    // BFS over app manifest closure, symlink each pkg into profiles/node_modules
```

**③ 磁盘实证（本机装机 state）**：
```bash
# profile 私有层：@dsh-suite 在 web profile 自己的 node_modules
$ cd ~/Library/Application\ Support/WhalePod/harness/profiles/web
$ node -e "console.log(require.resolve('@dsh-suite/plugin-deus'))"
→ .../profiles/web/node_modules/@dsh-suite/plugin-deus/lib/index.js

# 共享层：profiles/node_modules/@deepseek-ai 有 195 个包（含 cordis-plugin-loader、dsh-web-app…）
$ ls profiles/node_modules/@deepseek-ai/ | wc -l   → 195
# （含 cordis-plugin-loader / dsh-web-app / dsh-base / schemastery 等全套）

# in-box 包从 web profile 可解析（本机为 dev-workspace 链接情形）
$ cd .../profiles/web && node -e "console.log(require.resolve('@deepseek-ai/dsh-web-app'))"
→ /Users/qzp/aion2dsh/deepseek-harness/packages/bundle/web-app/lib/index.js
```
> 注：本机是 dev 机器，profile 经 pnpm-workspace 链接到本地 `deepseek-harness` checkout，所以 in-box 包解析到仓库源码。
> 装箱 app 里会是全新 runtime，in-box 包解析到 `Resources/node_modules`（ship-node 层）；**上溯链机制不变**。

### 对装箱 Q4 路线 B 的含义
- 把 `@whalepod/honeycomb` 放入 `profiles/node_modules`（共享层）即可让**任何** profile 通过父目录上溯解析到它——
  无需为每个 profile 单独 pnpm install。这正是 `healProfilesModuleFallback` 的设计意图（BFS 闭包 + symlink）。
- profile 私有层（`profiles/web/node_modules`）才是 pnpm 管理的外来插件位；装箱若走 tarball/预置，放共享层更省事且离线友好。

---

## V3 — patch 层幂等：cordis.patch.yml 的 plugin 行按什么去重？重复同 id 行会发生什么？

### 结论
**去重键是 `id`（不是 `name`）。** `name` 只是**校验守卫**，不参与选择。
- **重复 append 同一个 `id` 的非插入行 = 对同一 entry 做 in-place 字段合并/覆盖，last-wins，不双加载、不报错**。
- `name` 不匹配 → 警告并 **skip**（该行整体不生效）。
- `id` 指不到任何 entry → 警告并 **skip**，不建新 entry。
- 实测生成树中同 id 恒为 **1 个实例**（无重复实例 → 无双加载风险）。

### 证据（源码行号）
**① `applyEntryPatches`（patch 合成核心）** — `apps/cli/node_modules/@deepseek-ai/cordis-plugin-include/src/index.ts`：
```ts
66   function buildMap(data) { for (...) if (entry.id) entryMap.set(entry.id, entry) }   // 按 id 建 map（去重键）
80-92  // INSERT 分支：带 id 的 insert 目标 = 某 group；不带 id 直接 root append
105   for (const patch of patches) {
110     const target = entryMap.get(id)         // 非插入行按 id 找 target
112     if (!target) { warn('entry %C not found'); continue }     // 找不到 → skip
116     if (patch.name && patch.name !== target.name) {
119       warn(`name mismatch for %C ... skipping`); continue    // name 校验守卫
121     for (const [key, value] of Object.entries(rest)) target[key] = value   // 同 target 逐字段覆盖
```
**关键**：`buildMap` 把每个 `id` 只映射一个 entry；重复同 `id` 的多行 patch **全落在同一个 `target` 对象上**盖字段 —— 不新增 entry。

**② 合成序** — `packages/boot/app-boot/src/profile.ts` module doc：
```
11  composed by applying each bundle's patch list in `dsh.profile.bundles`
12  order over an empty entry list, then the profile's own patches, then any
13  launcher layers.
```

### 证据（命令输出：用官方 `dsh --dump-config` 离线合成器实测，未动装机 profile）
用 `--patch` 覆盖层演示（等价于 cordis.patch.yml 追加行），目标 id 用装机里真实的 `ui-theme-aurora` 行：

**EXP A — 覆盖层用已有 `id: ui-theme-aurora`（改 `config.variant`），应字段合并不进新实例**：
```bash
# /tmp/v3-patchA.yml:  `- id: ui-theme-aurora / config: { variant: test-variant-a }`
$ dsh --profile web --dump-config --patch /tmp/v3-patchA.yml | grep -A4 ui-theme-aurora
  - id: ui-theme-aurora
    name: '@deepseek-ai/dsh-client-ui-theme-aurora'
    disabled: true                              # ← 原 disabled 保留（字段合并）
    config: { variant: test-variant-a }          # ← 新增字段（覆盖/合并同一 entry）
```
→ 同一 entry 被合并；**无第二个实例、无报错**。

**EXP B — 同一覆盖层里两个相同 `id` 行（disabled:true 再 disabled:false），应 last-wins**：
```bash
# /tmp/v3-patchB.yml:  两行都 `id: ui-theme-aurora`（disabled true / false）
$ dsh --profile web --dump-config --patch /tmp/v3-patchB.yml | grep -A4 ui-theme-aurora
  - id: ui-theme-aurora
    ...  disabled: false                        # ← 后一行覆盖前一行（last-wins）
```
**EXP B 实例计数**（三组均=1，证无双加载）：
```
baseline: 1       (id: ui-theme-aurora 出现次数)
EXP A:    1
EXP B:    1
EXP C:    1
```

**EXP C — 对的行 + 错的 name，应 skip 且警告**：
```bash
# /tmp/v3-patchC.yml:  id: ui-theme-aurora / name: '@deepseek-ai/not-the-right-package'
$ dsh --profile web --dump-config --patch /tmp/v3-patchC.yml 2>/tmp/v3C-err | tail -40
(stderr) dsh: [/tmp/v3-patchC.yml] patch: name mismatch for "ui-theme-aurora"
         (expected "@deepseek-ai/dsh-client-ui-theme-aurora", got "@deepseek-ai/not-the-right-package"), skipping
(dump)  ... ui-theme-aurora 保持原样（该行整体不生效）
```

**EXP D — 指到不存在的 id，应 warn + skip 不建新 entry**：
```bash
# /tmp/v3-patchD.yml:  `- id: no-such-entry-xyz`
(stderr) dsh: [/tmp/v3-patchD.yml] patch: entry "no-such-entry-xyz" not found
(dump)   无该 id 输出（grep 计数 = 0）
```

> 上述 dump-config 命令与装机 profile 只读合成、覆盖层文件在 /tmp，**未改动用户的 cordis.patch.yml / package.json**。

---

## 汇总（对装箱 Q4 路线 B 的最终判定）

| 验证点 | 结论 | 证据强度 |
| --- | --- | --- |
| V1 profile 自举外部依赖 | 自举只写空 deps+模板 bundles；`@dsh-suite` 由 `dsh plugin add` 写入 deps **和** bundles；运行时合成只读 `bundles` | 源码 `profile.ts:114-160,387-389` + `plugin.ts:59-89,120-129` + 装机 package.json |
| V2 loader 解析层级 | 双锚父目录上溯：`profiles/<name>/node_modules`（私有，先查）+ `profiles/node_modules`（共享兜底，BFS symlink 195 包） | 源码 `tree.ts:145-159` + `profile.ts:15-21,223-255` + `require.resolve` 实测 |
| V3 patch 幂等 | 去重键 = `id`；`name` 仅校验守卫；重复同 id = in-place last-wins 覆盖、不双加载、不报错；错 name/空 id = warn+skip | 源码 `cordis-plugin-include/index.ts:66-121` + 4 组 `dsh --dump-config` 实测输出 |

**装箱落地要点**：`@whalepod/honeycomb` 应作为「bundle 型插件」（带 `dsh.bundle.patch`）注入 ——
① 放 `profiles/node_modules`（共享层，父目录上溯即达，离线友好）；
② 在 profile `dsh.profile.bundles` 里追加它的包名（loader 才枚举它做 patch 合成）。
两步均**脚本改动**（packaging/seed），零 Swift 改动 —— 与设计文档 Q4 路线 B 结论一致。
