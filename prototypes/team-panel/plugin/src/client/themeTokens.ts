// ============================================================
// 皮肤适配层 — 把 dsh 的 `--dsw-*` 语义 token 映射成面板语义 token。
//
// 原则（docs/panel-embedding-plan.md §5）：
//  面板不建自有皮肤注册表、不用硬编码色；所有颜色只从 dsh 皮肤变量取，
//  切肤（10 款）时面板随 `--dsw-*` 整树自动更值，零改动跟随主题。
//
// 用法：把返回的规则串注入面板根容器的 <style>，面板内 `var(--bg-app)` 等
// 语义变量即解析到当前 dsh 皮肤的对应色。色值*不在*这里写死，全部引用
// `--dsw-*`，dsh 主题负责给真值。
// ============================================================

export const PANEL_SCOPE = ".whalepod-team";

/**
 * 面板语义 token → dsh `--dsw-*`（覆盖 .whalepod-team 作用域）。
 * dsh 未提供的语义（如专属 status 语义）退而引用 `--dsw-alias-status-*`
 * 或派生 accent。这些变量由 dsh 主题在 :root 注入，shadow/inline 树继承。
 */
export const panelTokenRules = `${PANEL_SCOPE} {
  /* 品牌/强调 */
  --accent: var(--dsw-alias-brand-primary);
  --accent-subtle: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
  --brand-primary: var(--dsw-alias-brand-primary);

  /* 背景 */
  --bg-app: var(--dsw-alias-bg-base);
  --bg-surface: var(--dsw-alias-bg-surface);
  --bg-elevated: var(--dsw-alias-bg-elevated);
  --bg-hover: color-mix(in srgb, var(--dsw-alias-bg-elevated) 50%, transparent);

  /* 文本 */
  --text-primary: var(--dsw-alias-label-primary);
  --text-secondary: var(--dsw-alias-label-secondary);
  --text-tertiary: var(--dsw-alias-label-tetriary, var(--dsw-alias-label-secondary));
  --text-disabled: var(--dsw-alias-label-disabled);

  /* 边框 */
  --border-default: var(--dsw-alias-border-default);
  --border-strong: var(--dsw-alias-border-strong);

  /* 状态色（语义）
     dsh 皮肤如未细分 status，退到一小组语义别名；够三视图 badge 用。 */
  --status-active: var(--dsw-alias-status-info, var(--dsw-alias-brand-primary));
  --status-idle: var(--dsw-alias-status-muted, var(--dsw-alias-label-secondary));
  --status-done: var(--dsw-alias-status-success, var(--dsw-alias-status-ok));
  --status-danger: var(--dsw-alias-status-danger, var(--dsw-alias-status-error));
  --status-warn: var(--dsw-alias-status-warning, var(--dsw-alias-status-danger));
  --status-progress: var(--dsw-alias-status-progress, var(--dsw-alias-brand-primary));
  --status-offline: var(--dsw-alias-status-muted, var(--dsw-alias-label-disabled));

  /* 布局/动效随 dsh */
  --radius-*: inherit;
  --shadow-*: inherit;
  --space-*: inherit;
  --text-*: inherit;
}`;
