// ============================================================
// RosterList — 团队成员列表（wireframe §4 / interaction §2）
// 分组：LEAD / TEAMMATES；排序 segmented（状态/名称/模型）；
// failed 吸顶 + [重启]（真按钮，stopPropagation）；shutting_down + [取消]；
// 选中态 accent-subtle + 2px 指示条；搜索过滤；↑/↓ 移动焦点、↵ 打开
// ============================================================

import { useMemo, useRef, useState } from "react";
import type { Agent } from "../../types";
import { SearchInput } from "../common/TextInput";
import { SegmentedControl, IconButton, Button } from "../common/Button";
import { StatusDot, STATUS_META } from "../common/StatusBadge";
import { IconRestart } from "../../lib/icons";
import { statusText } from "../../services/mockApi";

type SortMode = "status" | "name" | "model";

const RANK: Record<Agent["status"], number> = {
  failed: 0,
  shutting_down: 1,
  spawning: 2,
  working: 3,
  idle: 4,
  offline: 5,
};

function RosterItem({
  agent,
  selected,
  onClick,
  onKeyDown,
  onRestart,
  onCancelShutdown,
}: {
  agent: Agent;
  selected: boolean;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onRestart: (id: string) => void;
  onCancelShutdown: (id: string) => void;
}) {
  const meta = STATUS_META[agent.status];
  return (
    <div
      role="button"
      tabIndex={0}
      className={`roster-item ${selected ? "roster-item-selected" : ""}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      aria-current={selected ? "true" : undefined}
      aria-label={`${agent.name}，${meta.label}，${agent.model}`}
    >
      <StatusDot status={agent.status} size="md" selected={selected} decorative />
      <span className="roster-item-main">
        <span className="roster-item-name">{agent.name}</span>
        <span className="roster-item-sub">
          {agent.model} · <span className={`sub-status sub-${agent.status}`}>{meta.label}</span>
          {agent.status !== "idle" && (
            <span className="sub-duration"> · {statusText(agent)}</span>
          )}
        </span>
      </span>
      {agent.status === "failed" && (
        <IconButton
          label={`重启 ${agent.name}`}
          variant="danger"
          onClick={(e) => {
            e.stopPropagation();
            onRestart(agent.id);
          }}
        >
          <IconRestart size={16} />
        </IconButton>
      )}
      {agent.status === "shutting_down" && (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onCancelShutdown(agent.id);
          }}
        >
          取消
        </Button>
      )}
    </div>
  );
}

function RosterGroup({
  title,
  agents,
  selectedId,
  onSelect,
  onItemKeyDown,
  onRestart,
  onCancelShutdown,
}: {
  title: string;
  agents: Agent[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onItemKeyDown: (e: React.KeyboardEvent, id: string) => void;
  onRestart: (id: string) => void;
  onCancelShutdown: (id: string) => void;
}) {
  if (!agents.length) return null;
  return (
    <section className="roster-group">
      <h3 className="roster-group-title">{title}</h3>
      {agents.map((a) => (
        <RosterItem
          key={a.id}
          agent={a}
          selected={a.id === selectedId}
          onClick={() => onSelect(a.id)}
          onKeyDown={(e) => onItemKeyDown(e, a.id)}
          onRestart={onRestart}
          onCancelShutdown={onCancelShutdown}
        />
      ))}
    </section>
  );
}

export function RosterList({
  agents,
  selectedId,
  onSelect,
  onRestart,
  onCancelShutdown,
}: {
  agents: Agent[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onRestart: (id: string) => void;
  onCancelShutdown: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("status");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { leads, teammates } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = agents.filter(
      (a) =>
        !q ||
        a.name.toLowerCase().includes(q) ||
        a.model.toLowerCase().includes(q) ||
        a.skills.some((s) => s.toLowerCase().includes(q)),
    );
    const sortFn = (x: Agent, y: Agent) => {
      if (sort === "name") return x.name.localeCompare(y.name, "zh");
      if (sort === "model") return x.model.localeCompare(y.model);
      return RANK[x.status] - RANK[y.status] || x.name.localeCompare(y.name, "zh");
    };
    return {
      leads: list.filter((a) => a.role === "lead").sort(sortFn),
      teammates: list.filter((a) => a.role === "teammate").sort(sortFn),
    };
  }, [agents, query, sort]);

  // 列表键盘：↑/↓ 在条目间移动焦点，↵/Space 打开详情
  const onItemKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>(".roster-item") ?? [],
    );
    const idx = items.indexOf(e.currentTarget as HTMLElement);
    const next = items[idx + (e.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
  };

  return (
    <div className="roster-list">
      <div className="roster-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="搜索成员 / 模型 / 技能…" />
        <SegmentedControl
          value={sort}
          onChange={setSort}
          options={[
            { value: "status", label: "状态" },
            { value: "name", label: "名称" },
            { value: "model", label: "模型" },
          ]}
        />
      </div>
      <div className="roster-scroll" ref={scrollRef}>
        {leads.length === 0 && teammates.length === 0 ? (
          <div className="roster-empty">
            <p>未找到匹配「{query}」的成员</p>
            <Button
              variant="ghost"
              size="sm"
              className="roster-empty-clear"
              onClick={() => setQuery("")}
            >
              清除筛选
            </Button>
          </div>
        ) : (
          <>
            <RosterGroup
              title="LEAD"
              agents={leads}
              selectedId={selectedId}
              onSelect={onSelect}
              onItemKeyDown={onItemKeyDown}
              onRestart={onRestart}
              onCancelShutdown={onCancelShutdown}
            />
            <RosterGroup
              title="TEAMMATES"
              agents={teammates}
              selectedId={selectedId}
              onSelect={onSelect}
              onItemKeyDown={onItemKeyDown}
              onRestart={onRestart}
              onCancelShutdown={onCancelShutdown}
            />
          </>
        )}
      </div>
    </div>
  );
}
