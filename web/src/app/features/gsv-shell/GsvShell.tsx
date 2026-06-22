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
import type { ChatAgentData, ChatAgentStatus, ChatAgentTaskStatus } from "../chat/domain";
import { useChatProcessHistory, useChatProcessList, useSendChatMessage } from "../chat/hooks";
import { defaultModelLabelForConfig } from "../gsv-console/domain/consoleAi";
import { useConsoleConfig, useConsoleOverview } from "../gsv-console/hooks/useConsoleData";
import {
  PresenceActivity,
  PresencePanel,
} from "../presence/Presence";
import type { PresenceController } from "../presence/presenceController";
import type { NotificationSurface } from "../notifications/types";
import { GsvConsole } from "../gsv-console/components/GsvConsole";
import { GsvDesktop } from "./desktop/GsvDesktop";
import { LegacyRuntimeAnchors } from "./legacy/LegacyRuntimeAnchors";
import { ShellRail } from "./navigation/ShellRail";
import { ShellStatusBar } from "./navigation/ShellStatusBar";
import { shellSurfaceLabel, type DesktopObject, type DesktopObjectId } from "./domain/shellModel";
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

function agentStatusForRunState(runState?: string): ChatAgentStatus {
  if (runState === "running") {
    return "live";
  }
  if (runState === "idle") {
    return "idle";
  }
  return "online";
}

function taskStatusForRunState(runState?: string): ChatAgentTaskStatus {
  return runState === "idle" ? "idle" : "running";
}

function processImageSrc(index: number): string {
  return `/img/agent-${index % 3}.png`;
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
  return role === "toolResult" ? "tool" : role;
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

type CollapsedDesktopProps = {
  desktopObjects: readonly DesktopObject[];
  totalDesktopObjects: number;
  onOpenPicker: (id: DesktopObjectId) => void;
  onOpenControlMenu: () => void;
};

function CollapsedDesktop({
  desktopObjects,
  totalDesktopObjects,
  onOpenPicker,
  onOpenControlMenu,
}: CollapsedDesktopProps) {
  return (
    <div class="gsv-collapsed-desktop">
      <div class="gsv-collapsed-desktop-panel">
        <header>
          <div>
            <span>DESKTOP // GSV</span>
            <strong>{totalDesktopObjects} objects</strong>
            <small>LIVE OBJECT MAP</small>
          </div>
          <button type="button" onClick={onOpenControlMenu}>GSV</button>
        </header>
        <div class="gsv-collapsed-desktop-branches">
          {desktopObjects.map((object) => (
            <button
              key={object.id}
              type="button"
              title={`${object.label}: ${object.meta}, ${object.statusLabel}`}
              onClick={() => onOpenPicker(object.id)}
            >
              <StatusDot tone={object.status} size={7} />
              <span>{object.label}</span>
              <small>{object.meta}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
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
  const chatModelLabel = useMemo(
    () => defaultModelLabelForConfig(consoleConfig.config),
    [consoleConfig.config],
  );
  const shell = useGsvShellState({ rootRef, desktopObjects });

  const [selectedChatPid, setSelectedChatPid] = useState<string | null>(null);
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
    if (!activeChatProcess) {
      return null;
    }

    const activeProcessIndex = Math.max(
      0,
      chatProcessList.findIndex((process) => process.pid === activeChatProcess.pid),
    );
    const activeTaskCount = (activeChatProcess.activeRunId ? 1 : 0) + activeChatProcess.queuedCount;

    return {
      id: activeChatProcess.pid,
      name: activeChatProcess.title,
      role: activeChatProcess.username ? `PROCESS · ${activeChatProcess.username}` : "PROCESS",
      description: [
        activeChatProcess.cwd,
        activeChatProcess.activeConversationId ? `conversation ${activeChatProcess.activeConversationId}` : "",
      ].filter(Boolean).join(" · "),
      imageSrc: processImageSrc(activeProcessIndex),
      status: agentStatusForRunState(activeChatProcess.runState),
      statusLabel: chatStatusLabel,
      activity: chatStatusLabel,
      modelLabel: chatModelLabel,
      tasksTotal: activeTaskCount,
      tasks: activeChatProcess.activeRunId
        ? [{ name: `Run ${activeChatProcess.activeRunId.slice(0, 8)}`, status: taskStatusForRunState(activeChatProcess.runState) }]
        : activeChatProcess.queuedCount > 0
          ? [{ name: `${activeChatProcess.queuedCount} queued`, status: "running" }]
          : [],
      crew: chatProcessList.map((process, index) => ({
        id: process.pid,
        name: process.title,
        role: process.username ? `PROCESS · ${process.username}` : "PROCESS",
        imageSrc: processImageSrc(index),
        status: agentStatusForRunState(process.runState),
        statusLabel: process.runState.replaceAll("_", " "),
        active: process.pid === activeChatProcess.pid,
      })),
    };
  }, [activeChatProcess, chatModelLabel, chatProcessList, chatStatusLabel]);

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
          class={`gsv-shell-world${shell.activeTab ? " has-page" : ""}${shell.desktopCollapsed ? " is-desktop-collapsed" : ""}${shell.railCollapsed ? " is-rail-collapsed" : ""} is-rail-mode-${shell.railMode}`}
          style={{ "--gsv-rail-width": `${shell.showRail ? (shell.railCollapsed ? 64 : 262) : 0}px` }}
        >
          {shell.showRail ? (
            <ShellRail
              desktopObjects={desktopObjects}
              collapsed={shell.railCollapsed}
              railMode={shell.railMode}
              activeTabKey={shell.activeTabKey}
              onToggleCollapsed={shell.toggleRailCollapsed}
              onSetRailMode={shell.setRailMode}
              onBackToDesktop={shell.backToDesktop}
              onOpenPicker={shell.openPicker}
              onOpenControlMenu={shell.openControlMenu}
              onOpenSurface={shell.openSurface}
            />
          ) : null}

          <section class="gsv-shell-canvas" aria-label={shellSurfaceLabel(shell.activeSurface)}>
            {shell.activeTab ? (
              <GsvConsole
                activeSurface={shell.activeTab.surface}
                onBackToDesktop={shell.backToDesktop}
                onOpenSurface={shell.openSurface}
              />
            ) : shell.desktopCollapsed ? (
              <CollapsedDesktop
                desktopObjects={desktopObjects}
                totalDesktopObjects={shell.totalDesktopObjects}
                onOpenPicker={shell.openPicker}
                onOpenControlMenu={shell.openControlMenu}
              />
            ) : (
              <GsvDesktop
                desktopObjects={desktopObjects}
                selectedObjectId={shell.selectedObjectId}
                gsvOpen={shell.gsvOpen}
                tabs={shell.tabs}
                activeTabKey={shell.activeTabKey}
                onSelectObject={(id) => {
                  shell.setSelectedObjectId(id);
                  shell.setGsvOpen(false);
                }}
                onToggleGsv={() => {
                  shell.setGsvOpen((value) => !value);
                  shell.setSelectedObjectId(null);
                }}
                onOpenSurface={shell.openSurface}
                onSelectTab={shell.activateTab}
                onCloseTab={shell.closeTab}
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
                        <StatusDot tone={shell.pickerObject?.status ?? (shell.pickerId === "tabs" ? "live" : "online")} size={7} />
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
                        onRuntime={() => shell.openSurface("runtime")}
                        onFiles={() => shell.openSurface("files")}
                        onLibrary={() => shell.openSurface("library")}
                        onTerminal={() => shell.openSurface("terminal")}
                        onSettings={() => shell.openSurface("settings")}
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
          onOpenCrew={() => shell.openSurface("crew")}
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
      <LegacyRuntimeAnchors windowsLayerRef={windowsLayerRef} />
    </div>
  );
}
