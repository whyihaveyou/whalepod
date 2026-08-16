# 团队面板装进真实 dsh web — 嵌入方案（调研结论）

> Task #01a004b1-9056：「编排 UI 装进真实 dsh web」团队面板 → harness client plugin。
> 参照形态：`zhu1090093659/dsh-web-ui`（看板 / Git 图谱 / 右侧文件-SCM / 皮肤中心等 dsh client 插件集合）。
> 一键联调数据源：`packages/honeycomb` 下的 `pnpm run dev-server`（boot 真 cordis + 种子数据，HTTP/WS 同端 127.0.0.1:4800）。

---

## 0. 一句话结论

团队面板打包成一个**独立的 dsh client-module**（`@deepseek-ai/dsh-client-ui-whalepod-team`），用 **`sidebar.footer.action`（list, root）** 槽位加一个侧栏左上角入口（紧邻 Settings 设定），点击弹出自包含面板（roster/任务板/对话三视图）；数据层换成**真实 `@whalepod/honeycomb` 的 `createHoneycombClient`**（连 dev-server，不 mock，hiveId 动态解析）；样式**只消费 `--dsw-*` 语义 token**，天然跟随 dsh 10 款皮肤。

- **挂在哪**：`packages/client/<id>`（dsh 主仓内，`tsconfig.base.client.json` 一包一参考）→ `package.json` name `@deepseek-ai/dsh-client-<id>`。
- **怎么装**：三表面登记（tsconfig references + `web-app/cordis.patch.yml` 的 `dsh.client` 行 + `web-app/package.json` 依赖）；profile 里原子启停。
- **皮肤怎么跟**：只用 `--dsw-alias-*` + `ctx.theme`，一行映射包，不做自有硬编码色。

---

## 1. 调研结论 ①：参照形态 dsh-web-ui 怎么挂

`zhu1090093659/dsh-web-ui` 把「看板 / Git 图谱 / 右侧文件-SCM 面板 / 皮肤中心」做成一**组相互独立的 dsh client 插件**，再加一个**聚合包**统一装。

- 每个插件 = 一个可独立编译/安装的 client 包，各自注册进 dsh 的**槽位系统（SlotCore）**，不侵入核心。
- 插件通过**槽位**（sidebar 入口、workspace 面板、overlay）挂载 UI，而不是改 dsh 壳代码。
- 皮肤类插件向 `ui-theme` 注册皮肤，消费同一套 token。

**对本面板的启示**：团队面板本体 = 一个独立 client 包；不做成改 `ui-sidebar`/`ui-workspace` 壳的大 patch。聚合包只在要「一键全装」时存在（我们当前只交付面板单包）。

---

## 2. 调研结论 ②：harness client-module 三表面登记（含 aurora 教训）

dsh client 包的挂载 = **「三表面登记法」**，少一面都可能在 boot 时崩（aurora 事件教训：半登记导致 `window.__DSH_BOOT__` 扫描崩壳）。

| 表面 | 位置 | 作用 |
|---|---|---|
| ① 类型/构建 | 根 `tsconfig.client.json` 的 `references[]` + 包内 `tsconfig.json`（extends `tsconfig.base.client.json`，每个 workspace 依赖一条 reference） | 编译期可见 |
| ② 浏览器排班（dsh.client） | `packages/bundle/web-app/cordis.patch.yml` 注入 `- id: <id>` + `name: '@deepseek-ai/dsh-client-<id>'` | 运行时 `window.__DSH_BOOT__` 扫描加载 |
| ③ 依赖 | `packages/bundle/web-app/package.json` 的 `dependencies` + pnpm workspace 软链 | 打包期可达 |

**包内结构**（以 `ui-user-questions` 为模板，AGENTS.md「新增 client 包清单」）：
```
packages/client/<id>/
  package.json        # name: @deepseek-ai/dsh-client-<id>
  tsconfig.json       # extends tsconfig.base.client.json + references
  tsdown.config.ts    # 打包 entry
  src/index.ts        # re-export './client'
  src/invariant.ts    # invariant ctx+packName 断言
  src/client/index.ts # apply(ctx) — 插件体，注册槽位
  src/client/contract/slots.ts  # 可选：声明注入的面
  (optional) src/css-modules.d.ts
  README.md
```
`src/client/index.ts` 的骨架（来自 `ui-user-questions` 与 `ui-slots/src/index.ts` 的 `SlotCore.register`）：

```ts
export const inject = ["slots", "locale"];
export async function apply(ctx) {
  ctx.slots.inject("<owner>.api.thing", () =>
    ctx.slots.register({
      name: "<owner>.<surface>",        // 槽位名
      kind: "list", scope: "root",       // 槽位元数据须与宿主洞声明一致
      // children 声明 = 认领该槽位
    }, (props) => <MyEntry {...props} />),
  );
}
```

---

## 3. 面板入口：挂进哪个槽位

- **挂点**：`sidebar.footer.action`（`packages/client/ui-sidebar` 注册，`{ kind:'list'; scope:'root' }`，children 各注一行带 `wide` 标志）——这是侧栏脚部的一行操作入口（Likely 预留「+ 扩展」行 / 紧邻 Settings 设定）。
- **面板本体**：不开 workspace 换页（避免抢 `ui-workspace` 壳），而是由入口触发一个**自包含 overlay 面板**（类比 settings 壳行为），渲染 `App` 的 roster/任务板/对话三视图。
- 组件通过 `ComposedProps`（含 `slots`, `store`, `locale`, `theme`）拿会话上下文，不直接碰 conf/会话。

> 注意：`sidebar.footer.action` 是 list scope=root——注册进去即认领壳的这行；若未来壳换入口形态（如新增 `sidebar.workspaces` 类型洞），只需改本插件的 `register` 槽位名，业务三视图零改动。

---

## 4. 数据层：连真实 transport（不 mock）

用真实 SDK `@whalepod/honeycomb`（接口冻结，见 `docs/honeycomb-transport-api.md`）：

```ts
import { createHoneycombClient } from "@whalepod/honeycomb";
const client = createHoneycombClient({
  httpUrl: "http://127.0.0.1:4800/api/v1",
  wsUrl:  "ws://127.0.0.1:4800/ws",
});
await client.connect();
```

**关键点（联调情报已采纳）——hiveId 必须动态解析，不可硬编 `"hive-dev"`**：
honeycomb 的 hive id 是**自动生成**的（如 `hive_1_1tpms5z9`），不是 name。面板 boot 时必须：
1. `GET /v1/hives` 列出 hive；
2. 取 `name === "hive-dev"` 那条的 `id`；
3. 用解析出的 id `client.subscribe(hiveId)` 并驱动 `.task/.member/.message` 等域。

种子数据（dev-server）核对基线：
- `/v1/hives` → 1 条 `name=hive-dev`
- `/v1/hives/{id}/tasks` → 3 条（1 in-progress owner=worker + 2 backlog）
- 消息：queen→worker directive ×2 + 派工 report 落地

**DTO 对齐修正（复用原型 service 层时必须改的点）**：
| 面 | 原型本地 shim | 真实 SDK |
|---|---|---|
| MemberStatus | `hatching/idle/working/waiting/paused/dismissed/failed` | `hatching/idle/working/finished/failed/dormant` |
| MessageKind | `directive/report/chat/announcement/system` | `directive/report/note/shutdown-request/system` |
| hiveId | 硬编 `hive-dev` | `GET /v1/hives` 动态解析 |
| 重连 | shim 手动 `reconnect()` | SDK 内置指数退避自动重连 |

原型 `honeycombApi.ts` 里 `sendMessage` 用了 `kind: "chat"` → 需改 `"note"`（真实 MessageKind 无 `chat`）。

---

## 5. 皮肤怎么跟（10 款皮肤跟随主题）

- **唯一实现**：面板样式**只消费 dsh 的 `--dsw-*` 语义 token**（`--dsw-alias-bg-base / -surface / -elevated`、`--dsw-alias-brand-primary`、`--dsw-alias-label-primary/secondary/disabled`、`--dsw-alias-border-*`、`--dsw-alias-status-*` 等），**所有组件零硬编码色值**。
- **跟随机制**：10 款皮肤是 base palette + `ui-theme` registry 的 alias-token 覆盖；切肤触发 `theme/change`。面板不做自己的皮肤注册表，直接吃 `--dsw-*` 变量即可随主题整体切换；需要强语义（如「活跃 agent 火花青」）时通过 `ctx.theme.getTheme().tokens` 取值，或用 `--dsw-alias-*-accent` 派生。
- **本面板 token 映射**（design/team-panel/design-tokens.md 的 `--accent/--status-*` 名照搬语义层，值层指到 `--dsw-*`）：

| 面板语义 token | 取 dsh |
|---|---|
| `--accent` / `--brand-primary` | `--dsw-alias-brand-primary` |
| `--bg-app/-surface/-elevated` | `--dsw-alias-bg-base/-surface/-elevated` |
| `--text-primary/secondary/disabled` | `--dsw-alias-label-primary/secondary/disabled` |
| `--border-default/strong` | `--dsw-alias-border-default/strong` |
| `--status-active/-idle/-danger/-progress/-done/-warn` | `--dsw-alias-status-*`（无则取语义色 + accent 派生） |
| `--shadow-*` / `--radius-*` / `--font-*` | 直接消费 dsh 对应 token |

这些 `--dsw-*` 变量已随 dsh 主题注入 DOM，面板直接引用、随皮肤自动更值——不需要也不应该自建皮肤。

---

## 6. 交付物落位清单

| 交付 | 位置 |
|---|---|
| 本调研文档 | `docs/panel-embedding-plan.md` |
| 插件包（独立可装、可 typecheck） | `prototypes/team-panel/plugin/`（过渡目录；结构对齐 dsh client 包，含 `src/client/index.ts`=apply 主体、`contract/slots.ts`、`invariant.ts`、`tsconfig.json`、`tsdown.config.ts`、`package.json`） |
| 真实 transport 绑定 + hive 动态解析 | `plugin/` 内 `client/teamApi-real.ts` + 对原型 `useTeamStore` 的 `setTeamApi` 注入位 |
| 三视图渲染 | 复用原型 `App`（roster/board/chat），插件以 overlay 面板承载 |
| 安装说明 | 见下方 §7 + `prototypes/team-panel/plugin/README.md` |

三表面登记（属 deepseek-harness 主仓，需 leader 推送时落，见 §7 的 patch）。

---

## 7. 安装说明（profile 启停 / 三表面 patch）

**A. 包本体**（本仓 / 或 deepseek-harness `packages/client/ui-whalepod-team`）：
- `package.json` name：`@deepseek-ai/dsh-client-ui-whalepod-team`
- 已含 `src/index.ts`（re-export client）+ `src/client/index.ts`（apply 主体）。

**B. 三表面登记（deepseek-harness 主仓，4 处 patch，交付时一并给 leader）**：
1. 根 `tsconfig.client.json` `references` 加：
   ```json
   { "path": "./packages/client/ui-whalepod-team" }
   ```
2. `packages/bundle/web-app/cordis.patch.yml` 的 `dsh.client` 注入块加行：
   ```yaml
   - id: ui-whalepod-team
     name: "@deepseek-ai/dsh-client-ui-whalepod-team"
   ```
3. `packages/bundle/web-app/package.json` `dependencies` 加 `"@deepseek-ai/dsh-client-ui-whalepod-team": "workspace:*"`。
4. pnpm workspace（`packages/client` 纳入 glob 则无需额外操作）装一次 `pnpm install` 建软链。

profile 启停（按 dsh 的 profile/禁用机制）：
- **启用**：把该包 `dsh.client` 行留在 `cordis.patch.yml` 注入清单（或 profile 的启用集），重启 dsh → 侧栏脚出现面板入口。
- **禁用**：从 `cordis.patch.yml`/profile 移除该行（或从启用集剔除）、`web-app` dependencies 去掉依赖，重启即干净卸载；三视图/数据层不碰壳，零残留。
- （本地试装物理法）把 `packages/client/ui-whalepod-team` 软链进 workspace 后 `pnpm install` + 重启 dsh web。

> 半登记崩壳风险（aurora 教训）：三面**必须同时**落。先加编译面（不停机），再上 cordis 运行时行——运行时行是真正让 boot 扫描到的开关。
