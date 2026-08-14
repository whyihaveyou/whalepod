// ============================================================
// TaskDetail — 任务详情侧栏（interaction §5.3）
// 状态段（3 态 toggle）、<dl> 字段行（创建于/创建人/负责人）、
// 描述、依赖（chip 可点击跳卡）、动态（aria-live）
// ============================================================

import type { Agent, Task, TaskStatus } from "../../types";
import { Button, IconButton } from "../common/Button";
import { StatusDot } from "../common/StatusBadge";
import { IconClock, IconX } from "../../lib/icons";
import { fmtClock, taskElapsed, timeAgo, shortId } from "../../lib/format";

const STATUS_ORDER: TaskStatus[] = ["pending", "in_progress", "completed"];

export function TaskDetail({
  task,
  assignee,
  allAgents,
  onClose,
  onStatusChange,
  onReassign,
  onSelectTask,
}: {
  task: Task;
  assignee?: Agent;
  allAgents: Agent[];
  onClose: () => void;
  onStatusChange: (s: TaskStatus) => void;
  onReassign: (agentId: string) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const idx = STATUS_ORDER.indexOf(task.status);
  return (
    <aside className="task-detail" aria-label="任务详情">
      <header className="td-head">
        <div>
          <span className="td-id">{shortId(task.id)}</span>
          <h2 className="td-title">{task.title}</h2>
        </div>
        <IconButton label="关闭" onClick={onClose}>
          <IconX size={16} />
        </IconButton>
      </header>

      <section className="td-block">
        <h3 className="td-label">状态</h3>
        <div className="td-steps">
          {STATUS_ORDER.map((s, i) => (
            <button
              key={s}
              className={`td-step ${i === idx ? "td-step-active" : i < idx ? "td-step-done" : ""}`}
              onClick={() => onStatusChange(s)}
            >
              <span className="td-step-dot">
                {i < idx ? "✓" : i === idx ? String(i + 1) : ""}
              </span>
              <span className="td-step-label">
                {s === "pending" ? "待处理" : s === "in_progress" ? "进行中" : "已完成"}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="td-block">
        <h3 className="td-label">信息</h3>
        <dl className="td-dl">
          <dt>创建于</dt>
          <dd>{fmtClock(task.createdAt)}（{timeAgo(task.createdAt)}）</dd>
          <dt>创建人</dt>
          <dd>{task.createdBy}</dd>
        </dl>
      </section>

      <section className="td-block">
        <h3 className="td-label">描述</h3>
        {task.description ? (
          <p className="td-desc">{task.description}</p>
        ) : (
          <p className="td-muted">暂无描述</p>
        )}
      </section>

      <section className="td-block">
        <h3 className="td-label">负责人</h3>
        <select
          className="td-select"
          value={assignee?.id ?? ""}
          onChange={(e) => onReassign(e.target.value)}
          aria-label="指派负责人"
        >
          <option value="" disabled>未指派</option>
          {allAgents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.model}
            </option>
          ))}
        </select>
        {assignee && (
          <p className="td-assignee-line">
            <StatusDot status={assignee.status} size="sm" decorative /> {assignee.name} 当前{" "}
            {assignee.status === "working" ? "工作中" : "空闲"}
          </p>
        )}
      </section>

      <section className="td-block">
        <h3 className="td-label">依赖</h3>
        {task.blockedBy?.length ? (
          <div className="td-deps">
            {task.blockedBy.map((b) => (
              <button
                key={b}
                className="chip chip-warn td-dep-btn"
                onClick={() => onSelectTask(b)}
                aria-label={`查看阻塞任务 ${shortId(b)}`}
              >
                ⛔ 被 {shortId(b)} 阻塞
              </button>
            ))}
          </div>
        ) : (
          <p className="td-muted">无阻塞依赖</p>
        )}
      </section>

      <section className="td-block">
        <h3 className="td-label">动态</h3>
        <ul className="td-activity" aria-live="polite">
          {[...task.activity].reverse().map((ev) => (
            <li key={`${ev.ts}-${ev.actor}-${ev.action}`} className="td-event">
              <span className="td-event-time">{fmtClock(ev.ts)}</span>
              <span className="td-event-actor">{ev.actor}</span>
              <span className="td-event-action">{ev.action}</span>
            </li>
          ))}
          {task.status !== "completed" && (
            <li className="td-event td-event-now">
              <IconClock size={11} />
              当前：{task.status === "pending" ? "已创建" : "进行中"} {taskElapsed(task)}
            </li>
          )}
        </ul>
      </section>

      <footer className="td-foot">
        <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
      </footer>
    </aside>
  );
}
