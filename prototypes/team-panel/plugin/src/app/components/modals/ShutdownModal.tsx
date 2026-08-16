// ============================================================
// ShutdownModal — 关机确认（modals.md / interaction §7）
// 等待模式：主按钮 primary「发送关机请求」普通点击，提交即关模态，
//   等待态落回 RosterList 条目（shutting_down + [取消]）与 AgentDetail 等待条；
// 强制关机：升级 L3 —— 输入名称首词 + 长按 1s 激活（danger 变体），
//   L3 阶段 dismissable=false。
// ============================================================

import { useEffect, useRef, useState } from "react";
import type { Agent } from "../../types";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { TextInput } from "../common/TextInput";
import { StatusBadge } from "../common/StatusBadge";
import { IconWarn } from "../../lib/icons";

const HOLD_MS = 1000;

export function ShutdownModal({
  agent,
  open,
  inProgressCount = 0,
  onClose,
  onConfirm,
}: {
  agent: Agent | null;
  open: boolean;
  /** 该成员进行中任务数（>0 时显示 warn 内联条） */
  inProgressCount?: number;
  onClose: () => void;
  /** 提交即关模态；结果（批准/拒绝）由调用方异步处理 */
  onConfirm: (force: boolean) => void;
}) {
  const [mode, setMode] = useState<"wait" | "force">("wait");
  const [confirmText, setConfirmText] = useState("");
  const [hold, setHold] = useState(0);
  const holdTimer = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setMode("wait");
      setConfirmText("");
      setHold(0);
    }
  }, [open, agent?.id]);

  const firstWord = agent?.name.split(/[-_ ]/)[0] ?? "";
  const confirmOk = confirmText.trim() === firstWord;
  const forceReady = confirmOk;

  const submit = (force: boolean) => {
    stopHold();
    onClose();
    onConfirm(force);
  };

  const startHold = () => {
    if (!forceReady) return;
    holdTimer.current = window.setInterval(() => {
      setHold((h) => {
        if (h + 50 >= HOLD_MS) {
          if (holdTimer.current) clearInterval(holdTimer.current);
          holdTimer.current = null;
          submit(true);
          return HOLD_MS;
        }
        return h + 50;
      });
    }, 50);
  };
  const stopHold = () => {
    if (holdTimer.current) {
      clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
    setHold(0);
  };

  return (
    <Modal
      open={open && !!agent}
      title={`关机 ${agent?.name ?? ""}`}
      subtitle="关机前将先与成员协商，避免丢失未提交工作"
      width="confirm"
      danger
      onClose={() => {
        stopHold();
        onClose();
      }}
      dismissable={mode !== "force"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          {mode === "wait" ? (
            <Button variant="primary" onClick={() => submit(false)}>
              发送关机请求
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={!forceReady}
              onPointerDown={startHold}
              onPointerUp={stopHold}
              onPointerLeave={stopHold}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  if (!holdTimer.current) startHold();
                }
              }}
              onKeyUp={stopHold}
            >
              <span className="hold-btn-track" style={{ width: `${(hold / HOLD_MS) * 100}%` }} />
              <span className="hold-btn-label">长按强制关机</span>
            </Button>
          )}
        </>
      }
    >
      <div className="shutdown-body">
        <p className="shutdown-summary">
          当前状态：<StatusBadge status={agent?.status ?? "idle"} variant="dot-label" size="sm" />
        </p>
        {inProgressCount > 0 && (
          <p className="inline-bar inline-bar-warn">
            <IconWarn size={12} /> 该成员有 {inProgressCount} 个进行中任务
          </p>
        )}

        <div className="shutdown-modes" role="radiogroup" aria-label="关机方式">
          <label className={`shutdown-mode ${mode === "wait" ? "mode-active" : ""}`}>
            <input
              type="radio"
              name="sd-mode"
              checked={mode === "wait"}
              onChange={() => setMode("wait")}
            />
            <span className="mode-main">
              <span className="mode-title">等待成员确认</span>
              <span className="mode-desc">发送关机请求，成员批准后下线（默认）</span>
            </span>
          </label>
          <label className={`shutdown-mode ${mode === "force" ? "mode-active" : ""}`}>
            <input
              type="radio"
              name="sd-mode"
              checked={mode === "force"}
              onChange={() => setMode("force")}
            />
            <span className="mode-main">
              <span className="mode-title">强制关机</span>
              <span className="mode-desc">立即终止，可能丢失未保存工作</span>
            </span>
          </label>
        </div>

        {mode === "force" && (
          <div className="shutdown-force">
            <p className="shutdown-warn">
              <IconWarn size={13} /> 输入成员名首词「{firstWord}」并长按主按钮 1 秒以确认强制关机
            </p>
            <TextInput
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={`输入「${firstWord}」`}
              errorText={confirmText.length > 0 && !confirmOk ? `需输入「${firstWord}」` : undefined}
              aria-label="确认成员名首词"
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
