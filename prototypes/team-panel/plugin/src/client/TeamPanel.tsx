// ============================================================
// TeamPanel — 团队面板宿主（dsh client plugin 侧）
// 1. 用真实 @whalepod/honeycomb 建立后端并注入原型 store（setTeamApiOverride）
// 2. 把原型 <App/>（roster/任务板/对话三视图）渲染进 .whalepod-team 作用域
// 3. 注入 --dsw-* → 面板语义 token 的皮肤适配层（跟随 dsh 10 款皮肤）
//
// 过渡目录说明：原型 global.css/tokens.css 以整表引入以保三视图样式完整；
// 落位 harness 后按 AGENTS.md CSS-module 约定收编为 .module.css（见 panel-embedding-plan）。
// ============================================================
import { useEffect, useRef, useState } from "react";
import App from "../app/App";
import { setTeamApiOverride } from "../app/hooks/useTeamStore";
import type { TeamApi } from "../app/services/api";
import { createRealTeamApi, RealTeamOptions } from "./teamApi-real";
import { PANEL_SCOPE, panelTokenRules } from "./themeTokens";

import "../app/styles/tokens.css";
import "../app/styles/global.css";

export interface TeamPanelProps {
  /** 真实 transport 端点 / hive 选择 */
  options?: RealTeamOptions;
  title?: string;
  onClose?: () => void;
}

export function TeamPanel({ options, title = "鲸群 · 团队面板", onClose }: TeamPanelProps) {
  const [state, setState] = useState<"booting" | "ready" | "error">("booting");
  const [error, setError] = useState<string>();
  const bootedRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let api: TeamApi | undefined;

    async function boot() {
      try {
        const realApi = await createRealTeamApi(options);
        if (disposed) {
          (realApi as TeamApi & { dispose?: () => void }).dispose?.();
          return;
        }
        api = realApi;
        setTeamApiOverride(realApi); // 注入真实后端，<App/> 三视图跟着走真实数据
        setState("ready");
      } catch (err) {
        setState("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    if (!bootedRef.current) {
      bootedRef.current = true;
      void boot();
    }
    return () => {
      disposed = true;
      setTeamApiOverride(null); // 卸载复位，原型恢复 env/mock 默认
      (api as TeamApi & { dispose?: () => void }).dispose?.();
    };
  }, [options]);

  return (
    <div className={PANEL_SCOPE} data-whalepod-team>
      <style>{panelTokenRules}</style>
      <div className="wp-panel-header">
        <span className="wp-panel-title">{title}</span>
        {onClose && (
          <button className="wp-panel-close" onClick={onClose} aria-label="关闭面板">
            ✕
          </button>
        )}
      </div>
      <div className="wp-panel-body">
        {state === "booting" && <div className="wp-panel-loading">正在连接真实 transport…</div>}
        {state === "error" && (
          <div className="wp-panel-error">
            <p>无法打开团队面板：{error}</p>
            <p className="wp-panel-error-hint">
              先启动 dev-server：在 <code>packages/honeycomb</code> 下 <code>pnpm run dev-server</code>，
              再打开面板。
            </p>
            <button
              onClick={() => {
                bootedRef.current = false;
                setState("booting");
                // 强制重建后门：交由父层重建实例
              }}
            >
              重试
            </button>
          </div>
        )}
        {state === "ready" && <App />}
      </div>
    </div>
  );
}
