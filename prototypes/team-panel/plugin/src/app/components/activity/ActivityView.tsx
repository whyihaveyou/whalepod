// ============================================================
// ActivityView — 活动流（wireframe §7）
// 全宽时间线；类型图标；消息/任务/状态三类高亮色；
// 点击活动 → 定位到对应 agent/任务
// ============================================================

import type { ActivityEvent, ViewId } from "../../types";
import { useActivities } from "../../hooks/useTeamStore";
import { timeAgo } from "../../lib/format";
import { IconActivity, IconBoard, IconCheck, IconSpark, IconUsers, IconWarn } from "../../lib/icons";

const KIND_META: Record<ActivityEvent["kind"], { label: string; tone: string; icon: React.ReactNode }> = {
  message: { label: "消息", tone: "acc", icon: <IconSpark size={13} /> },
  task_start: { label: "开始", tone: "acc", icon: <IconBoard size={13} /> },
  task_create: { label: "新建", tone: "mut", icon: <IconBoard size={13} /> },
  task_done: { label: "完成", tone: "ok", icon: <IconCheck size={13} /> },
  failed: { label: "失败", tone: "dgr", icon: <IconWarn size={13} /> },
  spawn: { label: "上线", tone: "ok", icon: <IconUsers size={13} /> },
  shutdown: { label: "关机", tone: "mut", icon: <IconActivity size={13} /> },
  status: { label: "状态", tone: "mut", icon: <IconActivity size={13} /> },
};

export function ActivityView({
  onJump,
}: {
  onJump: (v: ViewId, ref?: { agentId?: string; taskId?: string }) => void;
}) {
  const { activities, loading } = useActivities();

  return (
    <div className="activity">
      <header className="activity-head">
        <h2 className="activity-title">活动流</h2>
        <span className="activity-count">{activities.length} 条</span>
      </header>
      {loading ? (
        <div className="activity-skeleton" aria-busy="true" aria-label="加载中">
          <div className="skeleton-line" aria-hidden />
          <div className="skeleton-line" aria-hidden />
          <div className="skeleton-line" aria-hidden />
        </div>
      ) : activities.length === 0 ? (
        <p className="activity-empty">暂无活动</p>
      ) : (
        <ul className="activity-list">
          {activities.map((a) => {
            const meta = KIND_META[a.kind];
            return (
              <li key={a.id} className="activity-item">
                <span className={`activity-icon tone-${meta.tone}`}>{meta.icon}</span>
                <div className="activity-body">
                  <p className="activity-text">{a.text}</p>
                  <div className="activity-foot">
                    <span className={`activity-kind tone-${meta.tone}`}>{meta.label}</span>
                    <span className="activity-time">{timeAgo(a.ts)}</span>
                    {a.refAgentId && (
                      <button className="activity-jump" onClick={() => onJump("roster", { agentId: a.refAgentId })}>
                        查看成员
                      </button>
                    )}
                    {a.refTaskId && (
                      <button className="activity-jump" onClick={() => onJump("board", { taskId: a.refTaskId })}>
                        查看任务
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
