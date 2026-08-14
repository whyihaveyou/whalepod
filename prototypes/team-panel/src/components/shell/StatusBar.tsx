// ============================================================
// StatusBar — 底部 24px 状态栏（wireframe §3 / states.md §DisconnectedState）
// 左：连接状态（断连：danger 点 + “连接已断开，重连中…”，点击重连；
//     已连接时可点击模拟断连——原型演示入口）；
// 断连/恢复各播报一次（断连 assertive / 恢复 polite，visually-hidden）；
// 中：团队聚合；右：任务计数 + 阻塞警示 + 快捷键提示
// ============================================================

import { useEffect, useRef, useState } from "react";
import type { AgentStats } from "../../types";

export function StatusBar({
  connected,
  stats,
  taskCounts,
  onReconnect,
  onSimulateDisconnect,
}: {
  connected: boolean;
  stats: AgentStats;
  taskCounts: { total: number; inProgress: number; blocked: number };
  onReconnect: () => void;
  /** 演示用：模拟断连 */
  onSimulateDisconnect: () => void;
}) {
  // 断连/恢复播报（各一次）
  const prevConnected = useRef(connected);
  const [assertiveMsg, setAssertiveMsg] = useState("");
  const [politeMsg, setPoliteMsg] = useState("");
  useEffect(() => {
    if (prevConnected.current === connected) return;
    if (!connected) setAssertiveMsg("连接已断开，正在重连");
    else setPoliteMsg("连接已恢复");
    prevConnected.current = connected;
  }, [connected]);

  return (
    <footer className="statusbar">
      <span className="visually-hidden" role="alert">{assertiveMsg}</span>
      <span className="visually-hidden" aria-live="polite">{politeMsg}</span>
      <div className="statusbar-left">
        {connected ? (
          <button
            className="status-conn conn-btn"
            onClick={onSimulateDisconnect}
            title="演示：模拟断连"
          >
            <i className="conn-dot" /> 已连接
          </button>
        ) : (
          <button className="status-conn conn-off" onClick={onReconnect}>
            <i className="conn-dot" /> 连接已断开，重连中…（点击重试）
          </button>
        )}
      </div>
      <div className="statusbar-mid">
        <span>团队 {stats.total} 人</span>
        <span className="sb-sep">·</span>
        <span className="sb-working">{stats.working} 工作中</span>
        <span className="sb-sep">·</span>
        <span>{stats.idle} 空闲</span>
        {stats.failed > 0 && (
          <>
            <span className="sb-sep">·</span>
            <span className="sb-failed">⚠ {stats.failed} 失败</span>
          </>
        )}
      </div>
      <div className="statusbar-right">
        <span>任务 {taskCounts.total}</span>
        <span className="sb-sep">·</span>
        <span className="sb-working">{taskCounts.inProgress} 进行中</span>
        {taskCounts.blocked > 0 && (
          <>
            <span className="sb-sep">·</span>
            <span className="sb-failed">⛔ {taskCounts.blocked} 阻塞</span>
          </>
        )}
        <span className="sb-sep sb-grow" />
        <span className="sb-hint">⌘1-3 视图 · ⌘K 命令</span>
      </div>
    </footer>
  );
}
