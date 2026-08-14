// ============================================================
// TaskBoard — 任务板 Kanban（wireframe §5 / interaction §5）
// 三固定列：PENDING / IN PROGRESS / COMPLETED（列头语义色）
// 拖拽跨列移动；阻塞任务不可拖入 IN PROGRESS（bounce-back + warn 提示带 id）；
// 点卡 → 详情栏；空列 [+ 添加]；全板空时 PENDING 列内嵌空态；
// 键盘：↑/↓ 移动焦点、↵ 打开详情、⌘↑/⌘↓ 跨列移动
// ============================================================

import { useMemo, useState } from "react";
import type { Agent, Task, TaskStatus } from "../../types";
import { useTasks } from "../../hooks/useTeamStore";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
import { Button } from "../common/Button";
import { IconPlus } from "../../lib/icons";
import { shortId } from "../../lib/format";

const COLUMNS: { id: TaskStatus; title: string }[] = [
  { id: "pending", title: "待处理" },
  { id: "in_progress", title: "进行中" },
  { id: "completed", title: "已完成" },
];

export function TaskBoard({
  agents,
  onNewTask,
  autoSelectTaskId,
}: {
  agents: Agent[];
  onNewTask: () => void;
  autoSelectTaskId?: string;
}) {
  const { tasks, updateStatus, createTask } = useTasks();
  const [selected, setSelected] = useState<string | undefined>(autoSelectTaskId);
  const [dragging, setDragging] = useState<Task | null>(null);
  const [overCol, setOverCol] = useState<TaskStatus | null>(null);
  const [denied, setDenied] = useState<TaskStatus | null>(null);

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const selectedTask = tasks.find((t) => t.id === selected);
  const boardEmpty = tasks.length === 0;

  const isBlockedTarget = (t: Task, col: TaskStatus) =>
    !!t.blockedBy?.length && col === "in_progress";

  const onDrop = (col: TaskStatus) => {
    if (!dragging) return;
    if (isBlockedTarget(dragging, col)) {
      // 阻塞任务不能进入 in_progress：bounce-back + 警告
      setDenied(col);
      setTimeout(() => setDenied(null), 1200);
      setOverCol(null);
      setDragging(null);
      return;
    }
    if (dragging.status !== col) {
      updateStatus(dragging.id, col);
    }
    setOverCol(null);
    setDragging(null);
  };

  // ⌘↑/⌘↓ 跨列移动（聚焦态）；阻塞任务同样不可进 in_progress
  const moveTask = (t: Task, dir: 1 | -1) => {
    const idx = COLUMNS.findIndex((c) => c.id === t.status);
    const next = COLUMNS[idx + dir];
    if (!next) return;
    if (isBlockedTarget(t, next.id)) {
      setDenied(next.id);
      setTimeout(() => setDenied(null), 1200);
      return;
    }
    updateStatus(t.id, next.id);
  };

  // ↑/↓ 在卡片间移动焦点
  const onCardFocusKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".task-card"));
    const idx = cards.indexOf(e.currentTarget as HTMLElement);
    cards[idx + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  return (
    <div className="board">
      <header className="board-head">
        <h2 className="board-title">任务板</h2>
        <button className="btn btn-primary btn-sm board-new" onClick={onNewTask}>
          <IconPlus size={13} /> 新建任务
        </button>
      </header>

      <div className="board-columns">
        {COLUMNS.map((col) => {
          const items = tasks
            .filter((t) => t.status === col.id)
            .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
          const isOver = overCol === col.id;
          const deniedHere = denied === col.id;
          return (
            <section
              key={col.id}
              className={`board-col col-${col.id} ${isOver ? "board-col-over" : ""} ${
                deniedHere ? "board-col-denied" : ""
              }`}
              aria-dropeffect={
                dragging ? (isBlockedTarget(dragging, col.id) ? "none" : "move") : undefined
              }
              onDragOver={(e) => {
                e.preventDefault();
                setOverCol(col.id);
              }}
              onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(col.id);
              }}
            >
              <header className="board-col-head">
                <h3 className="board-col-title">{col.title}</h3>
                <span className="board-col-count">{items.length}</span>
              </header>
              <div className="board-col-body">
                {deniedHere && dragging && (
                  <p className="board-denied-hint">
                    ⛔ 任务 {shortId(dragging.id)} 被{" "}
                    {dragging.blockedBy!.map(shortId).join("、")} 阻塞，不能进入「进行中」
                  </p>
                )}
                {items.length === 0 ? (
                  boardEmpty && col.id === "pending" ? (
                    <div className="board-empty-full">
                      <p>拖入或新建任务</p>
                      <Button variant="secondary" size="sm" onClick={onNewTask}>
                        <IconPlus size={13} /> 新建任务
                      </Button>
                    </div>
                  ) : (
                    <button className="board-add-btn" onClick={onNewTask}>
                      <IconPlus size={13} /> 添加
                    </button>
                  )
                ) : (
                  items.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      assignee={t.assigneeId ? agentMap.get(t.assigneeId) : undefined}
                      selected={t.id === selected}
                      dragging={dragging?.id === t.id}
                      onClick={() => setSelected(t.id)}
                      onMove={(dir) => moveTask(t, dir)}
                      onFocusKey={onCardFocusKey}
                      onDragStart={(e, t) => {
                        setDragging(t);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOverCol(null);
                      }}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          assignee={selectedTask.assigneeId ? agentMap.get(selectedTask.assigneeId) : undefined}
          allAgents={agents}
          onClose={() => setSelected(undefined)}
          onStatusChange={(s) => updateStatus(selectedTask.id, s)}
          onSelectTask={(id) => setSelected(id)}
          onReassign={(agentId) => {
            // 原型：改派 = 新建对应条目语义简化，直接记录到 activity
            updateStatus(selectedTask.id, selectedTask.status);
            createTask(selectedTask.title, agentId).then(() => setSelected(undefined));
          }}
        />
      )}
    </div>
  );
}
