// ============================================================
// 数据访问层抽象 — TeamApi 接口
// 原型用 MockApi 实现；后续替换为 @whalepod/honeycomb 真实 API 时，
// 只需实现同一接口并注入（见 src/App.tsx 顶部的 api 实例）。
// 组件只依赖本接口与 hooks，不感知 mock 细节。
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

export interface TeamApi {
  // ---- roster ----
  listAgents(): Promise<Agent[]>;
  /** 重连后强制重新拉取（原型中即刷新 mock 状态） */
  reconnect(): Promise<void>;
  restartAgent(agentId: string): Promise<Agent>;
  spawnAgent(req: SpawnRequest): Promise<Agent>;
  requestShutdown(agentId: string, force: boolean): Promise<ShutdownResult>;
  /** 取消等待中的关机请求（成员回到 idle） */
  cancelShutdown(agentId: string): Promise<void>;

  // ---- task board ----
  listTasks(): Promise<Task[]>;
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<Task>;
  createTask(title: string, assigneeId?: string): Promise<Task>;

  // ---- chat ----
  getThread(agentId: string): Promise<ChatThread>;
  sendMessage(to: string, text: string): Promise<Message>;

  // ---- activity ----
  listActivities(): Promise<ActivityEvent[]>;

  // ---- spawn templates ----
  listTemplates(): Promise<SpawnTemplate[]>;

  // ---- 推送（mock 用事件模拟；真实实现走 websocket/polling） ----
  subscribe(listener: () => void): () => void;
}
