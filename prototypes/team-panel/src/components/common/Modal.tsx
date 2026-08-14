// ============================================================
// Modal — modals.md 规范
// 变体：confirm 440px / spawn 560px；遮罩 + focus trap + Esc；
// 标题 13px，正文 12px，danger 前导警告图标；
// 初始焦点：danger 落 footer 取消钮，其余落内容区首个可交互元素；
// ⌘↵ 触发 footer 主操作；打开时背景根节点 inert。
// ============================================================

import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconX, IconWarn } from "../../lib/icons";

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  title,
  subtitle,
  width = "confirm",
  danger = false,
  children,
  footer,
  onClose,
  dismissable = true,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  width?: "confirm" | "spawn";
  danger?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;

    // 背景根节点 inert（遮罩的兄弟节点全部失活）
    const backdrop = el?.parentElement ?? null;
    const bgSiblings: HTMLElement[] = backdrop?.parentElement
      ? (Array.from(backdrop.parentElement.children) as HTMLElement[]).filter(
          (c) => c !== backdrop,
        )
      : [];
    bgSiblings.forEach((n) => (n.inert = true));

    // focus trap + Esc + ⌘↵ 主操作
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        const primary = el?.querySelector<HTMLElement>(
          ".modal-foot button:last-child",
        );
        if (primary && !(primary as HTMLButtonElement).disabled) {
          e.preventDefault();
          primary.click();
        }
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const focusables = el.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);

    // 初始焦点：danger/L3 → footer 取消钮（第一个按钮）；
    // 其余 → 内容区第一个可交互元素（不落 header ✕）
    const t = setTimeout(() => {
      if (!el) return;
      const target = danger
        ? el.querySelector<HTMLElement>(".modal-foot button")
        : (el.querySelector<HTMLElement>(`.modal-body ${FOCUSABLE}`) ??
          el.querySelector<HTMLElement>(FOCUSABLE));
      target?.focus();
    }, 30);

    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
      bgSiblings.forEach((n) => (n.inert = false));
      prev?.focus();
    };
  }, [open, dismissable, onClose, danger]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal modal-${width} ${danger ? "modal-danger" : ""}`}
      >
        <header className="modal-head">
          <div>
            <h2 className="modal-title" id={titleId}>
              {danger && <IconWarn size={14} />}
              {title}
            </h2>
            {subtitle && <p className="modal-subtitle">{subtitle}</p>}
          </div>
          {dismissable && (
            <button className="icon-btn icon-btn-md" aria-label="关闭" onClick={onClose}>
              <IconX size={16} />
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
