// ============================================================
// ui-whalepod-team — 团队面板 dsh client plugin（browser 主体）
// 挂点：`sidebar.footer.action`（list, root）。
// 数据：真实 @whalepod/honeycomb transport（不 mock）。
// 皮肤：--dsw-* 语义 token（随 dsh 10 款皮肤）。
//
// 结构对齐 harness client 包（AGENTS.md「新增 client 包清单」）：
//   src/index.ts → re-export ./client
//   src/client/index.ts → apply(ctx) 挂槽位 + 挂 overlay 面板
// 含 JSX 的组件放 .tsx（TeamPanelTrigger.tsx / TeamPanel.tsx），本文件纯 TS。
// ============================================================
import { PACK_NAME, assertPackName } from "../invariant";
import { TeamPanelTrigger } from "./TeamPanelTrigger";

// 运行在 browser（dsh web），不涉 server
export const platform = "web";
/** 非立即执行：由 dsh 排班后按需 apply */
export const immediately = false;

// 依赖注入面：slots（挂槽位）+ locale（文案）+ theme（皮肤）
export const inject = ["slots", "locale", "theme"];

// 插件承接的 service 配置（dsh conf 可注入真实端点）
export interface PluginConfig {
  httpUrl?: string;
  wsUrl?: string;
  hiveName?: string;
}

// ------------------------------------------------------------
// 插件体 apply(ctx)
// ------------------------------------------------------------
export async function apply(ctx: unknown): Promise<void> {
  assertPackName(PACK_NAME);

  // 先把团队面板挂进 `sidebar.footer.action`（list, root）。
  // 槽位/登记 API 随真实 dsh SlotCore 落位时对齐（见 contract/slots.ts 注释）；
  // 这里按「认领 = register」的语义，把触发器作为该槽位的一个 children 注入。
  const slots = (ctx as { slots?: unknown })?.slots;
  if (!slots || typeof (slots as Record<string, unknown>).inject !== "function") {
    // 无 slots 环境（如独立跑原型/无侧栏宿主）= 退化为不注册，仅暴露 API 供外部挂载
    return;
  }

  const slotCtx = slots as {
    inject: (name: string, fn: () => unknown) => unknown;
    register: (opts: Record<string, unknown>, component: unknown) => unknown;
  };

  slotCtx.inject("sidebar.footer.action", () =>
    slotCtx.register(
      {
        name: "sidebar.footer.action",
        kind: "list",
        scope: "root",
        registrant: PACK_NAME,
      },
      TeamPanelTrigger,
    ),
  );
}
