// ============================================================
// App — DFH Workstation 团队管理面板
// 布局：TitleBar / NavRail / (列表栏 + 详情栏) / StatusBar
// 视图：roster（团队成员+详情/对话）· board（Kanban+任务详情）· activity
// 模态：Spawn / Shutdown / NewTask / CommandPalette
// 全局：Toast 通知；断连态（内容区降透明度 + 内联条 + Composer 禁用）
// ============================================================

import { useCallback, useMemo, useRef, useState } from "react";
import type { Agent, ViewId } from "./types";
import { useGlobalShortcuts, useRoster, useTasks } from "./hooks/useTeamStore";
import { TitleBar } from "./components/shell/TitleBar";
import { NavRail } from "./components/shell/NavRail";
import { StatusBar } from "./components/shell/StatusBar";
import { RosterList } from "./components/roster/RosterList";
import { AgentDetail } from "./components/roster/AgentDetail";
import { ChatPane } from "./components/chat/ChatPane";
import { TaskBoard } from "./components/board/TaskBoard";
import { ActivityView } from "./components/activity/ActivityView";
import { SpawnModal } from "./components/modals/SpawnModal";
import { ShutdownModal } from "./components/modals/ShutdownModal";
import { NewTaskModal } from "./components/modals/NewTaskModal";
import { CommandPalette } from "./components/modals/CommandPalette";
import { ToastHost, pushToast } from "./components/common/Toast";
import { IconWarn } from "./lib/icons";

export default function App() {
  const [view, setView] = useState<ViewId>("roster");
  const [navOpen, setNavOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>("vis-1");
  const [pane, setPane] = useState<"detail" | "chat">("detail");
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [shutdownAgent, setShutdownAgent] = useState<Agent | null>(null);
  const shutdownIdRef = useRef<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [jumpTaskId, setJumpTaskId] = useState<string | undefined>();

  const {
    agents,
    stats,
    connected,
    restart,
    spawn,
    requestShutdown,
    cancelShutdown,
    reconnect,
    simulateDisconnect,
  } = useRoster();
  const { tasks, createTask } = useTasks();

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const selectedAgent = selectedAgentId ? agentMap.get(selectedAgentId) : undefined;

  // 关机：持有 agent 快照，避免成员从列表移除后模态丢失上下文
  const openShutdown = useCallback((a: Agent) => {
    shutdownIdRef.current = a.id;
    setShutdownAgent({ ...a });
  }, []);
  const closeShutdown = useCallback(() => {
    shutdownIdRef.current = null;
    setShutdownAgent(null);
  }, []);

  const taskCounts = useMemo(
    () => ({
      total: tasks.length,
      inProgress: tasks.filter((t) => t.status === "in_progress").length,
      blocked: tasks.filter((t) => (t.blockedBy?.length ?? 0) > 0).length,
    }),
    [tasks],
  );

  const switchView = useCallback((v: ViewId) => {
    setView(v);
    if (v === "board") setPane("detail");
  }, []);

  const handleJump = useCallback(
    (v: ViewId, ref?: { agentId?: string; taskId?: string }) => {
      switchView(v);
      if (ref?.agentId) {
        setSelectedAgentId(ref.agentId);
        setPane("detail");
      }
      if (ref?.taskId) {
        setJumpTaskId(ref.taskId);
      }
    },
    [switchView],
  );

  useGlobalShortcuts({
    onSwitchView: switchView,
    onCommandPalette: () => setCmdOpen(true),
    onSpawn: () => setSpawnOpen(true),
    onNewTask: () => setNewTaskOpen(true),
    onToggleNav: () => setNavOpen((v) => !v),
  });

  // spawn：乐观关模态（SpawnModal 已处理）；失败 → danger toast + [重试] 回填重开
  const handleSpawn = useCallback(
    async (templateId: string, name: string, initialTask?: string) => {
      try {
        const agent = await spawn({ templateId, name, initialTask });
        switchView("roster");
        if (agent?.id) {
          setSelectedAgentId(agent.id);
          setPane("detail");
        }
      } catch (err) {
        pushToast({
          kind: "danger",
          text: `上线失败：${err instanceof Error ? err.message : "未知错误"}`,
          action: { label: "重试", run: () => setSpawnOpen(true) },
        });
        throw err; // 让 SpawnModal 保留表单状态
      }
    },
    [spawn, switchView],
  );

  // 关机：提交即关模态；被拒绝 → danger toast + [查看对话]
  const handleShutdownConfirm = useCallback(
    (force: boolean) => {
      const target = shutdownAgent;
      if (!target) return;
      requestShutdown(target.id, force).then((r) => {
        if (!r.approved) {
          pushToast({
            kind: "danger",
            text: `${target.name} 拒绝了关机请求${r.reason ? `：${r.reason}` : ""}`,
            action: {
              label: "查看对话",
              run: () => {
                setSelectedAgentId(target.id);
                setPane("chat");
                switchView("roster");
              },
            },
          });
        }
      });
    },
    [shutdownAgent, requestShutdown, switchView],
  );

  const shutdownAgentObj = shutdownAgent && (agentMap.get(shutdownAgent.id) ?? shutdownAgent);
  const shutdownInProgress = shutdownAgent
    ? tasks.filter((t) => t.assigneeId === shutdownAgent.id && t.status === "in_progress").length
    : 0;

  return (
    <div className={`app ${navOpen ? "nav-open" : ""}`}>
      <TitleBar onCommandPalette={() => setCmdOpen(true)} />
      <NavRail
        view={view}
        expanded={navOpen}
        onToggle={() => setNavOpen((v) => !v)}
        onSwitchView={switchView}
        onSpawn={() => setSpawnOpen(true)}
        rosterCount={stats.total}
        activityUnread={0}
      />

      <main className="main">
        {!connected && (
          <div className="conn-banner" role="alert">
            <IconWarn size={12} /> 连接已断开，正在重连…
            <button className="conn-retry" onClick={reconnect}>
              立即重试
            </button>
          </div>
        )}
        <div className={`main-body ${connected ? "" : "main-offline"}`}>
          {view === "roster" && (
            <div className="two-pane">
              <section className="pane-list">
                <RosterList
                  agents={agents}
                  selectedId={selectedAgentId}
                  onSelect={(id) => {
                    setSelectedAgentId(id);
                    setPane("detail");
                  }}
                  onRestart={(id) => restart(id)}
                  onCancelShutdown={(id) => cancelShutdown(id)}
                />
              </section>
              <section className="pane-detail">
                {selectedAgent && pane === "detail" && (
                  <AgentDetail
                    agent={selectedAgent}
                    tasks={tasks}
                    onOpenChat={() => setPane("chat")}
                    onRequestShutdown={() => openShutdown(selectedAgent)}
                    onRestart={() => restart(selectedAgent.id)}
                    onCancelShutdown={() => cancelShutdown(selectedAgent.id)}
                    onAssignTask={(title) => {
                      createTask(title, selectedAgent.id);
                      pushToast({ kind: "success", text: `已创建任务并指派给 ${selectedAgent.name}` });
                    }}
                    onOpenTask={(taskId) => handleJump("board", { taskId })}
                  />
                )}
                {selectedAgent && pane === "chat" && (
                  <ChatPane
                    agent={selectedAgent}
                    agents={agents}
                    connected={connected}
                    onOpenChatAgent={(id) => {
                      setSelectedAgentId(id);
                      setPane("chat");
                    }}
                  />
                )}
                {!selectedAgent && <div className="detail-empty">从左侧选择一个成员</div>}
              </section>
            </div>
          )}

          {view === "board" && (
            <TaskBoard
              agents={agents}
              onNewTask={() => setNewTaskOpen(true)}
              autoSelectTaskId={jumpTaskId}
              key={jumpTaskId ?? "board"}
            />
          )}

          {view === "activity" && <ActivityView onJump={handleJump} />}
        </div>
      </main>

      <StatusBar
        connected={connected}
        stats={stats}
        taskCounts={taskCounts}
        onReconnect={() => reconnect()}
        onSimulateDisconnect={simulateDisconnect}
      />

      {/* 模态 */}
      <SpawnModal
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        existingNames={agents.map((a) => a.name)}
        onSpawn={handleSpawn}
      />
      <ShutdownModal
        agent={shutdownAgentObj ?? null}
        open={!!shutdownAgent && !!shutdownAgentObj}
        inProgressCount={shutdownInProgress}
        onClose={closeShutdown}
        onConfirm={handleShutdownConfirm}
      />
      <NewTaskModal
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        onCreate={async (title) => {
          await createTask(title);
          switchView("board");
        }}
      />
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        agents={agents}
        tasks={tasks}
        onSwitchView={switchView}
        onSpawn={() => setSpawnOpen(true)}
        onNewTask={() => setNewTaskOpen(true)}
        onSelectAgent={(id) => {
          if (id) {
            setSelectedAgentId(id);
            setPane("detail");
            switchView("roster");
          }
        }}
      />

      <ToastHost />
    </div>
  );
}
