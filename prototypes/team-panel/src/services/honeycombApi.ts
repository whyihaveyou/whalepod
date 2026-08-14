// ============================================================
// honeycombApi — TeamApi 接口的真实实现（基于 @dfh/honeycomb 客户端）
// ------------------------------------------------------------
// 走 transport 客户端（当前为同构薄封装 localHoneycombClient；架构-Pro-1
// 复审 SDK 后，把模块顶部 import 换成真 SDK @dfh/honeycomb/transport 的
// createHoneycombClient 即可无缝接入，签名一致）。
//
// 映射：
//   LocalMember            → Agent          （queen→lead, worker→teammate）
//   LocalTask              → Task           （backlog→pending, in-progress→in_progress …）
//   LocalMessage           → Message        （from==='user'&&kind chat→user …）
//   LocalActivityItem      → ActivityEvent
//   LocalTask / feed       → TaskEvent / ChatThread
//
// 数据获取采用「每次 list* 直接拉取」模式（无本地缓存），配合 store 的
// reload() 拉模型，避免客户端缓存与事件流的竞态；WS 事件仅触发 notify。
// ============================================================

import type {
  Agent, ActivityEvent, ChatThread, Message, ShutdownResult,
  SpawnRequest, SpawnTemplate, Task, TaskStatus,
} from "../types";
import type {
  TeamApi,
} from "./api";
import {
  createLocalHoneycombClient,
  type LocalHoneycombClient,
  type LocalHoneycombClientOptions,
} from "./localHoneycombClient";
import type {
  LocalMember, LocalTask, LocalMessage, LocalActivityItem, LocalHiveId,
  LocalMemberId, LocalMessageKind, LocalHatchMemberInput,
} from "./transportDto";

// ---------- 构造参数 ----------
export interface HoneycombApiOptions {
  httpUrl: string;
  wsUrl: string;
  hiveId: LocalHiveId;
  /** 覆盖客户端工厂（默认用本地薄封装；切真 SDK 时替换为 createHoneycombClient） */
  createClient?: (opts: LocalHoneycombClientOptions) => LocalHoneycombClient;
}

/** 关联到任务反馈的「assistant 目录」（原型内置；接 AION 环境后走 context.assistants） */
const DEFAULT_TEMPLATES: SpawnTemplate[] = [
  { id: "pro-lead", name: "架构-Pro", model: "deepseek-v4-pro", description: "架构设计与主导", skills: ["planning", "codegen"], mcp: [] },
  { id: "pro-impl", name: "实现-Pro", model: "deepseek-v4-pro", description: "功能实现", skills: ["typescript", "testing"], mcp: [] },
  { id: "flash", name: "工程-Flash", model: "deepseek-v4-flash", description: "快速执行 / 样板", skills: ["scaffold", "test"], mcp: [] },
  { id: "k3", name: "视觉-K3", model: "deepseek-k3", description: "视觉 / 审美", skills: ["ui", "design"], mcp: [] },
];

/** 领域 → 任务描述的正向/反向映射（DTO 与面板词汇不同）。 */
function taskStatusToDto(s: TaskStatus): LocalTask["status"] {
  switch (s) {
    case "pending": return "backlog";
    case "in_progress": return "in-progress";
    case "completed": return "completed";
  }
}
function taskStatusFromDto(s: LocalTask["status"]): TaskStatus {
  switch (s) {
    case "backlog": return "pending";
    case "in-progress": return "in_progress";
    case "completed": return "completed";
    case "blocked": return "pending";
    case "cancelled": return "completed";
  }
}

function agentStatusFromMember(m: LocalMember): Agent["status"] {
  switch (m.status) {
    case "hatching": return "spawning";
    case "idle": return "idle";
    case "working":
    case "waiting": return "working";
    case "dismissed": return "offline";
    case "failed": return "failed";
    case "paused": return "idle";
  }
}

function roleFromMember(m: LocalMember): Agent["role"] {
  return m.role === "queen" ? "lead" : "teammate";
}

function messageKindFromLocal(from: LocalMessage["from"], kind: LocalMessageKind): Message["kind"] {
  if (kind === "system" || from === "system") return "system";
  if (from === "user") return "user";
  return "agent";
}

function toAgent(m: LocalMember, currentTaskId?: string): Agent {
  return {
    id: m.id,
    name: m.name,
    role: roleFromMember(m),
    model: m.model ?? "unknown",
    status: agentStatusFromMember(m),
    skills: [],
    mcp: [],
    currentTaskId,
  };
}

function toTask(t: LocalTask): Task {
  return {
    id: t.id,
    title: t.subject,
    description: t.description ?? "",
    status: taskStatusFromDto(t.status),
    assigneeId: t.owner,
    createdAt: t.createdAt,
    createdBy: t.owner ? `member:${t.owner}` : "system",
    startedAt: t.status === "in-progress" ? t.updatedAt : undefined,
    completedAt: t.status === "completed" ? t.updatedAt : undefined,
    blockedBy: t.blockedBy?.length ? t.blockedBy : undefined,
    activity: [], // 由事件/详情补；原型不逐条回放全部 TaskEvent
  };
}

function toMessage(msg: LocalMessage): Message {
  return {
    id: msg.id,
    kind: messageKindFromLocal(msg.from, msg.kind),
    to: msg.to,
    text: msg.content,
    ts: msg.createdAt,
    from: String(msg.from),
    delivered: true,
  };
}

function toActivity(item: LocalActivityItem): ActivityEvent {
  if (item.kind === "task") {
    const t = item.task;
    const kind: ActivityEvent["kind"] =
      t.status === "completed" ? "task_done"
      : t.status === "in-progress" ? "task_start"
      : t.status === "backlog" ? "task_create" : "status";
    return {
      id: t.id,
      ts: t.updatedAt,
      kind,
      text: `${kind === "task_create" ? "创建任务" : kind === "task_start" ? "启动任务" : "完成任务"}：${t.subject}`,
      refTaskId: t.id,
      refAgentId: t.owner,
    };
  }
  const msg = item.message;
  return {
    id: msg.id,
    ts: msg.createdAt,
    kind: "message",
    text: `${msg.from} → ${msg.to}: ${msg.content}`,
    refAgentId: String(msg.from),
  };
}

export function createHoneycombApi(options: HoneycombApiOptions): TeamApi {
  const createClientImpl = options.createClient ?? createLocalHoneycombClient;
  const client: LocalHoneycombClient = createClientImpl({
    httpUrl: options.httpUrl,
    wsUrl: options.wsUrl,
    hiveId: options.hiveId,
  });
  const hiveId = options.hiveId;

  /** 每个语言下的「监听器 → 变化通知」，用于触发 store reload。 */
  const listeners = new Set<() => void>();
  const wsTopics = new Set<string>();
  let wsSubscribed = false;

  function notify(): void {
    for (const fn of [...listeners]) fn();
  }

  /** 懒建立 WS 订阅：连接客户端 + 订阅该 hive + 挂各 topic 的 handler → notify()。 */
  async function ensureSubscribed(): Promise<void> {
    if (wsSubscribed) return;
    await client.connect();
    await client.subscribe(hiveId);
    const topics = [
      "hive/created", "hive/renamed", "hive/removed",
      "member/hatched", "member/dismissed", "member/status", "member/work-state",
      "task/created", "task/updated",
      "message/created", "message/read",
    ] as const;
    for (const topic of topics) {
      if (wsTopics.has(topic)) continue;
      wsTopics.add(topic);
      client.on(topic, () => notify());
    }
    wsSubscribed = true;
  }

  const api: TeamApi = {
    // ------------------ roster ------------------
    listAgents: async () => {
      await ensureSubscribed();
      const members = await client.member.list(hiveId);
      return members.map((m) => toAgent(m));
    },

    reconnect: async () => {
      wsSubscribed = false;
      for (const topic of wsTopics) client.on(topic, () => notify()); // 重新挂（幂等）
      await client.reconnect?.();
      await ensureSubscribed();
      notify();
    },

    restartAgent: async (agentId) => {
      const members = await client.member.list(hiveId);
      const prev = members.find((m) => m.id === agentId);
      // 契约无"重启"端点：先用 dismiss + 按原样 re-hatch 模拟（best-effort）
      await client.member.dismiss(hiveId, agentId);
      if (prev) {
        const hatched = await client.member.hatch(hiveId, {
          name: prev.name,
          role: prev.role === "queen" ? "queen" : "worker",
          backend: prev.backend,
          model: prev.model,
        });
        notify();
        return toAgent(hatched);
      }
      notify();
      return toAgent(prev!);
    },

    spawnAgent: async (req) => {
      const template = DEFAULT_TEMPLATES.find((t) => t.id === req.templateId);
      const input: LocalHatchMemberInput = {
        name: req.name,
        role: "worker",
        backend: "native",
        model: template?.model,
      };
      const member = await client.member.hatch(hiveId, input);
      if (req.initialTask) {
        await client.task.create(hiveId, { subject: req.initialTask, owner: member.id });
      }
      notify();
      return toAgent(member);
    },

    requestShutdown: async (_agentId, force) => {
      // 契约无优雅关机 RPC：force → remove；否则发一条 shutdown 指令（best-effort）
      if (force) {
        await client.member.remove(hiveId, _agentId);
        notify();
        return { approved: true };
      }
      await client.message.send(hiveId, { from: "system", to: _agentId, kind: "system", content: "SHUTDOWN_GRACEFUL" });
      notify();
      return { approved: true, reason: "graceful (best-effort directive)" };
    },

    cancelShutdown: async (agentId) => {
      await client.message.send(hiveId, { from: "system", to: agentId, kind: "system", content: "SHUTDOWN_CANCEL" });
      notify();
    },

    // ------------------ task board ------------------
    listTasks: async () => {
      const tasks = await client.task.list(hiveId, {});
      return tasks.map(toTask);
    },

    updateTaskStatus: async (taskId, status) => {
      const t = await client.task.update(hiveId, taskId, { status: taskStatusToDto(status) });
      notify();
      return toTask(t);
    },

    createTask: async (title, assigneeId) => {
      const t = await client.task.create(hiveId, { subject: title, owner: assigneeId ?? null });
      notify();
      return toTask(t);
    },

    // ------------------ chat ------------------
    getThread: async (agentId) => {
      const page = await client.message.feed(hiveId, undefined, 100);
      const related: Message[] = [];
      for (const item of page.items) {
        if (item.kind !== "message") continue;
        const msg = item.message;
        const involved = msg.to === agentId || msg.to === "all" || msg.from === agentId || msg.from === "user";
        if (!involved) continue;
        related.push(toMessage(msg));
      }
      related.sort((a, b) => a.ts - b.ts);
      return { messages: related, typing: false };
    },

    sendMessage: async (to, text) => {
      const isBroadcast = to === "*";
      const msg = await client.message.send(hiveId, {
        from: "user",
        to: isBroadcast ? "all" : (to as LocalMemberId),
        kind: "chat",
        content: text,
      });
      notify();
      return toMessage(msg);
    },

    // ------------------ activity ------------------
    listActivities: async () => {
      const page = await client.message.feed(hiveId, undefined, 60);
      return page.items.map(toActivity);
    },

    // ------------------ spawn templates ------------------
    listTemplates: async () => DEFAULT_TEMPLATES,

    // ------------------ 推送（WS → notify 触发 store reload） ------------------
    subscribe: (listener) => {
      listeners.add(listener);
      void ensureSubscribed().catch(() => {
        /* 连接失败不打断订阅注册；reload 时再试 */
      });
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return api;
}
