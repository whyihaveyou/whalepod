// ============================================================
// 皮肤适配声明 — 团队面板给 dsh 的注入面：
//   挂点：`sidebar.footer.action`（list, root） — 侧栏脚部入口行。
//
// 注：dsh 的 SlotMap 是可增广 interface（declaration merging）。
// 这里仅做声明示意（结构对齐 ui-sidebar 的洞）；真值型别随 harness 落位时
// 由 `@deepseek-ai/dsh` 的 SlotMap 增广补全（见 panel-embedding-plan §3）。
// ============================================================

/** 我们认领的槽位集合 */
export interface WhalePodTeamSlots {
  /** 侧栏脚入口行 props */
  "sidebar.footer.action": {
    /** 折叠/展开态下宽窄布局 */
    wide?: boolean;
  };
}
