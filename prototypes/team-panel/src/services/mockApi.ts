// ============================================================
// MockApi — TeamApi 的 mock 实现
// 模拟：网络延迟、spawn 异步上线、关机协商（批准/拒绝）、
//       发送消息 → typing → agent 回复、状态推送。
// 后续替换为真实 @whalepod/honeycomb API 时，实现同一接口即可。
// ============================================================

import type {
  Agent,
  ActivityEvent,
  ChatThread,
  Message,
  ShutdownResult,
  SpawnRequest,
  SpawnTemplate,
  Task,
  TaskStatus,
} from "../types";
import type { TeamApi } from "./api";
import {
  mockActivities,
  mockAgents,
  mockTasks,
  mockThreads,
  mockTemplates,
  existingNameCount,
} from "../data/mockData";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => Date.now();

/** agent 状态转文字（状态栏/列表副行用） */
export const statusText = (a: Agent): string => {
  switch (a.status) {
    case "working":
      return `已工作 ${Math.max(1, Math.round(((now() - (a.workingSince ?? now())) / 60_000)))} 分钟`;
    case "spawning":
      return "上线中…";
    case "idle":
      return "空闲";
    case "failed":
      return "失败（可重启）";
    case "offline":
      return "已断连";
    case "shutting_down":
      return "等待关机确认…";
  }
};

const AGENT_REPLIES: Record<string, string[]> = {
  default: ["收到，我来处理。", "好，这个我接手了。", "了解，稍后同步进展。"],
  "arch-1": ["架构上没问题，我会先出接口契约。"],
  "vis-1": ["收到。我会优先处理状态视觉，然后给你初稿。"],
  "eng-1": ["我会先用指数退避重试，把超时问题解决。"],
  "impl-1": ["可以，我列个实现清单。"],
};

export class MockApi implements TeamApi {
  private agents: Agent[] = mockAgents.map((a) => ({ ...a }));
  private tasks: Task[] = mockTasks.map((t) => ({ ...t, activity: [...t.activity] }));
  private threads: Record<string, Message[]> = Object.fromEntries(
    Object.entries(mockThreads).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
  );
  private typingFlags = new Set<string>();
  private activities: ActivityEvent[] = [...mockActivities];
  private timers: number[] = [];

  private listeners = new Set<() => void>();
  private notify() {
    this.listeners.forEach((l) => l());
  }
  private later(fn: () => void, ms = 600) {
    const t = window.setTimeout(fn, ms);
    this.timers.push(t);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- roster ----------
  async listAgents(): Promise<Agent[]> {
    await delay(120);
    return this.agents.map((a) => ({ ...a }));
  }

  async reconnect(): Promise<void> {
    await delay(400);
    this.notify();
  }

  async restartAgent(agentId: string): Promise<Agent> {
    const a = this.agents.find((x) => x.id === agentId)!;
    a.status = "spawning";
    a.workingSince = undefined;
    this.pushActivity({
      kind: "status",
      text: `${a.name} 正在重启…`,
      refAgentId: a.id,
    });
    this.notify();
    await delay(400);
    return this.finishSpawn(a);
  }

  async spawnAgent(req: SpawnRequest): Promise<Agent> {
    const template = mockTemplates.find((t) => t.id === req.templateId)!;
    // 演示用失败分支：名称含 "fail" 时，先出现 spawning 条目再上线失败
    const shouldFail = /fail/i.test(req.name);
    const a: Agent = {
      id: `slot-${uid()}`,
      name: req.name || template.name,
      role: "teammate",
      model: template.model,
      status: "spawning",
      skills: [...template.skills],
      mcp: [...template.mcp],
    };
    this.agents.unshift(a);
    this.pushActivity({
      kind: "spawn",
      text: `${a.name} 正在上线（${template.name} 模板）…`,
      refAgentId: a.id,
    });
    this.notify();
    // 初始任务：创建任务并指派
    if (req.initialTask?.trim()) {
      await this.createTask(req.initialTask.trim(), a.id);
    }
    // 模拟异步上线
    await delay(1800);
    if (shouldFail) {
      this.agents = this.agents.filter((x) => x.id !== a.id);
      this.pushActivity({
        kind: "failed",
        text: `${a.name} 上线失败：无法创建 agent 进程`,
        refAgentId: a.id,
      });
      this.notify();
      throw new Error("无法创建 agent 进程（模拟失败）");
    }
    return this.finishSpawn(a);
  }

  private async finishSpawn(a: Agent): Promise<Agent> {
    a.status = "idle";
    this.pushActivity(
      {
        kind: "spawn",
        text: `${a.name} 已上线（${a.model}）`,
        refAgentId: a.id,
      },
      { ts: now() },
    );
    this.notify();
    return { ...a };
  }

  async requestShutdown(agentId: string, force: boolean): Promise<ShutdownResult> {
    const a = this.agents.find((x) => x.id === agentId)!;
    a.status = "shutting_down";
    this.pushActivity({
      kind: "shutdown",
      text: `已向 ${a.name} 发送关机请求${force ? "（强制）" : ""}`,
      refAgentId: a.id,
    });
    this.notify();

    if (force) {
      await delay(1200);
      return this.doRemove(a, "强制关机");
    }
    // 协商：默认批准（有时拒绝，展示 rejected 路径）
    const reject = a.id === "impl-1";
    await delay(2000);
    if (reject) {
      a.status = "idle";
      const reason = "当前有未提交的草稿，不想丢失";
      this.pushActivity({
        kind: "shutdown",
        text: `${a.name} 拒绝关机：${reason}`,
        refAgentId: a.id,
      });
      this.notify();
      return { approved: false, reason };
    }
    return this.doRemove(a, "成员批准");
  }

  async cancelShutdown(agentId: string): Promise<void> {
    const a = this.agents.find((x) => x.id === agentId);
    if (!a || a.status !== "shutting_down") return;
    a.status = "idle";
    this.pushActivity({
      kind: "shutdown",
      text: `已取消对 ${a.name} 的关机请求`,
      refAgentId: a.id,
    });
    this.notify();
  }

  private doRemove(a: Agent, how: string): ShutdownResult {
    this.agents = this.agents.filter((x) => x.id !== a.id);
    delete this.threads[a.id];
    this.typingFlags.delete(a.id);
    this.pushActivity({
      kind: "shutdown",
      text: `${a.name} 已关机（${how}）`,
      refAgentId: a.id,
    });
    this.notify();
    return { approved: true };
  }

  // ---------- tasks ----------
  async listTasks(): Promise<Task[]> {
    await delay(120);
    return this.tasks.map((t) => ({ ...t, activity: [...t.activity] }));
  }

  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<Task> {
    const t = this.tasks.find((x) => x.id === taskId)!;
    t.status = status;
    if (status === "in_progress") {
      t.startedAt = t.startedAt ?? now();
      const assignee = this.agents.find((a) => a.id === t.assigneeId);
      if (assignee) {
        assignee.status = "working";
        assignee.currentTaskId = t.id;
        assignee.workingSince = now();
      }
    }
    if (status === "completed") {
      t.completedAt = now();
      const assignee = this.agents.find((a) => a.id === t.assigneeId);
      if (assignee) {
        assignee.status = "idle";
        assignee.currentTaskId = undefined;
        assignee.workingSince = undefined;
      }
    }
    t.activity.push({ id: `evt-${uid()}`, ts: now(), actor: "Aion CLI", action: `标记为 ${status}` });
    this.pushActivity(
      {
        kind: status === "completed" ? "task_done" : "task_start",
        text: `任务 ${t.id} ${t.title} 已标记为 ${status}`,
        refTaskId: t.id,
      },
      { ts: now() },
    );
    this.notify();
    await delay(200);
    return { ...t, activity: [...t.activity] };
  }

  async createTask(title: string, assigneeId?: string): Promise<Task> {
    const t: Task = {
      id: `#${uid().slice(0, 7)}`,
      title,
      description: "",
      status: "pending",
      assigneeId,
      createdAt: now(),
      createdBy: "Aion CLI",
      activity: [
        {
          id: `evt-${uid()}`,
          ts: now(),
          actor: "Aion CLI",
          action: assigneeId
            ? `创建并指派给 ${this.agents.find((a) => a.id === assigneeId)?.name ?? "成员"}`
            : "创建（未指派）",
        },
      ],
    };
    this.tasks.unshift(t);
    this.pushActivity({
      kind: "task_create",
      text: `任务 ${t.id} ${t.title} 已创建`,
      refTaskId: t.id,
    });
    this.notify();
    return { ...t, activity: [...t.activity] };
  }

  // ---------- chat ----------
  async getThread(agentId: string): Promise<ChatThread> {
    await delay(100);
    const messages = this.threads[agentId] ?? [];
    return { messages: messages.map((m) => ({ ...m })), typing: this.typingFlags.has(agentId) };
  }

  async sendMessage(to: string, text: string): Promise<Message> {
    const msg: Message = {
      id: `msg-${uid()}`,
      kind: "user",
      to,
      text,
      ts: now(),
      from: "Aion CLI",
      delivered: false,
    };
    // 广播：追加到每个成员的线程
    const targets = to === "*" ? this.agents : this.agents.filter((a) => a.id === to);
    targets.forEach((a) => {
      if (!this.threads[a.id]) this.threads[a.id] = [];
      this.threads[a.id].push({ ...msg, to: a.id });
    });
    if (!this.threads[to] && to !== "*") this.threads[to] = [];
    if (to !== "*" && !targets.length) this.threads[to].push({ ...msg, to });
    this.notify();
    await delay(300);
    // 标记送达（offline 成员无法送达，标记为失败）
    targets.forEach((a) => {
      const m = this.threads[a.id]?.find((x) => x.id === msg.id);
      if (m) {
        if (a.status === "offline") m.failed = true;
        else m.delivered = true;
      }
    });
    this.notify();
    // agent typing → 回复
    if (to !== "*") {
      const agent = this.agents.find((a) => a.id === to);
      if (agent && agent.status !== "offline") {
        this.typingFlags.add(agent.id);
        this.notify();
        this.later(() => this.agentReply(agent!, msg), 900);
      }
    }
    const finalMsg = to === "*"
      ? { ...msg, delivered: true }
      : this.threads[to]?.find((x) => x.id === msg.id) ?? { ...msg, delivered: true };
    return { ...finalMsg };
  }

  private agentReply(agent: Agent, replyTo: Message) {
    this.typingFlags.delete(agent.id);
    // 成员可能已被移除
    if (!this.agents.some((x) => x.id === agent.id)) {
      this.notify();
      return;
    }
    const pool = AGENT_REPLIES[agent.id] ?? AGENT_REPLIES.default;
    const reply: Message = {
      id: `msg-${uid()}`,
      kind: "agent",
      to: agent.id,
      text: pool[Math.floor(Math.random() * pool.length)],
      ts: now(),
      from: agent.name,
      delivered: true,
    };
    if (!this.threads[agent.id]) this.threads[agent.id] = [];
    this.threads[agent.id].push(reply);
    this.pushActivity({
      kind: "message",
      text: `${agent.name} 在对话中回复了你`,
      refAgentId: agent.id,
    });
    this.notify();
  }

  // ---------- activity / templates ----------
  async listActivities(): Promise<ActivityEvent[]> {
    await delay(100);
    return [...this.activities].sort((a, b) => b.ts - a.ts);
  }

  async listTemplates(): Promise<SpawnTemplate[]> {
    await delay(100);
    return mockTemplates.map((t) => ({ ...t }));
  }

  private pushActivity(e: Omit<ActivityEvent, "id" | "ts">, patch?: Partial<ActivityEvent>) {
    this.activities.unshift({
      id: `act-${uid()}`,
      ts: now(),
      ...e,
      ...patch,
    });
    this.activities = this.activities.slice(0, 60);
  }
}

// 供名称自动建议使用
export { existingNameCount };
