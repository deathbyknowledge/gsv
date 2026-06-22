import type { RefObject } from "preact";
import type { ProcHistoryMessage } from "@humansandmachines/gsv/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "../../components/ui/Icon";
import { IconMenu } from "../../components/ui/IconMenu";
import { ObjectCard } from "../../components/ui/ObjectCard";
import { StatusDot } from "../../components/ui/StatusDot";
import type { StatusTone } from "../../components/ui/StatusDot";
import { ChatDock } from "../chat/components/ChatDock";
import type { ChatDockMessage } from "../chat/components/ChatDock";
import type { ChatAgentData } from "../chat/domain";
import { useChatProcessHistory, useChatProcessList, useSendChatMessage } from "../chat/hooks";
import { useConsoleConfig, useConsoleOverview } from "../gsv-console/hooks/useConsoleData";
import {
  PresenceActivity,
  PresencePanel,
} from "../presence/Presence";
import type { PresenceController } from "../presence/presenceController";
import type { NotificationSurface } from "../notifications/types";
import {
  GsvConsole,
  type SettingsRouteRequestRoute,
  type SettingsRouteRequest,
  type SettingsRouteTarget,
} from "../gsv-console/components/GsvConsole";
import { LegacyPackageRuntimeAnchors } from "../legacy-package-runtime/LegacyPackageRuntimeAnchors";
import { GsvDesktop } from "./desktop/GsvDesktop";
import { ShellRail } from "./navigation/ShellRail";
import { ShellStatusBar } from "./navigation/ShellStatusBar";
import { shellSurfaceLabel, type ShellSettingsRoute, type ShellSurfaceId } from "./domain/shellModel";
import { buildShellChatAgent } from "./domain/chatAgentModel";
import { buildDesktopObjectsFromConsole } from "./domain/desktopObjects";
import { useGsvShellState } from "./hooks/useGsvShellState";
import "./styles/gsvShell.css";

type GsvShellProps = {
  windowsLayerRef: RefObject<HTMLElement>;
  presenceController: PresenceController;
  notificationOpenSurface: NotificationSurface | null;
  notificationUnreadCount: number;
  onNotificationsToggle: (surface: NotificationSurface, node: HTMLButtonElement) => void;
  desktopVisible: boolean;
  sessionUsername: string;
  mobileHomeDate: string;
  onLockSession: () => void;
  onOpenCommandPalette: () => void;
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

function formatChatMessageTime(timestamp: number | null): string {
  if (timestamp === null) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function chatDockRoleForHistoryRole(role: ProcHistoryMessage["role"]): ChatDockMessage["role"] {
  return role === "toolResult" ? "toolResult" : role;
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

function CollapsedDesktop() {
  return (
    <div class="gsv-collapsed-desktop" aria-hidden="true">
      <div class="gsv-space-grid" />
      <div class="gsv-space-stars" />
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

function toSettingsRouteRequestRoute(route: ShellSettingsRoute): SettingsRouteRequestRoute {
  return route;
}

export function GsvShell({
  windowsLayerRef,
  presenceController,
  notificationOpenSurface,
  notificationUnreadCount,
  onNotificationsToggle,
  desktopVisible,
  sessionUsername,
  mobileHomeDate,
  onLockSession,
  onOpenCommandPalette,
}: GsvShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const clock = useClock();
  const consoleOverview = useConsoleOverview({ includeConfig: false });
  const consoleConfig = useConsoleConfig();
  const desktopObjects = useMemo(
    () => buildDesktopObjectsFromConsole(consoleOverview.data),
    [consoleOverview.data],
  );
  const shell = useGsvShellState({ rootRef, desktopObjects });

  const [selectedChatPid, setSelectedChatPid] = useState<string | null>(null);
  const [settingsRouteRequest, setSettingsRouteRequest] = useState<SettingsRouteRequest | null>(null);
  const chatProcesses = useChatProcessList();
  const chatProcessList = chatProcesses.data ?? [];
  const activeChatProcess = chatProcessList.find((process) => process.pid === selectedChatPid)
    ?? chatProcessList[0]
    ?? null;

  useEffect(() => {
    if (selectedChatPid && !chatProcessList.some((process) => process.pid === selectedChatPid)) {
      setSelectedChatPid(null);
    }
  }, [chatProcessList, selectedChatPid]);

  const chatHistory = useChatProcessHistory({
    enabled: activeChatProcess !== null,
    args: activeChatProcess ? { pid: activeChatProcess.pid } : {},
  });
  const sendChatMessage = useSendChatMessage();
  const handleSendChatMessage = useCallback((message: string) => {
    sendChatMessage.mutate({
      message,
      ...(activeChatProcess ? { pid: activeChatProcess.pid } : {}),
      ...(chatHistory.data?.conversationId ? { conversationId: chatHistory.data.conversationId } : {}),
    });
  }, [activeChatProcess, chatHistory.data?.conversationId, sendChatMessage]);
  const chatMessages = (chatHistory.data?.messages ?? [])
    .filter((message) => message.text.trim().length > 0)
    .slice(-24)
    .map((message) => ({
      id: message.clientId,
      text: message.text,
      time: formatChatMessageTime(message.timestamp),
      role: chatDockRoleForHistoryRole(message.role),
    }));
  const chatStatus = statusForRunState(activeChatProcess?.runState);
  const chatStatusLabel = activeChatProcess?.runState.replaceAll("_", " ") ?? (
    chatProcesses.isLoading ? "loading" : "no process"
  );
  const chatContextLabel = chatHistory.data
    ? `${chatHistory.data.messageCount} messages`
    : chatHistory.isLoading
      ? "loading history"
      : "no history";
  const chatAgent = useMemo<ChatAgentData | null>(() => {
    return buildShellChatAgent({
      activeProcess: activeChatProcess,
      accounts: consoleOverview.data?.accounts ?? [],
      chatProcesses: chatProcessList,
      config: consoleConfig.config,
      consoleProcesses: consoleOverview.data?.processes ?? [],
      statusLabel: chatStatusLabel,
    });
  }, [activeChatProcess, chatProcessList, chatStatusLabel, consoleConfig.config, consoleOverview.data]);
  const requestSettingsRoute = (route: ShellSettingsRoute): void => {
    setSettingsRouteRequest((current) => ({
      id: (current?.id ?? 0) + 1,
      route: toSettingsRouteRequestRoute(route),
    }));
  };
  const openShellSurface = (surface: ShellSurfaceId): void => {
    shell.openSurface(surface);
  };
  const openSettingsRoute = (target: SettingsRouteTarget): void => {
    shell.openSettingsRoute(shellSettingsRouteForTarget(target));
  };

  useEffect(() => {
    if (shell.activeSurface !== "settings") {
      return;
    }
    requestSettingsRoute(shell.activePageTab?.settingsRoute ?? { view: "overview" });
  }, [shell.activeSurface, shell.activePageTab?.key, shell.activePageTab?.settingsRoute]);

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
              collapsed={shell.railCollapsed}
              openTabs={shell.openTabs}
              railMode={shell.railMode}
              onToggleCollapsed={shell.toggleRailCollapsed}
              onBackToDesktop={shell.desktopCollapsed ? shell.revealDesktop : shell.backToDesktop}
              onActivateTab={shell.activateTab}
              onCloseTab={shell.closeTab}
              onOpenPicker={shell.openPicker}
              onOpenControlMenu={shell.openControlMenu}
              onOpenSurface={openShellSurface}
              onOpenTabsPicker={shell.openTabsPicker}
            />
          ) : null}

          <section class="gsv-shell-canvas" aria-label={shellSurfaceLabel(shell.activeSurface)}>
            {shell.activeSurface !== "desktop" ? (
              <GsvConsole
                activeSurface={shell.activeSurface}
                onBackToDesktop={shell.backToDesktop}
                onOpenSurface={openShellSurface}
                settingsRouteRequest={settingsRouteRequest}
              />
            ) : shell.desktopCollapsed ? (
              <CollapsedDesktop />
            ) : (
              <GsvDesktop
                desktopObjects={desktopObjects}
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
                onOpenSurface={openShellSurface}
                onOpenObject={shell.openObject}
              />
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
                        <StatusDot tone={shell.pickerObject?.status ?? "online"} size={7} />
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
                  ) : shell.pickerCards.length > 0 ? (
                    <div class="gsv-picker-grid">
                      {shell.pickerCards.map((card) => (
                        <ObjectCard
                          key={card.key}
                          label={card.label}
                          type={card.type}
                          blurb={card.blurb}
                          status={card.status}
                          glyph={card.glyph}
                          icon={card.icon ? <Icon name={card.icon} size={20} color="var(--accent-bright)" /> : undefined}
                          width={238}
                          onClick={card.onClick}
                        />
                      ))}
                    </div>
                  ) : (
                    <div class="gsv-picker-empty">{shell.pickerEmptyLabel}</div>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        </main>

        <ChatDock
          open={shell.chatOpen}
          width={shell.resolvedChatWidth}
          dragging={shell.chatDragging}
          atMax={shell.resolvedChatWidth >= shell.maxChatWidth - 1}
          onResizeStart={shell.startChatDrag}
          onToggleOpen={() => shell.setChatOpen((value) => !value)}
          onToggleMax={shell.toggleChatMax}
          onOpenCrew={() => openSettingsRoute("crew")}
          onOpenModels={() => openSettingsRoute("models")}
          onOpenTasks={() => openSettingsRoute("tasks")}
          title={activeChatProcess?.title ?? "Chat"}
          status={chatStatus}
          statusLabel={chatStatusLabel}
          contextLabel={chatContextLabel}
          agent={chatAgent}
          userLabel={sessionUsername}
          sending={sendChatMessage.isPending}
          onSendMessage={handleSendChatMessage}
          onSelectAgent={setSelectedChatPid}
          messages={chatMessages}
        />
      </div>

      <ShellStatusBar
        context={shell.statusContext}
        clock={clock}
        sessionUsername={sessionUsername}
        mobileHomeDate={mobileHomeDate}
        presenceController={presenceController}
        notificationOpenSurface={notificationOpenSurface}
        notificationUnreadCount={notificationUnreadCount}
        onNotificationsToggle={onNotificationsToggle}
        onOpenCommandPalette={onOpenCommandPalette}
        onLockSession={onLockSession}
      />

      <PresenceActivity controller={presenceController} />
      <PresencePanel controller={presenceController} />
      <LegacyPackageRuntimeAnchors windowsLayerRef={windowsLayerRef} />
    </div>
  );
}
