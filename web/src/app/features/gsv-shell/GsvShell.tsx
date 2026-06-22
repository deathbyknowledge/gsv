import type { RefObject } from "preact";
import type { ProcHistoryMessage } from "@humansandmachines/gsv/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ObjectCard } from "../../components/ui/ObjectCard";
import type { StatusTone } from "../../components/ui/StatusDot";
import { ChatDock } from "../chat/components/ChatDock";
import type { ChatDockMessage } from "../chat/components/ChatDock";
import { useChatProcessHistory, useChatProcessList, useSendChatMessage } from "../chat/hooks";
import { useConsoleOverview } from "../gsv-console/hooks/useConsoleData";
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
import { shellSurfaceLabel } from "./domain/shellModel";
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
  const desktopObjects = useMemo(
    () => buildDesktopObjectsFromConsole(consoleOverview.data),
    [consoleOverview.data],
  );
  const shell = useGsvShellState({ rootRef, desktopObjects });

  const chatProcesses = useChatProcessList();
  const activeChatProcess = chatProcesses.data?.[0] ?? null;
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

  return (
    <div class="gsv-shell-root" hidden={!desktopVisible}>
      <div ref={rootRef} class={`gsv-shell-viewport${shell.chatOpen ? " has-chat" : ""}`}>
        <main
          class={`gsv-shell-world${shell.activeTab ? " has-page" : ""}${shell.desktopCollapsed ? " is-desktop-collapsed" : ""}`}
          style={{ "--gsv-rail-width": `${shell.showRail ? (shell.railCollapsed ? 64 : 262) : 0}px` }}
        >
          {shell.showRail ? (
            <ShellRail
              desktopObjects={desktopObjects}
              collapsed={shell.railCollapsed}
              railMode={shell.railMode}
              tabs={shell.tabs}
              activeTabKey={shell.activeTabKey}
              onToggleCollapsed={shell.toggleRailCollapsed}
              onSetRailMode={shell.setRailMode}
              onBackToDesktop={shell.backToDesktop}
              onOpenPicker={shell.openPicker}
              onOpenSurface={shell.openSurface}
              onActivateTab={shell.activateTab}
              onCloseTab={shell.closeTab}
            />
          ) : null}

          <section class="gsv-shell-canvas" aria-label={shellSurfaceLabel(shell.activeSurface)}>
            {shell.activeTab ? (
              <GsvConsole activeSurface={shell.activeTab.surface} onBackToDesktop={shell.backToDesktop} />
            ) : shell.desktopCollapsed ? (
              <div class="gsv-collapsed-desktop">
                <div>
                  <span>DESKTOP // GSV</span>
                  <strong>{shell.totalDesktopObjects} objects</strong>
                  <small>use the rail to select an object branch</small>
                </div>
              </div>
            ) : (
              <GsvDesktop
                desktopObjects={desktopObjects}
                selectedObjectId={shell.selectedObjectId}
                gsvOpen={shell.gsvOpen}
                tabCount={shell.tabs.length}
                onSelectObject={(id) => {
                  shell.setSelectedObjectId(id);
                  shell.setGsvOpen(false);
                }}
                onToggleGsv={() => {
                  shell.setGsvOpen((value) => !value);
                  shell.setSelectedObjectId(null);
                }}
                onOpenSurface={shell.openSurface}
                onActivateTabs={() => shell.setPickerId("tabs")}
              />
            )}

            {shell.pickerId ? (
              <div class="gsv-picker-overlay" onClick={() => shell.setPickerId(null)}>
                <div onClick={(event) => event.stopPropagation()}>
                  <header>
                    <span>{shell.pickerId === "tabs" ? "OPEN TABS" : `${shell.pickerObject?.label ?? "OBJECTS"} · SELECT AN OBJECT`}</span>
                    <button type="button" onClick={() => shell.setPickerId(null)} aria-label="Close picker">
                      x
                    </button>
                  </header>
                  <div>
                    {shell.pickerCards.map((card) => (
                      <ObjectCard
                        key={card.key}
                        label={card.label}
                        type={card.type}
                        blurb={card.blurb}
                        status={card.status}
                        width={238}
                        onClick={card.onClick}
                      />
                    ))}
                  </div>
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
          userLabel={sessionUsername}
          sending={sendChatMessage.isPending}
          onSendMessage={handleSendChatMessage}
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
