// ============================================================
// ui-whalepod-team 插件「可加载不炸」冒烟：
// 直接 import 构建产物 lib/index.mjs，用 recording stub ctx 调 apply(ctx)，
// 断言 client-module 契约（platform/immediately/inject）与槽位注册行为。
//
// 这是在脱离完整 harness web-app 的情况下，对「面板加载不炸」验收的
// 最小隔离验证 —— 不依赖 web-app、不碰 harness 仓，纯本 lane。
//
// ⚠️ 当前预期状态：RED（gated）——插件把 @whalepod/honeycomb 当 external，
// 而 honeycomb 构建产物在 Node ESM 下 100% 不可 import（type:module +
// moduleResolution:bundler → 74 处无扩展名相对导入，首个即
// ERR_MODULE_NOT_FOUND，详见 box-gate #01a008c3）。故此冒烟现在实测的是
// 「依赖链自 honeycomb 起断」，不是插件逻辑 bug。
// 装箱门解决（honeycomb 可被 Node/pnpm 正常 import）后此冒烟应转绿。
// 不接入 CI；是 dev 诊断工具。
//
// 运行：node test/plugin-smoke.mjs   （需先 npx tsdown 产出 lib/）
// ============================================================
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const PACK_NAME = "@deepseek-ai/dsh-client-ui-whalepod-team";

// Node 解析 .mjs：用绝对文件路径 import（含 query 防缓存）
const libPath = path.join(root, "lib", "index.mjs") + "?smoke=" + Date.now();
const mod = await import(libPath);

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra ? "  → " + JSON.stringify(extra) : ""}`);
  }
}

console.log("== client-module 契约 ==");
ok("platform === 'web'", mod.platform === "web", mod.platform);
ok("immediately === false", mod.immediately === false, mod.immediately);
ok(
  "inject = [slots, locale, theme]",
  Array.isArray(mod.inject) &&
    mod.inject.join(",") === "slots,locale,theme",
  mod.inject,
);
ok("apply 是函数", typeof mod.apply === "function");

console.log("== apply(ctx) 槽位注册（recording stub）==");
const registered = [];
const injected = [];
const slotsStub = {
  inject(name, fn) {
    injected.push(name);
    const reg = fn(); // 立即调用返回的 register 闭包
    if (reg && typeof reg.then === "function") {
      // 若 register 返回 promise，则接住（apply 是 async，闭包内可能同步返回）
      return reg;
    }
    return undefined;
  },
  register(opts, component) {
    registered.push({ opts, hasComponent: typeof component === "function" });
  },
};
const ctx = { slots: slotsStub };

try {
  await mod.apply(ctx);
  ok("apply 未抛异常（Promise resolved）", true);
} catch (e) {
  ok("apply 未抛异常（Promise resolved）", false, String(e && e.stack || e));
}

ok(
  "slots.inject 收到 sidebar.footer.action",
  injected.includes("sidebar.footer.action"),
  injected,
);
ok(
  "注入触发 register，registrant = PACK_NAME，且含 React 组件",
  registered.some(
    (r) =>
      r.opts.registrant === PACK_NAME &&
      r.opts.name === "sidebar.footer.action" &&
      r.opts.scope === "root" &&
      r.opts.kind === "list" &&
      r.hasComponent,
  ),
  registered,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
