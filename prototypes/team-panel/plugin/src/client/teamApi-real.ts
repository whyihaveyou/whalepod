// ============================================================
// 真实 transport 适配器 — 团队面板 → @whalepod/honeycomb
// 实现 TeamApi（见 prototypes/team-panel/src/services/api.ts），
// 数据全部来自真实 createHoneycombClient（dev-server / dsh 运行时），不 mock。
//
// 已按真实 SDK 事实对齐（docs/honeycomb-transport-api.md）：
//  - 资源方法已自动解包 `{ok,data}` 信封，直接返回 data（`await client.member.list()`
//    => Member[]，不是 { data }）。
//  - hiveId 不硬编：boot 时 GET /v1/hives 取 name==='hive-dev' 那条 id。
//  - 真实 DTO：MemberStatus('finished'|'dormant')、MessageKind('note' 无 'chat')、
//    Task.subject、Message.content；activity 走 `message.feed()`（无独立 activity 域）。
// ============================================================
import {
  createHoneycombClient,
  HoneycombClient,
  ActivityItem,
  Member,
  Task as HcTask,
  MessageKind,
  MemberStatus as HcMemberStatus,
  OutgoingMessage,
} from "@whalepod/honeycomb";

import type {
  ActivityEvent,
  Agent,
  AgentStatus,
  AgentRole,
  ChatThread,
  Message,
  ShutdownResult,
  SpawnRequest,
  SpawnTemplate,
  Task,
  TaskStatus,
  TeamApi,
} from "../../../src/types";

// ------------------------------------------------------------
// 配置
// ------------------------------------------------------------
export interface RealTeamOptions {
  httpUrl?: string;
  wsUrl?: string;
  /** 目标 hive 的 display name；默认 'hive-dev' */
  hiveName?: string;
  /** 若给定 hiveId 则跳过解析直接用 */
  hiveId?: string;
  /** 孵化默认后端（registry catalog 里的 backend id） */
  defaultBackend?: string;
}

const DEFAULT_OPTS: Required<Pick<RealTeamOptions, "httpUrl" | "wsUrl" | "hiveName" | "defaultBackend">> = {
  httpUrl: "http://127.0.0.1:4800",
  wsUrl: "ws://127.0.0.1:4800/ws",
  hiveName: "hive-dev",
  defaultBackend: "native",
};

// ------------------------------------------------------------
// DTO 映射（真实 → 面板领域）
// ------------------------------------------------------------
const HC_STATUS: Record<HcMemberStatus, AgentStatus> = {
  hatching: "spawning",
  idle: "idle",
  working: "working",
  finished: "idle", // 本轮完成 = 可再接活
  failed: "failed",
  dormant: "offline", // 休眠 ≈ 离线
};

const HC_ROLE: Record<string, AgentRole> = { queen: "lead", worker: "teammate" };

const HC_TASK_STATUS: Record<string, TaskStatus> = {
  backlog: "pending",
  "in-progress": "in_progress",
  completed: "completed",
  cancelled: "pending",
  blocked: "pending",
};

const HC_MSG_KIND: Record<MessageKind, Message["kind"]> = {
  directive: "agent",
  report: "agent",
  note: "agent",
  "shutdown-request": "system",
  system: "system",
};

function toAgent(member: Member): Agent {
  return {
    id: member.id, // slot id —— 唯一 key
    name: member.name,
    role: HC_ROLE[member.role] ?? "teammate",
    model: member.model ?? "",
    status: HC_STATUS[member.status] ?? "idle",
    skills: [],
    mcp: [],
    failedReason: member.status === "failed" ? `status=${member.status}` : undefined,
  };
}

function toTask(task: HcTask): Task {
  return {
    id: task.id,
    title: task.subject,
    description: task.description ?? "",
    status: HC_TASK_STATUS[task.status] ?? "pending",
    assigneeId: task.owner,
    createdAt: task.createdAt,
    createdBy: "", // transport DTO 无 author 字段，UI 不依赖
    blockedBy: task.blockedBy,
    activity: [],
  };
}

function toActivity(item: ActivityItem): ActivityEvent {
  if (item.kind === "message") {
    const m = item.message;
    return {
      id: m.id,
      ts: m.createdAt,
      kind: "message",
      text: `[${m.kind}] ${m.from}: ${m.content}`,
    };
  }
  const t = item.task;
  return {
    id: t.id,
    ts: t.createdAt,
    kind: "task",
    text: `${t.subject} → ${t.status}`,
  };
}

// 模板目录：client 侧静态（transport 无该端点；随 catalog 扩展）
const STATIC_TEMPLATES: SpawnTemplate[] = [
  {
    id: "native",
    name: "原生会话",
    model: "native",
    description: "DSH 原生会话（native-runtime）作为编队成员",
    skills: [],
    mcp: [],
  },
];

// ------------------------------------------------------------
// 构造器
// ------------------------------------------------------------
export async function createRealTeamApi(options: RealTeamOptions = {}): Promise<TeamApi> {
  const opts = { ...DEFAULT_OPTS, ...options };

  const client = createHoneycombClient({ httpUrl: opts.httpUrl, wsUrl: opts.wsUrl });
  await client.connect();

  // —— 动态解析 hiveId（不硬编）——
  const hiveName = opts.hiveName ?? DEFAULT_OPTS.hiveName;
  const hiveId = opts.hiveId ?? (await resolveHiveId(client, hiveName));
  await client.subscribe(hiveId);

  let refreshListeners = new Set<() => void>();
  const notify = () => refreshListeners.forEach((fn) => fn());

  // WS 推送 → 通知 store 重拉
  const topics = [
    "member/hatched",
    "member/dismissed",
    "member/status",
    "member/work-state",
    "task/created",
    "task/updated",
    "message/created",
    "message/read",
  ] as const;
  const offs = topics.map((topic) => client.on(topic, () => notify()));

  const api: TeamApi = {
    // ---- roster ----
    async listAgents(): Promise<Agent[]> {
      const members = await client.member.list(hiveId);
      return members.map(toAgent);
    },
    async reconnect(): Promise<void> {
      await client.connect();
      if (!client.connected) await client.subscribe(hiveId);
      notify();
    },
    async restartAgent(agentId: string): Promise<Agent> {
      // 真实 transport 无 restart 端点；best-effort 探测存在性后返回最新名单。
      const member = await client.member.get(hiveId, agentId);
      return toAgent(member);
    },
    async spawnAgent(req: SpawnRequest): Promise<Agent> {
      // SpawnRequest 只带 templateId/name/initialTask；model 来自模板目录，
      // 后端取配置缺省（native-runtime / 连接器 catalog）。
      const member = await client.member.hatch(hiveId, {
        name: req.name,
        backend: opts.defaultBackend,
        role: "worker",
      });
      return toAgent(member);
    },
    async requestShutdown(agentId: string, force: boolean): Promise<ShutdownResult> {
      const kind: MessageKind = force ? "system" : "shutdown-request";
      const outgoing: OutgoingMessage = {
        from: "user",
        to: agentId,
        kind,
        content: force ? "shutdown:force" : "shutdown:request",
      };
      await client.message.send(hiveId, outgoing);
      return { approved: force, reason: force ? "已强制遣散" : "已发起遣散请求" };
    },
    async cancelShutdown(agentId: string): Promise<void> {
      await client.message.send(hiveId, {
        from: "user",
        to: agentId,
        kind: "note",
        content: "cancel-shutdown",
      });
    },

    // ---- task board ----
    async listTasks(): Promise<Task[]> {
      const tasks = await client.task.list(hiveId);
      return tasks.map(toTask);
    },
    async updateTaskStatus(taskId: string, status: TaskStatus): Promise<Task> {
      const real: "backlog" | "in-progress" | "completed" =
        status === "in_progress" ? "in-progress" : status === "pending" ? "backlog" : "completed";
      const task = await client.task.update(hiveId, taskId, { status: real });
      return toTask(task);
    },
    async createTask(title: string, assigneeId?: string): Promise<Task> {
      const task = await client.task.create(hiveId, {
        subject: title,
        ...(assigneeId ? { owner: assigneeId } : {}),
      });
      return toTask(task);
    },

    // ---- chat ----
    async getThread(agentId: string): Promise<ChatThread> {
      const list = await client.message.inbox(hiveId, agentId);
      const messages: Message[] = list.map((m) => {
        const isMe = String(m.from) === "user";
        return {
          id: m.id,
          kind: isMe ? "user" : HC_MSG_KIND[m.kind] ?? "agent",
          to: String(m.to),
          text: m.content,
          ts: m.createdAt,
          from: isMe ? "我" : String(m.from),
          delivered: true,
        };
      });
      return { messages, typing: false };
    },
    async sendMessage(to: string, text: string): Promise<Message> {
      const outgoing: OutgoingMessage = {
        from: "user",
        to,
        kind: "note", // 真实 MessageKind 无 'chat'
        content: text,
      };
      const msg = await client.message.send(hiveId, outgoing);
      return {
        id: msg.id,
        kind: "user",
        to: String(msg.to),
        text: msg.content,
        ts: msg.createdAt,
        from: "我",
        delivered: true,
      };
    },

    // ---- activity ----
    async listActivities(): Promise<ActivityEvent[]> {
      const page = await client.message.feed(hiveId);
      return (page?.items ?? []).map(toActivity);
    },

    // ---- spawn templates ----
    async listTemplates(): Promise<SpawnTemplate[]> {
      return STATIC_TEMPLATES;
    },

    // ---- 推送 ----
    subscribe(listener: () => void): () => void {
      refreshListeners.add(listener);
      return () => {
        refreshListeners.delete(listener);
      };
    },
  };

  (api as TeamApi & { dispose?: () => void }).dispose = () => {
    offs.forEach((off) => off());
    refreshListeners.clear();
    void client.close();
  };

  return api;
}

// ------------------------------------------------------------
// hiveId 动态解析
// ------------------------------------------------------------
async function resolveHiveId(client: HoneycombClient, hiveName: string): Promise<string> {
  const hives = await client.hive.list();
  const hit = hives.find((h) => h.name === hiveName);
  if (!hit) {
    throw new Error(
      `[ui-whalepod-team] 未找到 hive "${hiveName}"。` +
        "请先在 packages/honeycomb 下 `pnpm run dev-server` 再打开面板。",
    );
  }
  return hit.id;
}
