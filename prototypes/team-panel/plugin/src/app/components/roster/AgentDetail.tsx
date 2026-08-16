// ============================================================
// AgentDetail — 成员详情（agent-detail.md 规范）
// <dl> 字段区（角色/模型/状态 dot-label+时长/slot mono 截断+复制）；
// 当前任务可点击跳任务板；能力 chips；操作区
// [发消息] / [分配任务]（内联迷你表单）/ [请求关机…]
// ============================================================

import { useState } from "react";
import type { Agent, Task } from "../../types";
import { StatusBadge } from "../common/StatusBadge";
import { Button, IconButton } from "../common/Button";
import { TextInput } from "../common/TextInput";
import {
  IconAt,
  IconCheck,
  IconClock,
  IconCopy,
  IconPower,
  IconRestart,
  IconSpark,
} from "../../lib/icons";
import { fmtDuration, shortId } from "../../lib/format";

const MIN = 60_000;

export function AgentDetail({
  agent,
  tasks,
  onOpenChat,
  onRequestShutdown,
  onRestart,
  onCancelShutdown,
  onAssignTask,
  onOpenTask,
}: {
  agent: Agent;
  tasks: Task[];
  onOpenChat: () => void;
  onRequestShutdown: () => void;
  onRestart: () => void;
  onCancelShutdown: () => void;
  onAssignTask: (title: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTitle, setAssignTitle] = useState("");
  const [copied, setCopied] = useState(false);

  const currentTask = tasks.find((t) => t.id === agent.currentTaskId);
  const doneCount = tasks.filter((t) => t.assigneeId === agent.id && t.status === "completed").length;

  // working 时长：>30min 才显示，>2h 时长文字 warn 色
  const workedMs = agent.status === "working" && agent.workingSince
    ? Date.now() - agent.workingSince
    : 0;
  const showDuration = workedMs > 30 * MIN;
  const durationWarn = workedMs > 2 * 60 * MIN;

  const copySlot = async () => {
    try {
      await navigator.clipboard.writeText(agent.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  const submitAssign = () => {
    const title = assignTitle.trim();
    if (!title) return;
    onAssignTask(title);
    setAssignTitle("");
    setAssignOpen(false);
  };

  return (
    <div className="agent-detail">
      <header className="ad-head">
        <div className="ad-title-row">
          <h2 className="ad-name">{agent.name}</h2>
          <Button variant="ghost" size="sm" className="ad-head-chat" onClick={onOpenChat}>
            <IconAt size={13} /> 对话
          </Button>
        </div>
        {agent.status === "shutting_down" && (
          <p className="inline-bar inline-bar-warn">
            <IconClock size={12} /> 正在等待 {agent.name} 的关机确认…
            <Button variant="ghost" size="sm" onClick={onCancelShutdown}>
              取消
            </Button>
          </p>
        )}
        <dl className="ad-dl">
          <dt>角色</dt>
          <dd>{agent.role === "lead" ? "LEAD" : "TEAMMATE"}</dd>
          <dt>模型</dt>
          <dd>{agent.model}</dd>
          <dt>状态</dt>
          <dd>
            <StatusBadge status={agent.status} variant="dot-label" size="sm" />
            {showDuration && (
              <span className={durationWarn ? "text-warn" : undefined}>
                已工作 {fmtDuration(workedMs)}
              </span>
            )}
          </dd>
          <dt>SLOT</dt>
          <dd>
            <span className="ad-slot" title={agent.id}>{agent.id}</span>
            <IconButton label={copied ? "已复制" : "复制 slot id"} size="sm" onClick={copySlot}>
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </IconButton>
          </dd>
        </dl>
        {agent.status === "failed" && (
          <p className="inline-bar inline-bar-danger">
            ⚠ {agent.failedReason ?? "成员运行失败"}
            <Button variant="ghost" size="sm" className="btn-danger-ghost" onClick={onRestart}>
              <IconRestart size={13} /> 重启
            </Button>
          </p>
        )}
      </header>

      <section className="ad-block">
        <h3 className="ad-block-title">
          <IconSpark size={13} /> 当前任务
        </h3>
        {currentTask ? (
          <button className="ad-task" onClick={() => onOpenTask(currentTask.id)}>
            <p className="ad-task-id">{shortId(currentTask.id)}</p>
            <p className="ad-task-title">{currentTask.title}</p>
            <p className="ad-task-meta">
              <IconClock size={11} /> 已工作{" "}
              {fmtDuration(Date.now() - (currentTask.startedAt ?? currentTask.createdAt))}
            </p>
          </button>
        ) : (
          <p className="ad-muted">暂无进行中任务</p>
        )}
        <p className="ad-subline">累计完成 {doneCount} 个任务</p>
      </section>

      <section className="ad-block">
        <h3 className="ad-block-title">
          <IconSpark size={13} /> 能力
        </h3>
        <div className="ad-skills">
          {agent.skills.map((s) => (
            <span key={s} className="chip">{s}</span>
          ))}
        </div>
        <div className="ad-mcp">
          <span className="ad-mcp-label">MCP</span>
          {agent.mcp.map((m) => (
            <span key={m} className="chip chip-muted">{m}</span>
          ))}
        </div>
      </section>

      <section className="ad-block">
        <h3 className="ad-block-title">操作</h3>
        <div className="ad-actions">
          <Button variant="secondary" size="sm" onClick={onOpenChat}>
            <IconAt size={13} /> 发消息
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setAssignOpen((v) => !v)}
            aria-expanded={assignOpen}
          >
            分配任务
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={agent.status === "offline" || agent.status === "shutting_down"}
            onClick={onRequestShutdown}
          >
            <IconPower size={13} /> 请求关机…
          </Button>
        </div>
        {assignOpen && (
          <div className="ad-assign-form">
            <TextInput
              value={assignTitle}
              onChange={(e) => setAssignTitle(e.target.value)}
              placeholder="任务描述"
              aria-label="任务描述"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAssign();
              }}
            />
            <Button variant="primary" size="sm" disabled={!assignTitle.trim()} onClick={submitAssign}>
              创建并指派
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
