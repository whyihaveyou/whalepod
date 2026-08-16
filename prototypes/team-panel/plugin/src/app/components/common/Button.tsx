// ============================================================
// Button / IconButton / SegmentedControl — buttons.md 规范
// 变体：primary / secondary / danger / ghost
// 尺寸：md 32px / sm 28px；:active scale(.97)；loading 带 aria-busy
// ============================================================

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "md" | "sm";

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}) {
  return (
    <button
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="btn-spinner" aria-hidden />}
      {children}
    </button>
  );
}

/** IconButton：基尺寸 28×28（icon-btn-md），图标 16px */
export function IconButton({
  label,
  size = "md",
  variant = "ghost",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: Size;
  variant?: Variant;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`icon-btn icon-btn-${size} ${variant === "danger" ? "icon-btn-danger" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** SegmentedControl：互斥选项条（radiogroup 语义，roving tabindex，
    ←/→ 移动即选中 —— selection follows focus） */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "sm",
  label = "排序方式",
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: Size;
  label?: string;
}) {
  const move = (dir: 1 | -1, e: React.KeyboardEvent) => {
    const idx = options.findIndex((o) => o.value === value);
    const next = options[(idx + dir + options.length) % options.length];
    onChange(next.value);
    const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
    buttons?.[(idx + dir + options.length) % options.length]?.focus();
  };

  return (
    <div className={`segmented seg-${size}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={`seg-item ${o.value === value ? "seg-active" : ""}`}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              move(1, e);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              move(-1, e);
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
