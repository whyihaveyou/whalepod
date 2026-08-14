// ============================================================
// ChatPane — 对话界面（wireframe §6）
// 消息流 + 系统条 + 输入区；typing 指示；按 agent 隔离线程；
// 头部状态用 StatusBadge dot-label；发送失败气泡 ✕ + hover [重发]；
// 对方 offline 时 Composer 顶部 warn 内联条（不阻断输入）
// ============================================================

import { useEffect, useRef } from "react";
import type { Agent, Message } from "../../types";
import { useChat } from "../../hooks/useTeamStore";
import { Composer } from "./Composer";
import { StatusBadge } from "../common/StatusBadge";
import { fmtClock } from "../../lib/format";
import { IconCheck, IconClock, IconWarn, IconX } from "../../lib/icons";

function SystemBar({ text, ts }: { text: string; ts: number }) {
  return (
    <div className="chat-system">
      <span className="chat-system-line" />
      <span className="chat-system-text">
        <IconClock size={10} /> {text}
      </span>
      <span className="chat-system-ts">{fmtClock(ts)}</span>
      <span className="chat-system-line" />
    </div>
  );
}

function Bubble({
  m,
  agentName,
  onResend,
}: {
  m: Message;
  agentName?: string;
  onResend: (m: Message) => void;
}) {
  if (m.kind === "system") return <SystemBar text={m.text} ts={m.ts} />;
  const mine = m.kind === "user";
  return (
    <div className={`chat-row ${mine ? "row-mine" : "row-agent"}`}>
      {!mine && <span className="bubble-avatar">{agentName?.slice(0, 1) ?? "?"}</span>}
      <div className={`bubble ${mine ? "bubble-mine" : "bubble-agent"}`}>
        {!mine && <p className="bubble-from">{m.from}</p>}
        <p className="bubble-text">{m.text}</p>
        <span className="bubble-meta" aria-live="polite">
          {fmtClock(m.ts)}
          {mine && !m.delivered && !m.failed && <span className="bubble-pending"> · 发送中…</span>}
          {mine && m.failed && (
            <>
              <span className="bubble-failed">
                <IconX size={9} /> 发送失败
              </span>
              <button className="bubble-resend" onClick={() => onResend(m)}>
                重发
              </button>
            </>
          )}
          {mine && m.delivered && !m.failed && (
            <span className="bubble-ok">
              <IconCheck size={9} />
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function ChatPane({
  agent,
  agents,
  connected = true,
  onOpenChatAgent,
}: {
  agent: Agent | null;
  /** 供 @提及 的全体成员（含其他 teammate） */
  agents: Agent[];
  /** 断连时禁用 Composer（states.md §DisconnectedState） */
  connected?: boolean;
  onOpenChatAgent: (id: string) => void;
}) {
  const { messages, typing, send } = useChat(agent?.id);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, typing, agent?.id]);

  if (!agent) {
    return <div className="chat-empty">从左侧选择一个成员开始对话</div>;
  }

  const offline = agent.status === "offline";

  return (
    <div className="chatpane">
      <header className="chat-head">
        <span className="chat-head-name">{agent.name}</span>
        <span className="chat-head-model">{agent.model}</span>
        <span className="chat-head-status">
          <StatusBadge status={agent.status} variant="dot-label" size="sm" />
        </span>
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <>
            <SystemBar text={`这是与 ${agent.name} 的对话起点`} ts={Date.now()} />
          </>
        ) : (
          messages.map((m) => (
            <Bubble
              key={m.id}
              m={m}
              agentName={agent.name}
              onResend={(msg) => send(msg.to === "*" ? "*" : agent.id, msg.text)}
            />
          ))
        )}
        {typing && (
          <div className="chat-row row-agent">
            <span className="bubble-avatar">{agent.name.slice(0, 1)}</span>
            <div className="bubble bubble-agent typing-bubble">
              <span className="typing-dots"><i /><i /><i /></span>
              <span className="typing-label">{agent.name} 正在输入…</span>
            </div>
          </div>
        )}
      </div>

      {offline && (
        <p className="inline-bar inline-bar-warn chat-warn-bar">
          <IconWarn size={12} /> 对方已断连，消息将在其重连后送达
        </p>
      )}

      <Composer
        agents={agents}
        defaultTarget={agent.id}
        targetName={agent.name}
        connected={connected}
        onSend={(to, text) => send(to, text)}
        onNewTask={() => {}}
      />
    </div>
  );
}
