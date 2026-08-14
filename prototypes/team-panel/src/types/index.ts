// ============================================================
// 领域类型 — DFH Workstation 团队管理面板原型
// 数据模型同时携带 display name 与 slot_id（协议映射见
// design/team-panel/interaction-spec.md §8），禁止用名称做 key。
// ============================================================

export type AgentStatus =
  | "spawning"
  | "idle"
  | "working"
  | "failed"
  | "offline"
  | "shutting_down";

export type AgentRole = "lead" | "teammate";

export interface Agent {
  /** slot_id（唯一 key，禁止用 display name 做 key） */
  id: string;
  /** display name（UI 展示用） */
  name: string;
  role: AgentRole;
  model: string;
  status: AgentStatus;
  skills: string[];
  mcp: string[];
  /** working 状态下的开始工作时间戳（用于"已工作 N 分钟"） */
  workingSince?: number;
  /** failed 原因 */
  failedReason?: string;
  /** 当前进行中任务 id（可选） */
  currentTaskId?: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskEvent {
  ts: number;
  actor: string; // display name
  action: string; // "创建并指派给 视觉-K3-1" / "标记为 in_progress" ...
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assigneeId?: string;
  createdAt: number;
  createdBy: string;
  startedAt?: number;
  completedAt?: number;
  /** 被这些任务 id 阻塞 */
  blockedBy?: string[];
  activity: TaskEvent[];
}

export type MessageKind = "user" | "agent" | "system";

export interface Message {
  id: string;
  kind: MessageKind;
  /** 目标 agent slot_id；广播时为 "*" */
  to: string;
  text: string;
  ts: number;
  from: string; // display name
  delivered: boolean;
  failed?: boolean;
}

export type ActivityKind =
  | "message"
  | "task_start"
  | "task_create"
  | "task_done"
  | "failed"
  | "spawn"
  | "shutdown"
  | "status";

export interface ActivityEvent {
  id: string;
  ts: number;
  kind: ActivityKind;
  text: string;
  refAgentId?: string;
  refTaskId?: string;
}

export interface SpawnTemplate {
  /** assistant id（对应 team_list_assistants） */
  id: string;
  name: string; // 架构-Pro
  model: string;
  description: string;
  skills: string[];
  mcp: string[];
}

export interface SpawnRequest {
  templateId: string;
  name: string;
  initialTask?: string;
}

export interface ShutdownResult {
  approved: boolean;
  reason?: string;
}

export interface ChatThread {
  messages: Message[];
  typing: boolean;
}

export type ViewId = "roster" | "board" | "activity";

export interface AgentStats {
  total: number;
  working: number;
  idle: number;
  failed: number;
  offline: number;
  spawning: number;
  shutting_down: number;
}
