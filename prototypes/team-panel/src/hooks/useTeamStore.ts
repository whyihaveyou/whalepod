// ============================================================
// useTeamStore — 数据层 hooks
// 组件只使用这里的 hooks + TeamApi 类型，不感知 mock 实现。
// 替换真实 API：new TeamStore(realApi) 即可。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ViewId,
} from "../types";
import type { TeamApi } from "../services/api";
import { MockApi, statusText } from "../services/mockApi";
import { createHoneycombApi } from "../services/honeycombApi";

export class TeamStore {
  constructor(readonly api: TeamApi) {}
}

/**
 * 数据源切换开关：
 * - VITE_TEAM_API=honeycomb → 走 createHoneycombApi（默认 localHoneycombClient 同构后端，
 *   cordis 迁移 + 真 server 联调绿后可传 httpUrl/wsUrl 切真连接，见 honeycombApi.ts 头注）；
 * - 缺省 mock，保证原型独立可跑。
 */
function buildApi(): TeamApi {
  const env = import.meta.env;
  if (env.VITE_TEAM_API === "honeycomb") {
    return createHoneycombApi({
      httpUrl: env.VITE_HONEYCOMB_HTTP ?? "http://127.0.0.1:4800",
      wsUrl: env.VITE_HONEYCOMB_WS ?? "ws://127.0.0.1:4801",
      hiveId: env.VITE_HONEYCOMB_HIVE ?? "hive-dev",
    });
  }
  return new MockApi();
}

let _instance: TeamStore | null = null;
export function useTeamApi(): TeamApi {
  if (!_instance) _instance = new TeamStore(buildApi());
  return _instance.api;
}

// ---------------- roster ----------------
export function useRoster() {
  const api = useTeamApi();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  // 连接态（states.md §DisconnectedState）：mock 层默认 true，
  // StatusBar 上有演示开关可模拟断连/恢复。
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let alive = true;
    const unsub = api.subscribe(() => {
      api.listAgents().then((a) => alive && setAgents(a));
    });
    api.listAgents().then((a) => {
      if (!alive) return;
      setAgents(a);
      setLoading(false);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [api]);

  const restart = useCallback(
    async (agentId: string) => api.restartAgent(agentId),
    [api],
  );
  const spawn = useCallback(async (req: SpawnRequest) => api.spawnAgent(req), [api]);
  const requestShutdown = useCallback(
    async (agentId: string, force: boolean): Promise<ShutdownResult> =>
      api.requestShutdown(agentId, force),
    [api],
  );
  const cancelShutdown = useCallback(
    async (agentId: string) => api.cancelShutdown(agentId),
    [api],
  );
  const reconnect = useCallback(async () => {
    await api.reconnect();
    setConnected(true);
  }, [api]);
  /** 演示用：模拟断连 */
  const simulateDisconnect = useCallback(() => setConnected(false), []);

  const stats = useMemo(() => {
    const s = { total: agents.length, working: 0, idle: 0, failed: 0, offline: 0, spawning: 0, shutting_down: 0 };
    agents.forEach((a) => {
      if (a.status === "working") s.working++;
      else if (a.status === "idle") s.idle++;
      else if (a.status === "failed") s.failed++;
      else if (a.status === "offline") s.offline++;
      else if (a.status === "spawning") s.spawning++;
      else s.shutting_down++;
    });
    return s;
  }, [agents]);

  return { agents, loading, stats, connected, restart, spawn, requestShutdown, cancelShutdown, reconnect, simulateDisconnect, statusText };
}

// ---------------- tasks ----------------
export function useTasks() {
  const api = useTeamApi();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const unsub = api.subscribe(() => {
      api.listTasks().then((t) => alive && setTasks(t));
    });
    api.listTasks().then((t) => {
      if (!alive) return;
      setTasks(t);
      setLoading(false);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [api]);

  const updateStatus = useCallback(
    async (taskId: string, status: TaskStatus) => api.updateTaskStatus(taskId, status),
    [api],
  );
  const createTask = useCallback(
    async (title: string, assigneeId?: string) => api.createTask(title, assigneeId),
    [api],
  );

  return { tasks, loading, updateStatus, createTask };
}

// ---------------- chat ----------------
export function useChat(agentId: string | undefined) {
  const api = useTeamApi();
  const [thread, setThread] = useState<ChatThread>({ messages: [], typing: false });

  useEffect(() => {
    if (!agentId) {
      setThread({ messages: [], typing: false });
      return;
    }
    let alive = true;
    const unsub = api.subscribe(() => {
      api.getThread(agentId).then((t) => alive && setThread(t));
    });
    api.getThread(agentId).then((t) => alive && setThread(t));
    return () => {
      alive = false;
      unsub();
    };
  }, [api, agentId]);

  const send = useCallback(
    async (to: string, text: string): Promise<Message> => api.sendMessage(to, text),
    [api],
  );

  return { messages: thread.messages, typing: thread.typing, send };
}

// ---------------- activity ----------------
export function useActivities() {
  const api = useTeamApi();
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const unsub = api.subscribe(() => {
      api.listActivities().then((a) => alive && setActivities(a));
    });
    api.listActivities().then((a) => {
      if (!alive) return;
      setActivities(a);
      setLoading(false);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [api]);

  return { activities, loading };
}

// ---------------- templates ----------------
export function useTemplates() {
  const api = useTeamApi();
  const [templates, setTemplates] = useState<SpawnTemplate[]>([]);
  useEffect(() => {
    api.listTemplates().then(setTemplates);
  }, [api]);
  return templates;
}

// ---------------- 全局键盘快捷键 ----------------
const HANDLED = new Set<HTMLInputElement | HTMLTextAreaElement>();
export function useGlobalShortcuts(handlers: {
  onSwitchView: (v: ViewId) => void;
  onCommandPalette: () => void;
  onSpawn: () => void;
  onNewTask: () => void;
  onToggleNav: () => void;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const el = e.target as HTMLElement;
      const typing = el?.tagName === "INPUT" || el?.tagName === "TEXTAREA";
      if (!mod) return;
      switch (e.key.toLowerCase()) {
        case "1": e.preventDefault(); ref.current.onSwitchView("roster"); break;
        case "2": e.preventDefault(); ref.current.onSwitchView("board"); break;
        case "3": e.preventDefault(); ref.current.onSwitchView("activity"); break;
        case "k": e.preventDefault(); ref.current.onCommandPalette(); break;
        case "b": e.preventDefault(); ref.current.onToggleNav(); break;
        case "n":
          if (e.shiftKey) { e.preventDefault(); ref.current.onSpawn(); }
          else if (!typing) { e.preventDefault(); ref.current.onNewTask(); }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
