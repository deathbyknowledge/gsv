import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { IconMenu } from "../../components/ui/IconMenu";
import { StatusDot } from "../../components/ui/StatusDot";
import type { StatusTone } from "../../components/ui/StatusDot";
import { AppFramePage } from "../apps/components/AppFramePage";
import { ChatDock, type StartedChatProcess } from "../chat/components/ChatDock";
import type { ChatAgentData, ChatAgentSelection, ChatProcessSummary } from "../chat/domain";
import {
  normalizeTargetChatProcess,
  TARGET_CHAT_PROCESS_EVENT,
} from "../chat/domain/targetChatProcess";
import { useChatProcessList } from "../chat/hooks";
import type {
  ConsoleOverviewCounts,
  ConsoleOverviewData,
  ConsoleResourceState,
} from "../gsv-console/domain/consoleModels";
import { useConsoleConfig, useConsoleOverview } from "../gsv-console/hooks/useConsoleData";
import type { NotificationSurface } from "../notifications/types";
import {
  GsvConsole,
  type SettingsRouteTarget,
} from "../gsv-console/components/GsvConsole";
import { GsvDesktop, type DesktopInventoryState } from "./desktop/GsvDesktop";
import { ShellRail } from "./navigation/ShellRail";
import { ShellStatusBar } from "./navigation/ShellStatusBar";
import { UnsavedGuardProvider, useUnsavedGuardController } from "./unsaved/unsavedGuard";
import {
  shellSurfaceLabel,
  type DesktopObjectId,
  type ShellLibraryRoute,
  type ShellSettingsRoute,
  type ShellSurfaceId,
} from "./domain/shellModel";
import { buildShellChatAgent } from "./domain/chatAgentModel";
import { buildDesktopObjectsFromConsole } from "./domain/desktopObjects";
import { useGsvShellState } from "./hooks/useGsvShellState";
import "./styles/gsvShell.css";

type GsvShellProps = {
  notificationOpenSurface: NotificationSurface | null;
  notificationUnreadCount: number;
  onNotificationsToggle: (surface: NotificationSurface, node: HTMLButtonElement) => void;
  desktopVisible: boolean;
  sessionUsername: string;
  mobileHomeDate: string;
  onLockSession: () => void;
};

function statusForRunState(runState?: string): StatusTone {
  if (runState === "running") {
    return "live";
  }
  if (runState === "queued" || runState === "awaiting_hil") {
    return "update";
  }
  return "idle";
}

function useClock(): string {
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString("en-GB"));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(new Date().toLocaleTimeString("en-GB"));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return clock;
}

function desktopInventoryState(resource: ConsoleResourceState<ConsoleOverviewData>): DesktopInventoryState {
  if (resource.data) {
    return "ready";
  }
  if (resource.isError) {
    return "error";
  }
  if (resource.isUnavailable) {
    return "offline";
  }
  return "loading";
}

function desktopInventoryMessage(
  resource: ConsoleResourceState<ConsoleOverviewData>,
  objects: readonly { children: readonly unknown[] }[],
): string {
  if (resource.data) {
    const totalObjects = objects.reduce((sum, object) => sum + object.children.length, 0);
    return totalObjects === 0 ? "inventory empty" : "desktop ready";
  }
  if (resource.isError) {
    return resource.errorText || "inventory unavailable";
  }
  if (resource.isUnavailable) {
    return "gateway offline";
  }
  return "loading live inventory";
}

function systemLoadLabel(
  counts: ConsoleOverviewCounts | null,
  resource: ConsoleResourceState<ConsoleOverviewData>,
): string {
  if (resource.isError) {
    return "ERROR";
  }
  if (resource.isUnavailable) {
    return "OFFLINE";
  }
  if (resource.isLoading) {
    return "SYNCING";
  }
  if (!counts) {
    return "SYNC";
  }

  const active = counts.activeProcesses + counts.queuedProcesses;
  if (active > 0) {
    return active === 1 ? "1 RUN" : `${active} RUNS`;
  }
  if (counts.targets > 0) {
    return `${counts.onlineTargets}/${counts.targets} ${counts.targets === 1 ? "TARGET" : "TARGETS"}`;
  }
  if (counts.connectedAdapterAccounts > 0) {
    return counts.connectedAdapterAccounts === 1 ? "1 CHANNEL" : `${counts.connectedAdapterAccounts} CHANNELS`;
  }
  return "IDLE";
}

function CollapsedDesktop() {
  return (
    <div class="gsv-collapsed-desktop" aria-hidden="true">
      <div class="gsv-space-grid" />
      <div class="gsv-space-stars" />
      <div class="gsv-collapsed-glyphs">
        <span>✦</span>
        <span>◦</span>
        <span>*</span>
        <span>·</span>
        <span>⋆</span>
        <span>*</span>
        <span>✦</span>
        <span>·</span>
        <span>✧</span>
        <span>◦</span>
      </div>
    </div>
  );
}

function shellSettingsRouteForTarget(target: SettingsRouteTarget): ShellSettingsRoute {
  if (target === "overview") {
    return { view: "overview" };
  }
  if (target === "crew") {
    return { view: "crew" };
  }
  if (target === "tasks") {
    return { view: "list", kind: "tasks" };
  }
  return { view: "config", kind: target };
}

export function GsvShell({
  notificationOpenSurface,
  notificationUnreadCount,
  onNotificationsToggle,
  desktopVisible,
  sessionUsername,
  mobileHomeDate,
  onLockSession,
}: GsvShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const clock = useClock();
  const consoleOverview = useConsoleOverview({ includeConfig: false });
  const consoleConfig = useConsoleConfig();
  const statusSystemLabel = useMemo(
    () => systemLoadLabel(consoleOverview.counts, consoleOverview.resource),
    [consoleOverview.counts, consoleOverview.resource],
  );
  const desktopObjects = useMemo(
    () => buildDesktopObjectsFromConsole(consoleOverview.data),
    [consoleOverview.data],
  );
  const inventoryState = desktopInventoryState(consoleOverview.resource);
  const inventoryMessage = desktopInventoryMessage(consoleOverview.resource, desktopObjects);
  const shell = useGsvShellState({ rootRef, desktopObjects });
  const guard = useUnsavedGuardController();

  const [selectedChatPid, setSelectedChatPid] = useState<string | null>(null);
  const [selectedChatAgentId, setSelectedChatAgentId] = useState<string | null>(null);
  const [selectedChatConversationId, setSelectedChatConversationId] = useState<string | null>(null);
  const [pendingChatProcess, setPendingChatProcess] = useState<ChatProcessSummary | null>(null);
  const chatProcesses = useChatProcessList();
  const chatProcessList = chatProcesses.data ?? [];
  const selectedListedChatProcess = selectedChatPid
    ? chatProcessList.find((process) => process.pid === selectedChatPid) ?? null
    : null;
  const selectedPendingChatProcess = pendingChatProcess?.pid === selectedChatPid
    ? pendingChatProcess
    : null;
  const activeChatProcess = selectedChatAgentId
    ? null
    : selectedChatPid
      ? selectedListedChatProcess ?? selectedPendingChatProcess
      : chatProcessList[0] ?? null;

  useEffect(() => {
    if (pendingChatProcess && chatProcessList.some((process) => process.pid === pendingChatProcess.pid)) {
      setPendingChatProcess(null);
    }
  }, [chatProcessList, pendingChatProcess]);

  useEffect(() => {
    if (
      selectedChatPid &&
      !selectedPendingChatProcess &&
      !chatProcesses.isLoading &&
      !chatProcesses.isFetching &&
      !chatProcessList.some((process) => process.pid === selectedChatPid)
    ) {
      setSelectedChatPid(null);
      setSelectedChatConversationId(null);
    }
  }, [chatProcessList, chatProcesses.isFetching, chatProcesses.isLoading, selectedChatPid, selectedPendingChatProcess]);

  useEffect(() => {
    if (!selectedChatAgentId || !consoleOverview.data) {
      return;
    }
    const hasSelectedAgent = consoleOverview.data.accounts.some((account) => `account:${account.uid}` === selectedChatAgentId);
    if (!hasSelectedAgent) {
      setSelectedChatAgentId(null);
    }
  }, [consoleOverview.data, selectedChatAgentId]);

  useEffect(() => {
    const handleTargetEvent = (event: Event) => {
      const target = normalizeTargetChatProcess((event as CustomEvent).detail);
      if (!target) {
        return;
      }
      setSelectedChatPid(target.pid);
      setPendingChatProcess(null);
      setSelectedChatAgentId(null);
      setSelectedChatConversationId(target.conversationId);
      shell.setChatOpen(true);
    };

    window.addEventListener(TARGET_CHAT_PROCESS_EVENT, handleTargetEvent);
    return () => {
      window.removeEventListener(TARGET_CHAT_PROCESS_EVENT, handleTargetEvent);
    };
  }, [shell]);

  const chatStatus = statusForRunState(activeChatProcess?.runState);
  const chatStatusLabel = activeChatProcess?.runState.replaceAll("_", " ") ?? (
    chatProcesses.isLoading ? "loading" : "no process"
  );
  const chatContextLabel = activeChatProcess?.activeConversationId
    ? `conversation ${activeChatProcess.activeConversationId.slice(0, 8)}`
    : activeChatProcess
      ? "default conversation"
      : "no history";
  const chatAgent = useMemo<ChatAgentData | null>(() => {
    return buildShellChatAgent({
      activeProcess: activeChatProcess,
      accounts: consoleOverview.data?.accounts ?? [],
      chatProcesses: chatProcessList,
      config: consoleConfig.config,
      consoleProcesses: consoleOverview.data?.processes ?? [],
      selectedAgentId: selectedChatAgentId,
      sessionUsername,
      statusLabel: chatStatusLabel,
    });
  }, [activeChatProcess, chatProcessList, chatStatusLabel, consoleConfig.config, consoleOverview.data, selectedChatAgentId, sessionUsername]);
  const selectChatAgent = (selection: ChatAgentSelection): void => {
    if (selection.processId) {
      setSelectedChatPid(selection.processId);
      setPendingChatProcess(null);
      setSelectedChatAgentId(null);
      setSelectedChatConversationId(null);
      return;
    }
    if (selection.agentId) {
      setSelectedChatPid(null);
      setPendingChatProcess(null);
      setSelectedChatAgentId(selection.agentId);
      setSelectedChatConversationId(null);
    }
  };
  const selectStartedChatProcess = (process: StartedChatProcess): void => {
    const now = Date.now();
    const selectedAgentUid = selectedChatAgentId?.startsWith("account:")
      ? Number(selectedChatAgentId.slice("account:".length))
      : NaN;
    setPendingChatProcess({
      pid: process.pid,
      uid: Number.isFinite(selectedAgentUid) ? selectedAgentUid : (activeChatProcess?.uid ?? 0),
      username: chatAgent?.runAs || activeChatProcess?.username || sessionUsername,
      interactive: true,
      parentPid: null,
      state: "idle",
      runState: "idle",
      activeRunId: null,
      activeConversationId: null,
      queuedCount: 0,
      lastActiveAt: now,
      label: process.label ?? null,
      title: process.label?.trim() || chatAgent?.name || "New task",
      createdAt: now,
      cwd: process.cwd || activeChatProcess?.cwd || "",
      isDefaultConversation: false,
    });
    setSelectedChatPid(process.pid);
    setSelectedChatAgentId(null);
    setSelectedChatConversationId(null);
  };
  // Navigation that unmounts the active screen is routed through the unsaved
  // guard: a dirty screen prompts "discard changes?" first, a clean one passes
  // straight through.
  const openShellSurface = (surface: ShellSurfaceId): void => {
    guard.requestLeave(() => shell.openSurface(surface));
  };
  const guardedBackToDesktop = (): void => {
    guard.requestLeave(shell.backToDesktop);
  };
  const guardedRevealDesktop = (): void => {
    guard.requestLeave(shell.revealDesktop);
  };
  const closeActiveScreen = (): void => {
    guard.requestLeave(shell.closeActiveScreen);
  };
  const guardedOpenObject = (child: Parameters<typeof shell.openObject>[0]): void => {
    guard.requestLeave(() => shell.openObject(child));
  };
  const createSectionObject = (section: DesktopObjectId): void => {
    guard.requestLeave(() => shell.openSettingsRoute({ view: "list", kind: section, createNew: true }));
  };
  const openSettingsRoute = (target: SettingsRouteTarget): void => {
    guard.requestLeave(() => shell.openSettingsRoute(shellSettingsRouteForTarget(target)));
  };
  const openAppById = (appId: string, title?: string): void => {
    guard.requestLeave(() => shell.openAppRoute({
      appId,
      suffix: "/",
      search: "",
      hash: "",
    }, title));
  };
  const activeSettingsRoute: ShellSettingsRoute = shell.activeSurface === "settings"
    ? shell.activePageTab?.settingsRoute ?? { view: "overview" }
    : { view: "overview" };
  // Section whose create flow is active — keeps that section's rail drawer open
  // and its create entry selected (a create route carries no object detailId).
  const activeCreateSection: string | null =
    activeSettingsRoute.view === "list" && activeSettingsRoute.createNew === true
      ? activeSettingsRoute.kind
      : null;
  // Section + object a settings list/detail route points at, so the rail keeps
  // the owning drawer/subitem lit when reached via settings nav (direct URL,
  // BACK TO X, completing create) rather than openObject.
  const activeSettingsKind: string | null =
    activeSettingsRoute.view === "list" ? activeSettingsRoute.kind : null;
  const activeSettingsDetailId: string | null =
    activeSettingsRoute.view === "list" ? activeSettingsRoute.detailId ?? null : null;
  const activeLibraryRoute: ShellLibraryRoute = shell.activeSurface === "library"
    ? shell.activePageTab?.libraryRoute ?? { view: "index" }
    : { view: "index" };

  return (
    <UnsavedGuardProvider value={guard.contextValue}>
    <div
      class="gsv-shell-root"
      hidden={!desktopVisible}
      style={{ "--gsv-chat-width": `${shell.chatOpen ? shell.resolvedChatWidth : 0}px` }}
    >
      <div
        ref={rootRef}
        class={`gsv-shell-viewport${shell.chatOpen ? " has-chat" : ""}${shell.chatDragging ? " is-chat-dragging" : ""}`}
      >
        <main
          class={`gsv-shell-world${shell.activeSurface !== "desktop" ? " has-page" : ""}${shell.desktopCollapsed ? " is-desktop-collapsed" : ""}${shell.railCollapsed ? " is-rail-collapsed" : ""}`}
          style={{ "--gsv-rail-width": `${shell.showRail ? (shell.railCollapsed ? 64 : 262) : 0}px` }}
        >
          {shell.showRail ? (
            <ShellRail
              activeSurface={shell.activeSurface}
              activeTabKey={shell.activeTabKey}
              settingsView={activeSettingsRoute.view}
              createSection={activeCreateSection}
              settingsKind={activeSettingsKind}
              settingsDetailId={activeSettingsDetailId}
              desktopObjects={desktopObjects}
              collapsed={shell.railCollapsed}
              onToggleCollapsed={shell.toggleRailCollapsed}
              onBackToDesktop={shell.desktopCollapsed ? guardedRevealDesktop : guardedBackToDesktop}
              onOpenControlMenu={shell.openControlMenu}
              onOpenSurface={openShellSurface}
              onOpenObject={guardedOpenObject}
              onCreateObject={createSectionObject}
            />
          ) : null}

          <section class="gsv-shell-canvas" aria-label={shellSurfaceLabel(shell.activeSurface)}>
            {shell.activeSurface !== "desktop" ? (
              <>
                {shell.showRail ? (
                  <button
                    type="button"
                    class="gsv-console-rail-handle"
                    title={shell.railCollapsed ? "Expand menu (drag or click)" : "Collapse menu (drag or click)"}
                    aria-label={shell.railCollapsed ? "Expand menu" : "Collapse menu"}
                    onMouseDown={shell.startRailDrag}
                    onClick={shell.toggleRailCollapsed}
                  />
                ) : null}
                <div class="gsv-shell-page-stack">
                  <div class="gsv-shell-page-content">
                    {shell.activeSurface === "app" && shell.activePageTab?.appRoute ? (
                      <AppFramePage
                        key={shell.activePageTab.key}
                        appRoute={shell.activePageTab.appRoute}
                        onBackToDesktop={guardedBackToDesktop}
                        onClose={closeActiveScreen}
                        onOpenAppRoute={shell.openAppRoute}
                      />
                    ) : shell.activeSurface !== "app" ? (
                      <GsvConsole
                        activeSurface={shell.activeSurface}
                        onBackToDesktop={guardedBackToDesktop}
                        onClose={closeActiveScreen}
                        onOpenApp={openAppById}
                        onOpenSurface={openShellSurface}
                        onLibraryRouteChange={shell.syncActiveLibraryRoute}
                        onSettingsRouteChange={shell.syncActiveSettingsRoute}
                        libraryRoute={activeLibraryRoute}
                        settingsRoute={activeSettingsRoute}
                      />
                    ) : null}
                  </div>
                </div>
              </>
            ) : shell.desktopCollapsed ? (
              <CollapsedDesktop />
            ) : (
              <>
                <GsvDesktop
                  desktopObjects={desktopObjects}
                  inventoryMessage={inventoryMessage}
                  inventoryState={inventoryState}
                  selectedObjectId={shell.selectedObjectId}
                  gsvOpen={shell.gsvOpen}
                  onSelectObject={(id) => {
                    shell.setSelectedObjectId(id);
                    shell.setGsvOpen(false);
                  }}
                  onToggleGsv={() => {
                    shell.setGsvOpen((value) => !value);
                    shell.setSelectedObjectId(null);
                  }}
                  onCreateObject={(id) => {
                    shell.openSettingsRoute({ view: "list", kind: id, createNew: true });
                  }}
                  onOpenSurface={openShellSurface}
                  onOpenObject={guardedOpenObject}
                />
              </>
            )}

            {shell.pickerId ? (
              <div
                class={`gsv-picker-overlay${shell.pickerId === "gsv" ? " is-control-picker" : ""}`}
                role="dialog"
                aria-modal="true"
                aria-label={shell.pickerTitle}
                onClick={() => shell.setPickerId(null)}
              >
                <div class="gsv-picker-panel" onClick={(event) => event.stopPropagation()}>
                  <header>
                    <div>
                      <span>{shell.pickerTitle}</span>
                      <small>
                        <StatusDot tone="online" size={7} />
                        {shell.pickerSubtitle}
                      </small>
                    </div>
                    <button type="button" onClick={() => shell.setPickerId(null)} aria-label="Close picker">
                      x
                    </button>
                  </header>
                  {shell.pickerId === "gsv" ? (
                    <div class="gsv-picker-control">
                      <IconMenu
                        title="GSV // CONTROL"
                        width={386}
                        onClose={() => shell.setPickerId(null)}
                        onFiles={() => openShellSurface("files")}
                        onLibrary={() => openShellSurface("library")}
                        onTerminal={() => openShellSurface("terminal")}
                        onSettings={() => openShellSurface("settings")}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        </main>

        <ChatDock
          open={shell.chatOpen}
          width={shell.resolvedChatWidth}
          activeConversationId={selectedChatConversationId ?? activeChatProcess?.activeConversationId ?? null}
          dragging={shell.chatDragging}
          atMax={shell.resolvedChatWidth >= shell.maxChatWidth - 1}
          onResizeStart={shell.startChatDrag}
          onToggleOpen={() => shell.setChatOpen((value) => !value)}
          onToggleMax={shell.toggleChatMax}
          onOpenCrew={() => openSettingsRoute("crew")}
          onOpenModels={() => openSettingsRoute("models")}
          onOpenTasks={() => openSettingsRoute("tasks")}
          onProcessStarted={selectStartedChatProcess}
          onSelectConversation={setSelectedChatConversationId}
          title={activeChatProcess?.title ?? "Chat"}
          status={chatStatus}
          statusLabel={chatStatusLabel}
          contextLabel={chatContextLabel}
          agent={chatAgent}
          userLabel={sessionUsername}
          onSelectAgent={selectChatAgent}
        />
      </div>

      <ShellStatusBar
        context={shell.statusContext}
        clock={clock}
        systemLoadLabel={statusSystemLabel}
        sessionUsername={sessionUsername}
        mobileHomeDate={mobileHomeDate}
        notificationOpenSurface={notificationOpenSurface}
        notificationUnreadCount={notificationUnreadCount}
        onNotificationsToggle={onNotificationsToggle}
        onLockSession={onLockSession}
      />
    </div>
    {guard.guardModal}
    </UnsavedGuardProvider>
  );
}
