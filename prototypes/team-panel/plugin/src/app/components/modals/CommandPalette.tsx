// ============================================================
// CommandPalette — ⌘K 命令面板（interaction §9）
// 搜索成员/任务/命令；↑↓ 选择（aria-activedescendant），↵ 执行；
// Esc / 遮罩点击关闭；成员/任务状态文案中文化
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Task, TaskStatus, ViewId } from "../../types";
import { Modal } from "../common/Modal";
import { STATUS_META } from "../common/StatusBadge";
import { IconBoard, IconPlus, IconSearch, IconSpark, IconUsers } from "../../lib/icons";

type CmdKind = "view" | "agent" | "task" | "action";

interface Entry {
  kind: CmdKind;
  id: string;
  label: string;
  sub?: string;
  run: () => void;
}

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
};

export function CommandPalette({
  open,
  onClose,
  agents,
  tasks,
  onSwitchView,
  onSpawn,
  onNewTask,
  onSelectAgent,
}: {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  tasks: Task[];
  onSwitchView: (v: ViewId) => void;
  onSpawn: () => void;
  onNewTask: () => void;
  onSelectAgent: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIdx(0);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const list: Entry[] = [
      { kind: "action", id: "spawn", label: "扩编新成员（Spawn）", sub: "⌘⇧N", run: () => onSpawn() },
      { kind: "action", id: "newtask", label: "新建任务", sub: "⌘N", run: () => onNewTask() },
      { kind: "view", id: "v-roster", label: "切换到 团队成员", sub: "⌘1", run: () => onSwitchView("roster") },
      { kind: "view", id: "v-board", label: "切换到 任务板", sub: "⌘2", run: () => onSwitchView("board") },
      { kind: "view", id: "v-activity", label: "切换到 活动流", sub: "⌘3", run: () => onSwitchView("activity") },
      ...agents.map((a) => ({
        kind: "agent" as const,
        id: `a-${a.id}`,
        label: a.name,
        sub: `${a.model} · ${STATUS_META[a.status].label}`,
        run: () => onSelectAgent(a.id),
      })),
      ...tasks.map((t) => ({
        kind: "task" as const,
        id: `t-${t.id}`,
        label: `${t.id} ${t.title}`,
        sub: TASK_STATUS_LABEL[t.status],
        run: () => onSwitchView("board"),
      })),
    ];
    return list.filter(
      (e) =>
        !q ||
        e.label.toLowerCase().includes(q) ||
        e.sub?.toLowerCase().includes(q),
    );
  }, [query, agents, tasks, onSwitchView, onSpawn, onNewTask, onSelectAgent]);

  useEffect(() => setIdx(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(".cmd-item-active")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (i + 1) % Math.max(entries.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (i - 1 + entries.length) % Math.max(entries.length, 1));
    } else if (e.key === "Enter") {
      const en = entries[idx];
      if (en) {
        en.run();
        onClose();
      }
    }
  };

  const iconFor = (k: CmdKind) =>
    k === "agent" ? <IconUsers size={13} /> : k === "task" ? <IconBoard size={13} /> : k === "view" ? <IconSpark size={13} /> : <IconPlus size={13} />;

  return (
    <Modal
      open={open}
      title="命令面板"
      width="spawn"
      onClose={onClose}
      footer={
        <p className="cmd-foot-hint">
          <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> 选择 · <kbd className="kbd">↵</kbd> 执行 ·{" "}
          <kbd className="kbd">Esc</kbd> 关闭
        </p>
      }
    >
      <div className="cmd-palette" onKeyDown={onKey}>
        <div className="cmd-search">
          <IconSearch size={14} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索命令、成员或任务…"
            aria-label="命令搜索"
            role="combobox"
            aria-expanded={entries.length > 0}
            aria-controls="cmd-listbox"
            aria-activedescendant={entries[idx] ? `cmd-opt-${entries[idx].id}` : undefined}
          />
        </div>
        <div className="cmd-list" ref={listRef} role="listbox" id="cmd-listbox" aria-label="命令结果">
          {entries.length === 0 ? (
            <p className="cmd-empty">没有匹配结果</p>
          ) : (
            entries.map((e, i) => (
              <button
                key={e.id}
                id={`cmd-opt-${e.id}`}
                role="option"
                aria-selected={i === idx}
                className={`cmd-item ${i === idx ? "cmd-item-active" : ""}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => {
                  e.run();
                  onClose();
                }}
              >
                <span className="cmd-item-icon">{iconFor(e.kind)}</span>
                <span className="cmd-item-label">{e.label}</span>
                {e.sub && <span className="cmd-item-sub">{e.sub}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
