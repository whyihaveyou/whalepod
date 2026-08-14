// ============================================================
// StatusDot + StatusBadge — 状态视觉（status-badge.md 规范）
// 状态语义：spawning 三点弹跳 / working 呼吸（active 青）/ idle 稳定
//           failed 实心 ✕ / offline 空心 / shutting_down 警示
// ============================================================

import type { AgentStatus } from "../../types";
import { IconX, IconClock } from "../../lib/icons";

type Tone = "ok" | "active" | "accent" | "warn" | "danger" | "muted";

export const STATUS_META: Record<AgentStatus, { label: string; tone: Tone }> = {
  spawning: { label: "上线中", tone: "accent" },
  idle: { label: "空闲", tone: "muted" },
  working: { label: "工作中", tone: "active" },
  failed: { label: "失败", tone: "danger" },
  offline: { label: "离线", tone: "muted" },
  shutting_down: { label: "关机中", tone: "warn" },
};

/** 状态点：md=10px / sm=8px；选中态为 12px 圆点；
    decorative 时 aria-hidden（状态由父条目 aria-label 承担） */
export function StatusDot({
  status,
  size = "md",
  selected = false,
  decorative = false,
}: {
  status: AgentStatus;
  size?: "sm" | "md";
  selected?: boolean;
  decorative?: boolean;
}) {
  const cls = [
    "status-dot",
    `tone-${STATUS_META[status].tone}`,
    `dot-${size}`,
    `dot-${status}`,
    selected ? "dot-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { "aria-label": STATUS_META[status].label };

  // spawning：三点弹跳
  if (status === "spawning") {
    return (
      <span className={`${cls} dot-spawning`} {...a11y}>
        <i /><i /><i />
      </span>
    );
  }
  // failed：实心 ✕
  if (status === "failed") {
    return (
      <span className={`${cls} dot-failed-mark`} {...a11y}>
        <IconX size={size === "sm" ? 7 : 9} />
      </span>
    );
  }
  if (status === "offline") {
    return <span className={`${cls} dot-offline`} {...a11y} />;
  }
  if (status === "shutting_down") {
    return (
      <span className={`${cls} dot-shutting`} {...a11y}>
        <IconClock size={size === "sm" ? 8 : 10} />
      </span>
    );
  }
  return <span className={cls} {...a11y} />;
}

/** 徽章：solid-tint / outline / dot-label 三变体 */
export function StatusBadge({
  status,
  variant = "solid-tint",
  size = "md",
  label,
}: {
  status: AgentStatus;
  variant?: "solid-tint" | "outline" | "dot-label";
  size?: "sm" | "md";
  label?: string;
}) {
  const text = label ?? STATUS_META[status].label;
  const cls = [
    "status-badge",
    `badge-${variant}`,
    `badge-tone-${STATUS_META[status].tone}`,
    `badge-${size}`,
  ].join(" ");

  return (
    <span className={cls}>
      {variant === "dot-label" && <StatusDot status={status} size="sm" decorative />}
      {text}
      {variant === "solid-tint" && status === "failed" && <IconX size={10} />}
    </span>
  );
}
