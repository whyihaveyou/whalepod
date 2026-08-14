// ============================================================
// TaskCard — 任务卡（task-card.md 规范）
// 标题 14px/600 两行截断；负责人行（状态点 + 名称）；
// meta 行三选一：in_progress→时长 / completed→✓+时间 / blocked→⛔+来源；
// 阻塞整卡 warn 描边；拖动态原位虚线占位框 + popover 阴影；
// 聚焦时 ⌘↑/⌘↓ 跨列移动；id 展示截断前 8 位
// ============================================================

import type { Agent, Task, TaskStatus } from "../../types";
import { StatusDot } from "../common/StatusBadge";
import { IconClock, IconWarn } from "../../lib/icons";
import { taskElapsed, fmtClock, shortId } from "../../lib/format";

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
};

export function TaskCard({
  task,
  assignee,
  selected,
  dragging,
  onClick,
  onMove,
  onFocusKey,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  assignee?: Agent;
  selected: boolean;
  dragging?: boolean;
  onClick: () => void;
  /** ⌘↑/⌘↓ 跨列移动（-1 上一列 / 1 下一列） */
  onMove?: (dir: 1 | -1) => void;
  /** ↑/↓ 在同列卡片间移动焦点（由 TaskBoard 处理 DOM 焦点） */
  onFocusKey?: (e: React.KeyboardEvent) => void;
  onDragStart?: (e: React.DragEvent, t: Task) => void;
  onDragEnd?: () => void;
}) {
  const blocked = !!task.blockedBy?.length;
  const blockId = `tc-block-${task.id.replace(/[^a-zA-Z0-9]/g, "")}`;
  const cls = [
    "task-card",
    selected ? "task-card-selected" : "",
    dragging ? "task-card-dragging" : "",
    blocked ? "task-card-blocked" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cls}
      draggable
      onClick={onClick}
      onDragStart={(e) => onDragStart?.(e, task)}
      onDragEnd={onDragEnd}
      role="button"
      tabIndex={0}
      aria-label={`${shortId(task.id)} ${task.title}，${TASK_STATUS_LABEL[task.status]}，负责人 ${assignee?.name ?? "未指派"}`}
      aria-grabbed={dragging ?? undefined}
      aria-describedby={blocked ? blockId : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onClick();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
          e.preventDefault();
          onMove?.(e.key === "ArrowDown" ? 1 : -1);
          return;
        }
        onFocusKey?.(e);
      }}
    >
      <p className="task-card-title">{task.title}</p>
      <div className="task-card-assignee">
        {assignee ? (
          <>
            <StatusDot status={assignee.status} size="sm" decorative />
            <span>{assignee.name}</span>
          </>
        ) : (
          <span className="task-unassigned">未指派</span>
        )}
      </div>
      <div className="task-card-meta">
        <span className="task-card-id">{shortId(task.id)}</span>
        {blocked ? (
          <span className="task-card-blocked-tag" id={blockId}>
            <IconWarn size={11} /> 被 {task.blockedBy!.map(shortId).join("、")} 阻塞
          </span>
        ) : task.status === "completed" && task.completedAt ? (
          <span className="task-card-done">✓ {fmtClock(task.completedAt)}</span>
        ) : task.status === "in_progress" ? (
          <span className="task-card-duration">
            <IconClock size={11} />
            {taskElapsed(task)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
