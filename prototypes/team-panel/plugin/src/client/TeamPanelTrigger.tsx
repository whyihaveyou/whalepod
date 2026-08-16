// ============================================================
// TeamPanelTrigger — 侧栏 `sidebar.footer.action` 的触发器行 + overlay 面板宿主
// 注意扩展名 .tsx：含 JSX。入口（index.ts）保持纯 TS，仅引用本触发组件。
// ============================================================
import { createPortal } from "react-dom";
import { useState } from "react";
import { TeamPanel } from "./TeamPanel";
import type { RealTeamOptions } from "./teamApi-real";
import "./whalepod-panel.css";

export function TeamPanelTrigger({ wide }: { wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RealTeamOptions | undefined>();

  const openPanel = () => {
    // 端点/hive：dev 缺省；hook 可改成从 dsh conf/store 读
    const env: Record<string, string | undefined> = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
    setOptions({
      httpUrl: env.VITE_HONEYCOMB_HTTP ?? "http://127.0.0.1:4800",
      wsUrl: env.VITE_HONEYCOMB_WS ?? "ws://127.0.0.1:4800/ws",
      hiveName: env.VITE_HONEYCOMB_HIVE_NAME ?? "hive-dev",
    });
    setOpen(true);
  };

  const close = () => setOpen(false);

  return (
    <>
      {wide ? (
        <button className="wp-trigger" onClick={openPanel} title="鲸群团队面板">
          <span className="wp-trigger-glyph">◈</span>
          {wide && <span className="wp-trigger-label">团队面板</span>}
        </button>
      ) : (
        <button className="wp-trigger wp-trigger-slim" onClick={openPanel} title="鲸群团队面板" aria-label="团队面板">
          <span className="wp-trigger-glyph">◈</span>
        </button>
      )}
      {open &&
        createPortal(
          <div className="wp-overlay" role="dialog" aria-label="鲸群团队面板">
            <div className="wp-overlay-backdrop" onClick={close} />
            <div className="wp-overlay-panel">
              <TeamPanel options={options} onClose={close} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
