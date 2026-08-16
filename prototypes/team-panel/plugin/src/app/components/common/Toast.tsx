// ============================================================
// Toast — 全局通知（states.md §ErrorState 全局级）
// 右上滑入；最多叠 3 条；非 danger 5s 自动消失（hover 暂停）；
// danger 需手动关（Esc 或 ✕）；danger 用 role="alert"，其余 role="status"。
// 模块级 pushToast 供 App 层在 mockApi 失败/拒绝回调里调用。
// ============================================================

import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "./Button";
import { IconX } from "../../lib/icons";

export type ToastKind = "info" | "success" | "warn" | "danger";

export interface ToastItem {
  id: string;
  kind: ToastKind;
  text: string;
  action?: { label: string; run: () => void };
}

const MAX_STACK = 3;
const AUTO_DISMISS_MS = 5000;

type Listener = (list: ToastItem[]) => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();
const uid = () => Math.random().toString(36).slice(2, 10);

function emit() {
  listeners.forEach((l) => l([...toasts]));
}

/** 推一条 toast（最多保留最新 3 条） */
export function pushToast(t: Omit<ToastItem, "id" | "kind"> & { kind?: ToastKind }) {
  const item: ToastItem = { kind: t.kind ?? "info", text: t.text, action: t.action, id: `toast-${uid()}` };
  toasts = [...toasts, item].slice(-MAX_STACK);
  emit();
}

function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function ToastCard({ toast, onClose }: { toast: ToastItem; onClose: () => void }) {
  const timer = useRef<number | null>(null);

  // 非 danger 5s 自动消失，hover 暂停
  useEffect(() => {
    if (toast.kind === "danger") return;
    timer.current = window.setTimeout(onClose, AUTO_DISMISS_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast.kind, onClose]);

  const pause = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const resume = () => {
    if (toast.kind !== "danger" && !timer.current) {
      timer.current = window.setTimeout(onClose, AUTO_DISMISS_MS);
    }
  };

  return (
    <div
      className={`toast toast-${toast.kind}`}
      role={toast.kind === "danger" ? "alert" : "status"}
      onMouseEnter={pause}
      onMouseLeave={resume}
    >
      <p className="toast-text">{toast.text}</p>
      {toast.action && (
        <Button
          variant="ghost"
          size="sm"
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            onClose();
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <IconButton label="关闭通知" size="sm" className="toast-close" onClick={onClose}>
        <IconX size={12} />
      </IconButton>
    </div>
  );
}

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>([]);

  useEffect(() => {
    const l: Listener = (next) => setList(next);
    listeners.add(l);
    l([...toasts]);
    return () => {
      listeners.delete(l);
    };
  }, []);

  // Esc 关闭最上面一条（danger 只能手动关）
  useEffect(() => {
    if (!list.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const top = list[list.length - 1];
        if (top) dismissToast(top.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list]);

  if (!list.length) return null;
  return (
    <div className="toast-host">
      {list.map((t) => (
        <ToastCard key={t.id} toast={t} onClose={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}
