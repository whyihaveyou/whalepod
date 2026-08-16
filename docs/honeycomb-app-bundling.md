# honeycomb 装箱设计：多 agent 运行时装进发版 app

> **状态**：v1（Leader 起草，2026-08-16，关键机制均经磁盘实证）→ 编排-Pro 审补（其 npm 分发面调研 /tmp/aw*.md 已存 docs/research-notes/）
> **卡**：#01a008c3 设计阶段。phase 2 实施另拆卡。
> **背景**：发版 app 只装上游 `@deepseek-ai/dsh@0.1.0-rc.6`（build-runtime.sh 单包 install）；@whalepod/honeycomb 未进装机，团队面板在装机内无 honeycomb 可连。这是「代码完成 → 产品真能用多 agent」的最后一公里。

---

## Q1 加载机制：honeycomb 只能作为 dsh 内插件（同进程，不可独立进程）

**结论先行**：honeycomb 必须以 cordis 插件行注入 dsh 的 patch 层，装载进与 dsh 核心同一个 cordis 实例。

**证据链**（全部实测）：
1. `native-runtime` 的 `attach()` 必须拿 `ctx.agents`（DSH AgentRegistry）——`packages/honeycomb/src/runtime/native-runtime.ts` L44-55。独立进程拿不到 dsh 的 ctx.agents，故「只能作为 dsh 内插件」成立。
2. dsh 的插件装载走 **cordis patch 层**：每个 profile 由若干 patch layer 合成，插件行格式 `- id: X, name: '@scope/pkg', config: {...}`（deepseek-harness `packages/bundle/base/cordis.patch.yml` 注释原文）。
3. **装机里该机制已在运转**：`~/Library/Application Support/WhalePod/harness/profiles/web/cordis.patch.yml` 存在用户 patch 层（现有 aurora disabled 行 + @dsh-suite 注释为前例）；`profiles/node_modules/` 含全套 cordis-plugin-loader 等装载器。
4. honeycomb 被 cordis loader 真实加载过：`honeycomb-adaptor/` verify-load + verify-loader 双 PASS（dev dsh 实例，含 `requireNodeModulesIdentity` 双实例探针——见 docs/harness-plugin-integration.md）。

**插件行（目标形态）**：
```yaml
- id: honeycomb
  name: '@whalepod/honeycomb'
  config:
    storagePath: <事实日志落盘目录>
    transport:
      port: <见 Q3>
```

## Q2 分发形态：npm pack tarball 本地安装（推荐 b）

| 方案 | 可复现 | 版本锁 | CI 离线 | 签名影响 | 基建成本 |
|---|---|---|---|---|---|
| (a) 发 npm + build-runtime.sh 加依赖 | ✅（lockfile） | ✅ | ❌ 依赖 registry | 无 | 需 npm 账号 + 发版自动化 + token 管理 |
| (b) **本地 `npm pack` → tarball → build-runtime.sh 装 tarball** | ✅（tarball 内容哈希） | ✅（文件名带版本+sha256 记录） | ✅ | 无（JS 不单独签名，随 app ad-hoc） | 零外部基建 |
| (c) 拷 lib/ 进 Resources/node_modules | ⚠️ | 弱 | ✅ | 无 | 最低但最脆：需手工维护 package.json 元数据，peerDeps 解析无保障 |

**推荐 (b)**：
```bash
# packages/honeycomb 构建后
npm pack  # → whalepod-honeycomb-0.1.0.tgz
# build-runtime.sh 第 2 步扩展：
npm install ./honeycomb-tarball/whalepod-honeycomb-*.tgz --omit=dev
```
- 与 dsh 全家桶同一 npm install 事务 → **cordis/schemastery peerDeps 自然去重**（honeycomb package.json 已声明 cordis ^4.0.1 + schemastery ^3.18.1 为 peerDependency，不 bundle 双实例）。
- 落地后跑一次 `requireNodeModulesIdentity` 式断言（adaptor 已有现成探针代码）确认 cordis 单实例。
- 体积增量：honeycomb lib ~1-2MB，对 340MB 的 Resources/node_modules 无感。

**注意**：装进 Resources/node_modules 只解决「app 里有这个包」；dsh 运行时从 **DSH_HOME profile 的 node_modules** 解析插件（见 Q4 的注入路径）。

## Q3 端口接线：独立端口 + patch config 声明（面板侧已知发现机制）

- honeycomb transport 是**独立 HTTP+WS server**（`createNodeTransportServer`，plugin.ts L77-104），不寄生 dsh 端口。
- **推荐**：patch 插件行 config 里给固定端口（alpha 阶段建议沿用 dev-server 语义 `4800`，冲突时 phase 2 再上动态+发现文件）。理由：面板 `createHoneycombClient({httpUrl, wsUrl})`（transport/client/index.ts 实测签名）需要确定地址；固定端口让面板/Swift/文档三方口径一致，alpha 可接受。
- 面板发现路径（对齐 实现-Pro-1 的三表面工作）：装机场景 hiveId/端口从 patch config 取（与 dev-server :4800 语义一致，面板代码无需分支）。
- **不复用 dsh 端口**：honeycomb 路由命名空间（/v1/hives…）与 dsh web API 混挂会污染上游路由，且独立端口便于看门狗/冒烟独立验证。

## Q4 Swift/config 触点：零 Swift 改动可行（路线 B），路线 A 备选

装机启动链实测：`RuntimeBootstrap.swift` → `bin web --port N`（bundled node），DSH_HOME 由 `HarnessServiceManager.mergedEnvironment()` 注入 `~/Library/Application Support/WhalePod/harness`（config.environment 可扩展）。

**路线 B（推荐，零 Swift 改动）**：
1. profile 的用户 patch 层 `DSH_HOME/profiles/web/cordis.patch.yml` 是**可编辑数据文件**（aurora 行前例证明可写）——由打包/OOBE 侧脚本把 honeycomb 插件行 append 进去；
2. `@whalepod/honeycomb` 需出现在 profile 可解析的 node_modules（`profiles/web/node_modules` 或 `profiles/node_modules`）。

**待验证点（phase 2 第一步）**：
- V1：profile 自举（dsh web 首启建 profiles/web 并 pnpm install）时，**额外依赖如何进入**？现有 @dsh-suite 包是谁写进 profile package.json 的——若 dsh 只认 bundle 声明的包，需在 Resources 侧预置 + profile 侧 sync 步骤（仍是脚本改动，非 Swift）。
- V2：cordis-plugin-loader 从 `profiles/node_modules`（共享层）解析 name 是否成立，还是必须 `profiles/web/node_modules`。
- V3：patch 层 append 的幂等写法（重复启动不重复加行）。

**路线 A（备选，需 Swift）**：dsh CLI 实测支持 `--patch <yml>`（可重复，bin.js L24-25）——RuntimeBootstrap 启动参数加 `--patch Resources/honeycomb-patch.yml`。⚠️ RuntimeBootstrap.swift 归 M0 owner，本设计**只出需求清单**：①启动参数追加 --patch；②patch 文件随 Resources 分发。由 Leader 协调 Swift owner 排期。

**config.json**：无需新增字段（端口/存储都在 patch config 内）；若 V1 结论需要环境开关，走 config.environment 既有扩展点。

## Q5 最小改动集 + 风险表

**⚠️ 前置阻断项（2026-08-16 实现-Pro-1 实测发现）**：`@whalepod/honeycomb` 当前 lib/ 产物在 **Node ESM 下不可 import**——tsconfig `moduleResolution: bundler` 使 tsc 产出 74 处无扩展名相对导入（`import './context'`），Node ESM 首行即 `ERR_MODULE_NOT_FOUND`。**即使发到 npm，消费者 import 也必炸**。phase 2 第 0 步必须先修：tsconfig 改 `node16`/`nodenext`（tsc 自动给 ESM 输出补 `.js` 扩展）+ 重建 lib + 全量测试回归 + 真 Node ESM import 冒烟。

**Phase 2 改动清单**（全部 Scripts/数据面，零 Swift 零 src/ 冻结面）：
| # | 文件/动作 | 内容 |
|---|---|---|
| 0 | `packages/honeycomb/tsconfig.json` | moduleResolution → nodenext（构建配置非接口面），修 ESM 扩展名阻断 |
| 1 | `packages/honeycomb` 构建产物 | `npm pack` 出 tarball（CI/本地同命令） |
| 2 | `HarnessShell/Scripts/build-runtime.sh` | npm install 追加 honeycomb tarball（同事务，peer 去重） |
| 3 | profile seed 脚本（新增） | 幂等写 honeycomb 插件行进 DSH_HOME/profiles/web/cordis.patch.yml + 包同步（依 V1/V2 结论定形态） |
| 4 | 验证步骤 | requireNodeModulesIdentity cordis 单实例断言 + verify-load 冒烟（真 Node ESM import）+ 面板连 :4800 真数据 |

**风险表**：
| 风险 | 等级 | 缓解 |
|---|---|---|
| cordis 双实例（honeycomb 自带一份） | 高 | peerDependency 已声明；同事务 install 去重；落地跑 identity 断言 |
| **lib 产物 Node ESM 不可 import**（前置阻断） | **高** | phase 2 第 0 步修 tsconfig nodenext + 全量回归 + 真 import 冒烟 |
| 版本漂移（honeycomb vs dsh-cordis） | 中 | tarball 文件名锁版本 + 构建时校验 cordis 版本区间 |
| profile 自举不认外部依赖（V1 不通过） | 中 | 降级路线 A（Swift --patch）或 Resources→profile sync |
| 体积膨胀 | 低 | ~1-2MB，无感 |
| ad-hoc 签名 | 低 | JS 资源不单独签名，随 app 整体签 |
| 离线可复现 | 低 | tarball 方案天然离线；profile pnpm install 若依赖 registry 需预置 node_modules（与 OOBE-M0 运行时自举同源问题） |

---

## 决策摘要
1. **只能同进程插件**（ctx.agents 硬依赖）→ patch 层插件行注入。
2. **npm pack tarball** 进 build-runtime.sh 同事务安装（peer 去重 + 离线可复现）。
3. **独立端口 4800**（alpha 固定，面板发现机制不变）。
4. **零 Swift 路线 B 优先**（profile patch + node_modules 注入），V1-V3 验证不过则路线 A（Swift 需求清单已备好，不动手）。
5. phase 2 实施：编排-Pro 牵头——第 0 步先修 honeycomb ESM 产物阻断（见 Q5 前置项），再跑 V1-V3 验证，然后按上表 1-4 步走。
