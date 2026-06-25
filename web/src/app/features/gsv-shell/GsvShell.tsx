import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "../../components/ui/Icon";
import { IconMenu } from "../../components/ui/IconMenu";
import { ObjectCard } from "../../components/ui/ObjectCard";
import { StatusDot } from "../../components/ui/StatusDot";
import type { StatusTone } from "../../components/ui/StatusDot";
import { AppFramePage } from "../apps/components/AppFramePage";
import { ChatDock } from "../chat/components/ChatDock";
import type { ChatAgentData, ChatAgentSelection } from "../chat/domain";
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
import { DesktopTabStack } from "./navigation/DesktopTabStack";
import { ShellRail } from "./navigation/ShellRail";
import { ShellStatusBar } from "./navigation/ShellStatusBar";
import {
  shellSurfaceLabel,
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

const TARGET_CHAT_PROCESS_EVENT = "gsv:target-chat-process";

type TargetChatProcess = {
  conversationId: string | null;
  pid: string;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTargetChatProcess(value: unknown): TargetChatProcess | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const pid = asTrimmedString(record.pid) || asTrimmedString(record.processId);
  if (!pid) {
    return null;
  }
  const conversationId = asTrimmedString(record.conversationId);
  return {
    pid,
    conversationId: conversationId || null,
  };
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

  const [selectedChatPid, setSelectedChatPid] = useState<string | null>(null);
  const [selectedChatAgentId, setSelectedChatAgentId] = useState<string | null>(null);
  const [selectedChatConversationId, setSelectedChatConversationId] = useState<string | null>(null);
  const chatProcesses = useChatProcessList();
  const chatProcessList = chatProcesses.data ?? [];
  const activeChatProcess = selectedChatAgentId
    ? null
    : chatProcessList.find((process) => process.pid === selectedChatPid)
      ?? chatProcessList[0]
      ?? null;

  useEffect(() => {
    if (selectedChatPid && !chatProcesses.isLoading && !chatProcessList.some((process) => process.pid === selectedChatPid)) {
      setSelectedChatPid(null);
      setSelectedChatConversationId(null);
    }
  }, [chatProcessList, chatProcesses.isLoading, selectedChatPid]);

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
      setSelectedChatAgentId(null);
      setSelectedChatConversationId(null);
      return;
    }
    if (selection.agentId) {
      setSelectedChatPid(null);
      setSelectedChatAgentId(selection.agentId);
      setSelectedChatConversationId(null);
    }
  };
  const selectStartedChatProcess = (pid: string): void => {
    setSelectedChatPid(pid);
    setSelectedChatAgentId(null);
    setSelectedChatConversationId(null);
  };
  const openShellSurface = (surface: ShellSurfaceId): void => {
    shell.openSurface(surface);
  };
  const openSettingsRoute = (target: SettingsRouteTarget): void => {
    shell.openSettingsRoute(shellSettingsRouteForTarget(target));
  };
  const openAppById = (appId: string, title?: string): void => {
    shell.openAppRoute({
      appId,
      suffix: "/",
      search: "",
      hash: "",
    }, title);
  };
  const activeSettingsRoute: ShellSettingsRoute = shell.activeSurface === "settings"
    ? shell.activePageTab?.settingsRoute ?? { view: "overview" }
    : { view: "overview" };
  const activeLibraryRoute: ShellLibraryRoute = shell.activeSurface === "library"
    ? shell.activePageTab?.libraryRoute ?? { view: "index" }
    : { view: "index" };

  return (
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
              desktopObjects={desktopObjects}
              openTabs={shell.openTabs}
              collapsed={shell.railCollapsed}
              tabsExpanded={shell.tabsExpanded}
              onToggleCollapsed={shell.toggleRailCollapsed}
              onBackToDesktop={shell.desktopCollapsed ? shell.revealDesktop : shell.backToDesktop}
              onCloseTab={shell.closeTab}
              onOpenTab={shell.activateTab}
              onOpenTabsPicker={shell.openTabsPicker}
              onToggleTabsExpanded={shell.toggleTabsExpanded}
              onOpenControlMenu={shell.openControlMenu}
              onOpenSurface={openShellSurface}
            />
          ) : null}

          <section class="gsv-shell-canvas" aria-label={shellSurfaceLabel(shell.activeSurface)}>
            {shell.activeSurface !== "desktop" ? (
              <>
                {shell.showRail ? (
                  <button
                    type="button"
                    class="gsv-console-rail-handle"
                    title={shell.railCollapsed ? "Expand menu" : "Collapse menu"}
                    aria-label={shell.railCollapsed ? "Expand menu" : "Collapse menu"}
                    onClick={shell.toggleRailCollapsed}
                  />
                ) : null}
                <div class="gsv-shell-page-stack">
                  <div class="gsv-shell-page-content">
                    {shell.activeSurface === "app" && shell.activePageTab?.appRoute ? (
                      <AppFramePage
                        key={shell.activePageTab.key}
                        appRoute={shell.activePageTab.appRoute}
                        onBackToDesktop={shell.backToDesktop}
                        onOpenAppRoute={shell.openAppRoute}
                      />
                    ) : shell.activeSurface !== "app" ? (
                      <GsvConsole
                        activeSurface={shell.activeSurface}
                        onBackToDesktop={shell.backToDesktop}
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
                  onOpenObject={shell.openObject}
                />
                <DesktopTabStack
                  activeTabKey={shell.activeTabKey}
                  tabs={shell.openTabs}
                  onCloseTab={shell.closeTab}
                  onOpenTab={shell.activateTab}
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
                  ) : shell.pickerId === "tabs" ? (
                    shell.openTabs.length > 0 ? (
                      <div class="gsv-picker-grid">
                        {shell.openTabs.map((tab) => (
                          <ObjectCard
                            key={tab.key}
                            label={tab.title}
                            type={tab.type}
                            blurb={tab.key === shell.activeTabKey
                              ? "Currently open in the central panel."
                              : "Open page — click to bring it to the central panel."}
                            status={tab.key === shell.activeTabKey ? "live" : "online"}
                            icon={<Icon name={tab.icon} size={20} color="var(--accent-bright)" />}
                            width={238}
                            onClick={() => shell.activateTab(tab.key)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div class="gsv-picker-empty">NO OPEN TABS</div>
                    )
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
  );
}
