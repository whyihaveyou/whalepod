// ============================================================
// Mock 数据 — 硬编码 agent/任务/对话/活动
// 仅 mock 层使用；组件通过 TeamApi 接口获取，禁止直接 import 本文件。
// 数据规模与结构对齐 wireframes：团队 11 人（1 lead + 10 teammate）、任务 6。
// ============================================================

import type {
  Agent,
  ActivityEvent,
  Message,
  SpawnTemplate,
  Task,
} from "../types";

const now = Date.now();
const min = 60_000;

export const mockAgents: Agent[] = [
  {
    id: "lead-1",
    name: "Aion CLI",
    role: "lead",
    model: "gpt-5.2",
    status: "working",
    skills: ["规划", "代码", "CLI"],
    mcp: ["github", "filesystem"],
    workingSince: now - 26 * min,
  },
  {
    id: "arch-1",
    name: "架构-Pro-1",
    role: "teammate",
    model: "deepseek-v4-flash",
    status: "working",
    skills: ["架构设计", "评审"],
    mcp: ["filesystem", "search"],
    workingSince: now - 32 * min,
  },
  {
    id: "arch-2",
    name: "架构-Pro-2",
    role: "teammate",
    model: "deepseek-v4-flash",
    status: "working",
    skills: ["数据建模", "文档"],
    mcp: ["filesystem"],
    workingSince: now - 12 * min,
  },
  {
    id: "vis-1",
    name: "视觉-K3-1",
    role: "teammate",
    model: "kimi-k3",
    status: "working",
    skills: ["UI 设计", "图标", "Token"],
    mcp: ["figma"],
    workingSince: now - 42 * min,
    currentTaskId: "task-1",
  },
  {
    id: "impl-1",
    name: "实现-Pro-1",
    role: "teammate",
    model: "deepseek-v4-flash",
    status: "idle",
    skills: ["React", "前端"],
    mcp: ["filesystem", "browser"],
  },
  {
    id: "impl-2",
    name: "实现-Pro-2",
    role: "teammate",
    model: "deepseek-v4-flash",
    status: "working",
    skills: ["TypeScript", "Node"],
    mcp: ["filesystem"],
    workingSince: now - 8 * min,
  },
  {
    id: "eng-1",
    name: "工程-Flash-1",
    role: "teammate",
    model: "gemini-flash",
    status: "failed",
    skills: ["CI/CD", "脚本"],
    mcp: ["github"],
    failedReason: "调用 GitHub API 超时（3 次）",
  },
  {
    id: "eng-2",
    name: "工程-Flash-2",
    role: "teammate",
    model: "gemini-flash",
    status: "working",
    skills: ["部署", "监控"],
    mcp: ["github", "filesystem"],
    workingSince: now - 18 * min,
  },
  {
    id: "orch-1",
    name: "编排-Pro",
    role: "teammate",
    model: "deepseek-v4-flash",
    status: "working",
    skills: ["任务编排", "SLA"],
    mcp: ["filesystem"],
    workingSince: now - 55 * min,
  },
  {
    id: "review-1",
    name: "评审-R-1",
    role: "teammate",
    model: "claude-sonnet-4.5",
    status: "offline",
    skills: ["代码评审", "安全"],
    mcp: ["github"],
  },
  {
    id: "data-1",
    name: "数据-Sci-1",
    role: "teammate",
    model: "deepseek-v4-flash",
    status: "working",
    skills: ["数据分析", "可视化"],
    mcp: ["filesystem"],
    workingSince: now - 4 * min,
  },
];

export const mockTasks: Task[] = [
  {
    id: "#019ffff4",
    title: "设计团队面板 UI 原型（含状态视觉）",
    description:
      "按 design/team-panel/ 规范输出高保真原型：roster 状态点、任务卡、模态交互。",
    status: "in_progress",
    assigneeId: "vis-1",
    createdAt: now - 42 * min,
    createdBy: "Aion CLI",
    startedAt: now - 40 * min,
    activity: [
      { ts: now - 42 * min, actor: "Aion CLI", action: "创建并指派给 视觉-K3-1" },
      { ts: now - 40 * min, actor: "视觉-K3-1", action: "标记为 in_progress" },
    ],
  },
  {
    id: "#019ffffb",
    title: "统一设计 token（暗色优先）",
    description: "tokens.css + tokens.json 双源，组件禁用写死色值。",
    status: "completed",
    assigneeId: "vis-1",
    createdAt: now - 3 * 60 * min,
    createdBy: "Aion CLI",
    completedAt: now - 58 * min,
    activity: [
      { ts: now - 3 * 60 * min, actor: "Aion CLI", action: "创建并指派给 视觉-K3-1" },
      { ts: now - 58 * min, actor: "视觉-K3-1", action: "标记为 completed" },
    ],
  },
  {
    id: "#019ffffc",
    title: "网关联调（MCP 鉴权）",
    description: "打通 agent 与 GitHub MCP 的鉴权通道。",
    status: "pending",
    assigneeId: "eng-2",
    createdAt: now - 20 * min,
    createdBy: "Aion CLI",
    blockedBy: ["#019ffffd"],
    activity: [
      { ts: now - 20 * min, actor: "Aion CLI", action: "创建并指派给 工程-Flash-2" },
    ],
  },
  {
    id: "#019ffffd",
    title: "修复 GitHub API 超时重试",
    description: "重试指数退避 + 幂等去重，完成后解除 #019ffffc 阻塞。",
    status: "pending",
    assigneeId: "eng-1",
    createdAt: now - 21 * min,
    createdBy: "Aion CLI",
    activity: [
      { ts: now - 21 * min, actor: "Aion CLI", action: "创建并指派给 工程-Flash-1" },
    ],
  },
  {
    id: "#019ffffe",
    title: "数据模型：任务依赖图",
    description: "阻塞关系建模（blockedBy），支撑 Kanban 阻塞标记。",
    status: "in_progress",
    assigneeId: "arch-2",
    createdAt: now - 12 * min,
    createdBy: "Aion CLI",
    startedAt: now - 10 * min,
    activity: [
      { ts: now - 12 * min, actor: "Aion CLI", action: "创建并指派给 架构-Pro-2" },
      { ts: now - 10 * min, actor: "架构-Pro-2", action: "标记为 in_progress" },
    ],
  },
  {
    id: "#019fffff",
    title: "编排：多 agent 并行执行",
    description: "按依赖关系并发调度，记录每 agent 工作耗时。",
    status: "pending",
    assigneeId: "orch-1",
    createdAt: now - 9 * min,
    createdBy: "Aion CLI",
    activity: [
      { ts: now - 9 * min, actor: "Aion CLI", action: "创建并指派给 编排-Pro" },
    ],
  },
];

// ---- 对话线程（mock）：仅给选中 agent 预设；空线程由 UI 生成系统条 ----
const mkMsg = (
  id: string,
  kind: Message["kind"],
  to: string,
  from: string,
  text: string,
  tsAgo: number,
  delivered = true,
): Message => ({ id, kind, to, from, text, ts: now - tsAgo * min, delivered });

export const mockThreads: Record<string, Message[]> = {
  "vis-1": [
    mkMsg("m1", "system", "vis-1", "系统", "任务 #019ffff4 已指派给你：设计团队面板 UI 原型（含状态视觉）", 40),
    mkMsg("m2", "user", "vis-1", "Aion CLI", "优先做 roster 的状态视觉，roster 是本次演示的重点", 38),
    mkMsg("m3", "agent", "vis-1", "视觉-K3-1", "收到。我会先出状态点 + 徽章的变体矩阵，再落到面板组件。", 37),
    mkMsg("m4", "agent", "vis-1", "视觉-K3-1", "状态视觉已就绪：spawning 三点弹跳、working 呼吸光晕、failed 实心 ✕。下一步开始任务卡。", 5),
  ],
  "eng-1": [
    mkMsg("m5", "system", "eng-1", "系统", "任务 #019ffffd 已指派给你：修复 GitHub API 超时重试", 20),
    mkMsg("m6", "agent", "eng-1", "工程-Flash-1", "三次调用 GitHub API 均超时（>10s），正在切换为指数退避重试。", 12),
    mkMsg("m7", "system", "eng-1", "系统", "⚠ 工程-Flash-1 进入 failed：调用 GitHub API 超时（3 次）", 3),
  ],
  "impl-1": [
    mkMsg("m8", "system", "impl-1", "系统", "这是与 实现-Pro-1 的对话起点", 60),
  ],
};

// ---- 活动流 ----
export const mockActivities: ActivityEvent[] = [
  { id: "a1", ts: now - 3 * min, kind: "failed", text: "工程-Flash-1 进入 failed：调用 GitHub API 超时（3 次）", refAgentId: "eng-1" },
  { id: "a2", ts: now - 5 * min, kind: "message", text: "视觉-K3-1 在对话中回复了你", refAgentId: "vis-1" },
  { id: "a3", ts: now - 8 * min, kind: "task_start", text: "实现-Pro-2 开始任务 #019ffffe 数据模型：任务依赖图", refAgentId: "impl-2", refTaskId: "#019ffffe" },
  { id: "a4", ts: now - 12 * min, kind: "task_create", text: "Aion CLI 创建任务 #019fffff 并指派给 编排-Pro", refTaskId: "#019fffff" },
  { id: "a5", ts: now - 40 * min, kind: "task_start", text: "视觉-K3-1 开始任务 #019ffff4", refAgentId: "vis-1", refTaskId: "#019ffff4" },
  { id: "a6", ts: now - 58 * min, kind: "task_done", text: "视觉-K3-1 完成任务 #019ffffb 统一设计 token（暗色优先）", refAgentId: "vis-1", refTaskId: "#019ffffb" },
  { id: "a7", ts: now - 70 * min, kind: "spawn", text: "数据-Sci-1 已上线（数据-Sci 模板）", refAgentId: "data-1" },
];

// ---- Spawn 模板（对应 team_list_assistants 目录） ----
export const mockTemplates: SpawnTemplate[] = [
  {
    id: "architect-pro",
    name: "架构-Pro",
    model: "deepseek-v4-flash",
    description: "系统设计、技术选型、接口契约。",
    skills: ["架构设计", "评审", "文档"],
    mcp: ["filesystem", "search"],
  },
  {
    id: "implementer-pro",
    name: "实现-Pro",
    model: "deepseek-v4-flash",
    description: "React/TS 前端与 Node 后端实现。",
    skills: ["React", "TypeScript", "Node"],
    mcp: ["filesystem", "browser"],
  },
  {
    id: "visual-k3",
    name: "视觉-K3",
    model: "kimi-k3",
    description: "UI 设计、设计系统、视觉规范。",
    skills: ["UI 设计", "图标", "Token"],
    mcp: ["figma"],
  },
  {
    id: "engineering-flash",
    name: "工程-Flash",
    model: "gemini-flash",
    description: "构建、部署、CI/CD、监控。",
    skills: ["CI/CD", "脚本", "监控"],
    mcp: ["github"],
  },
  {
    id: "orchestrator-pro",
    name: "编排-Pro",
    model: "deepseek-v4-flash",
    description: "任务编排、并行调度、SLA。",
    skills: ["任务编排", "调度"],
    mcp: ["filesystem"],
  },
  {
    id: "reviewer-r",
    name: "评审-R",
    model: "claude-sonnet-4.5",
    description: "代码评审、安全审查。",
    skills: ["代码评审", "安全"],
    mcp: ["github"],
  },
];

// 名称自动建议：模板名 + 现有同模板序号（在 mockApi 中计算）
export const existingNameCount: Record<string, number> = {
  "架构-Pro": 2,
  "实现-Pro": 2,
  "视觉-K3": 1,
  "工程-Flash": 2,
  "编排-Pro": 1,
  "评审-R": 1,
  "数据-Sci": 1,
};
