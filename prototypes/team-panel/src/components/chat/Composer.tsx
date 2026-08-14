// ============================================================
// Composer — 输入区（inputs-composer.md 规范）
// 左：@提及（listbox popover + 高亮 + chip 模型）；右：广播 toggle；
// ⌘↵ 发送；广播二次确认（按钮文字变形 + Esc 退出）；
// 容器承载边框（focus 顶部描边 accent）；断连时整体禁用
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "../../types";
import { Button } from "../common/Button";
import { StatusDot } from "../common/StatusBadge";
import { IconAt, IconBroadcast, IconPlus, IconSend, IconX } from "../../lib/icons";

interface Mention {
  id: string;
  label: string;
}

const MAX_ROWS = 6;
const LINE_H = 18;
const PAD_Y = 14;

export function Composer({
  agents,
  defaultTarget,
  targetName,
  connected = true,
  onSend,
  onNewTask,
}: {
  agents: Agent[];
  /** 无 @ 提及时的默认发送目标 */
  defaultTarget: string;
  /** 默认目标显示名（aria-label 用） */
  targetName: string;
  /** 断连时禁用输入（states.md §DisconnectedState） */
  connected?: boolean;
  onSend: (to: string, text: string) => Promise<unknown>;
  onNewTask: () => void;
}) {
  const [text, setText] = useState("");
  const [broadcast, setBroadcast] = useState(false);
  const [confirmBroadcast, setConfirmBroadcast] = useState(false);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery == null) return [];
    const q = mentionQuery.toLowerCase();
    return agents.filter(
      (a) =>
        !mentions.some((m) => m.id === a.id) &&
        (a.name.toLowerCase().includes(q) || a.model.toLowerCase().includes(q)),
    );
  }, [agents, mentionQuery, mentions]);

  // 1–6 行自动增高
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS * LINE_H + PAD_Y)}px`;
  }, [text]);

  // 监听 @ 触发
  const handleChange = (v: string) => {
    setText(v);
    const at = v.lastIndexOf("@");
    const after = v.slice(at + 1);
    if (at >= 0 && !after.includes(" ") && !after.includes("\n")) {
      setMentionQuery(after);
    } else {
      setMentionQuery(null);
    }
  };

  const insertMention = (a: Agent) => {
    if (mentionQuery == null) return;
    const before = text.slice(0, text.lastIndexOf("@"));
    const next = `${before}@${a.name} `;
    setText(next);
    setMentions((m) => [...m, { id: a.id, label: a.name }]);
    setMentionQuery(null);
    textareaRef.current?.focus();
  };

  const exitBroadcast = () => {
    setBroadcast(false);
    setConfirmBroadcast(false);
  };

  const toggleBroadcast = () => {
    if (!broadcast && mentions.length) {
      // 开广播即时清 chip 并提示
      setMentions([]);
      setText((t) => t.replace(/@\S+\s?/g, ""));
      setNotice("已移除 @ 提及：广播模式发送给全体成员");
    } else if (!broadcast) {
      setNotice(null);
    }
    if (broadcast) setNotice(null);
    setBroadcast(!broadcast);
    setConfirmBroadcast(false);
  };

  const send = async () => {
    const content = text.trim();
    if (!content || sending || !connected) return;
    if (broadcast && mentions.length) {
      setMentions([]);
    }
    // 广播二次确认：首次点击仅变形按钮文案
    if (broadcast && !confirmBroadcast) {
      setConfirmBroadcast(true);
      return;
    }
    setSending(true);
    try {
      await onSend(broadcast ? "*" : mentions[0]?.id ?? defaultTarget, content);
      setText("");
      setMentions([]);
      setConfirmBroadcast(false);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape") {
      if (mentionQuery != null) {
        e.preventDefault();
        e.stopPropagation();
        setMentionQuery(null);
      } else if (broadcast) {
        e.preventDefault();
        exitBroadcast();
      }
      return;
    }
    // chip 模型：光标紧贴 chip 文本末尾时，Backspace 一次删整个 chip
    if (e.key === "Backspace") {
      const el = textareaRef.current;
      if (el && el.selectionStart === el.selectionEnd) {
        const pos = el.selectionStart;
        const hit = mentions.find((m) => text.slice(0, pos).endsWith(`@${m.label} `));
        if (hit) {
          e.preventDefault();
          const chipText = `@${hit.label} `;
          setText(text.slice(0, pos - chipText.length) + text.slice(pos));
          setMentions((ms) => ms.filter((x) => x.id !== hit.id));
        }
      }
      return;
    }
    if (mentionQuery != null && mentionCandidates.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionCandidates.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(mentionCandidates[mentionIndex]);
        setMentionIndex(0);
      }
    }
  };

  useEffect(() => {
    if (mentionQuery != null) setMentionIndex(0);
  }, [mentionQuery]);

  const placeholder = !connected
    ? "连接已断开"
    : broadcast
      ? confirmBroadcast
        ? "再次 ⌘↵ 确认发送全队…"
        : `广播给全队 ${agents.length} 人（⌘↵ 发送，首次需确认）`
      : "输入消息，@ 提及成员，⌘↵ 发送";

  const activeCandidate = mentionQuery != null ? mentionCandidates[mentionIndex] : undefined;

  return (
    <div className={`composer ${broadcast ? "composer-broadcast" : ""}`}>
      {broadcast && (
        <div className="composer-banner">
          <span>📢 广播模式：消息将发送给全体成员（{agents.length} 人）</span>
          <button className="composer-banner-x" aria-label="退出广播" onClick={exitBroadcast}>
            <IconX size={11} />
          </button>
        </div>
      )}

      <div className="composer-row">
        <button
          className={`composer-tool ${broadcast ? "composer-tool-active" : ""}`}
          title={broadcast ? "退出广播" : "切换广播模式"}
          aria-label={broadcast ? "退出广播" : "切换广播模式"}
          aria-pressed={broadcast}
          disabled={!connected}
          onClick={toggleBroadcast}
        >
          <IconBroadcast size={15} />
        </button>
        <button
          className="composer-tool"
          title="新建任务 (⌘N)"
          aria-label="新建任务 (⌘N)"
          disabled={!connected}
          onClick={onNewTask}
        >
          <IconPlus size={15} />
        </button>
        <div className="composer-main">
          {mentions.length > 0 && (
            <div className="mention-chips">
              {mentions.map((m) => (
                <span key={m.id} className="mention-chip">
                  @{m.label}
                  <button
                    aria-label={`移除 ${m.label}`}
                    onClick={() => setMentions((ms) => ms.filter((x) => x.id !== m.id))}
                  >
                    <IconX size={9} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-input-wrap">
            <textarea
              ref={textareaRef}
              className="composer-input"
              rows={1}
              placeholder={placeholder}
              aria-label={broadcast ? "发消息给全体成员" : `发消息给 ${targetName}`}
              aria-activedescendant={activeCandidate ? `mention-opt-${activeCandidate.id}` : undefined}
              value={text}
              disabled={!connected}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
        </div>
        <Button
          variant={broadcast ? "danger" : "primary"}
          size="md"
          disabled={!text.trim() || sending || !connected}
          loading={sending}
          onClick={send}
          className="composer-send"
        >
          {broadcast ? <IconBroadcast size={13} /> : <IconSend size={13} />}
          {sending
            ? "发送中"
            : broadcast
              ? confirmBroadcast
                ? "确认发送全队？"
                : "发送全队"
              : "发送"}
        </Button>
      </div>

      {mentionQuery != null && (
        <div className="mention-popover" role="listbox" aria-label="提及成员">
          {mentionCandidates.length === 0 ? (
            <p className="mention-empty">无匹配成员</p>
          ) : (
            mentionCandidates.map((a, i) => (
              <button
                key={a.id}
                id={`mention-opt-${a.id}`}
                role="option"
                aria-selected={i === mentionIndex}
                className={`mention-option ${i === mentionIndex ? "mention-option-active" : ""}`}
                onMouseEnter={() => setMentionIndex(i)}
                onClick={() => insertMention(a)}
              >
                <StatusDot status={a.status} size="sm" decorative />
                <span className="mention-name">{a.name}</span>
                <span className="mention-role">{a.role === "lead" ? "LEAD" : "TEAMMATE"}</span>
                <span className="mention-model">{a.model}</span>
              </button>
            ))
          )}
        </div>
      )}

      <p className="composer-hint">
        {notice ? (
          <span className="composer-notice">{notice}</span>
        ) : (
          <>
            <kbd className="kbd">⌘</kbd> + <kbd className="kbd">↵</kbd> 发送 · <IconAt size={10} /> 提及成员
          </>
        )}
      </p>
    </div>
  );
}
