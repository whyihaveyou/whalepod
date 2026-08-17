# WhalePod 团队面板 tarball 安装与接线（OOB）

> 作者：视觉-K3-1 · 2026-08-17 · 面向 OOB-1 总装（工程-Flash-4）
> 产物：`/tmp/whalepod-panel-pack/deepseek-ai-dsh-client-ui-whalepod-team-0.1.0-rc.5.tgz`（62 KB，46 文件）
> 源包：`deepseek-harness/packages/client/ui-whalepod-team`（commits ef7a597 / 1c215f6 / 19fca70 / 75e876d / 3ae8f83）

## 1. 打 tarball（源侧，已完成）

```bash
cd deepseek-harness/packages/client/ui-whalepod-team
pnpm bundle                                  # 出 lib/{index,invariant,client}.js + lib/types
pnpm pack --pack-destination /tmp/whalepod-panel-pack
```

**必须 `pnpm pack`，不能 `npm pack`**：包 peerDependencies 用 `workspace:^` 协议，npm 不解（报 `Unsupported URL Type "workspace:"`）；pnpm pack 会把 workspace 协议重写为真实版本号（`^0.1.0-rc.5` / `^4.0.1`）。tarball 内容：`lib/` 三入口 + `lib/types/**` + 双语 README + package.json。

## 2. 安装（装箱侧）

```bash
npm install --legacy-peer-deps \
  file:/tmp/whalepod-panel-pack/deepseek-ai-dsh-client-ui-whalepod-team-0.1.0-rc.5.tgz
```

- `--legacy-peer-deps` 必需：peer 里的 `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/cordis` 由 app runtime 自身提供，不要让 npm 去公网拉。
- 验证装载：`node --input-type=module -e "import('.../lib/invariant.js').then(m=>console.log(Object.keys(m)))"` → `apply,inject,name`。

## 3. 登记（两个表面，缺一不可）

包要被 dsh web 装载，runtime 需同时看到：

1. **cordis profile 加 dsh.client 行**（参照 `packages/bundle/web-app/cordis.patch.yml` 中已提交行）：

   ```yaml
   - id: ui-whalepod-team
     name: '@deepseek-ai/dsh-client-ui-whalepod-team'
   ```

2. **依赖可解析**：安装后的 `node_modules/@deepseek-ai/dsh-client-ui-whalepod-team` 必须在 app 的依赖解析路径上（workspace 里就是 web-app `package.json` 的 `workspace:^` 依赖 + pnpm 链接；装箱场景就是上一步的 file: 安装）。包内 `package.json` 已带 `dsh.client` manifest（inject: slots/locale/theme，platform web，immediately false），loader 自动读取。

## 4. 验证（已实测通过的步骤）

```bash
pnpm dsh web   # 起 http://127.0.0.1:3080
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-client-ui-whalepod-team/client.js
# 期望 200（~222KB 闭包工厂：window.__ModuleLoader__.load({id:"@deepseek-ai/dsh-client-ui-whalepod-team",...})）
```

浏览器侧：侧栏底部出现「团队面板」触发器（`.wp-trigger`），点击挂截面版浮层。面板数据走 honeycomb transport，需要 dev-server（`packages/honeycomb` 下 `pnpm run dev-server`，:4800）——注意 transport HTTP 已补 CORS（主仓 dd1f11f），旧进程需重启才生效。

## 5. 沙盒实测记录（2026-08-17，本卡验收证据）

- `/tmp/whalepod-sandbox` 全新目录 `npm install --legacy-peer-deps file:...tgz` → 1 package added，`lib/` 三入口齐，Node ESM 导入 `index.js`/`invariant.js` 导出形状正确；
- dsh web 依赖解析路径换指向沙盒安装副本 → 启动无错，`/plugins/.../client.js` 200（221,806B）；
- Playwright（无头 chromium）点触发器 → 面板挂载 → dev-server 真实数据（queen/worker）渲染，JS 零错误；
- 实测后环境已还原（workspace 链接、cordis 文件均复位）。

## 6. 已知边界

- 面板用 `--dsw-*` 语义 token 随宿主皮肤；全局样式以单个 `<style data-plugin>` 快照注入（`styles.inline.ts`，loader 卸载插件时自动清理）。
- 包不依赖 `@whalepod/honeycomb` npm 包（其 ESM 装箱门未修，见 #01a008c3）；transport 走包内自包含 local client（fetch/WS 薄封装），hive id 由面板 boot 时按 name 解析（默认 `hive-dev`）。
- 外部运行时依赖只有 `react` / `react-dom`（loader 模块表应答）。
