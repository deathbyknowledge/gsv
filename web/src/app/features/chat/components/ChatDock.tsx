import { useMemo, useState } from "preact/hooks";
import { Avatar } from "../../../components/ui/Avatar";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import { MessageInput } from "../../../components/ui/MessageInput";
import { StatusDot } from "../../../components/ui/StatusDot";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { JSX } from "preact";
import { buildChatAgentViewModel, type ChatAgentData } from "../domain/agent";
import type { ChatHistoryMessage, ChatRunState } from "../domain/processes";
import {
  useAbortChatProcess,
  useChatProcessHistory,
  useChatProcessList,
  useSpawnChatProcess,
} from "../hooks";
import { ActiveAgentPanel } from "./ActiveAgentPanel";
import { ChatTranscript, type ChatDockMessage } from "./ChatTranscript";
import "./ChatDock.css";

export type { ChatDockMessage } from "./ChatTranscript";

type ChatDockProps = {
  open: boolean;
  width: number;
  dragging?: boolean;
  atMax?: boolean;
  messages: readonly ChatDockMessage[];
  title?: string;
  status?: StatusTone;
  statusLabel?: string;
  contextLabel?: string;
  agent?: ChatAgentData | null;
  userLabel?: string;
  sending?: boolean;
  onResizeStart: (event: JSX.TargetedMouseEvent<HTMLDivElement>) => void;
  onToggleOpen: () => void;
  onToggleMax: () => void;
  onOpenCrew: () => void;
  onSendMessage?: (message: string) => void;
  onSelectAgent?: (agentId: string) => void;
};

const TRANSCRIPT_MESSAGE_LIMIT = 24;

function formatChatMessageTime(timestamp: number | null): string {
  if (timestamp === null) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function shortId(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : "";
}

function historyRoleToDockRole(role: ChatHistoryMessage["role"]): ChatDockMessage["role"] {
  return role === "toolResult" ? "toolResult" : role;
}

function contentToolName(content: unknown): string {
  if (!content || typeof content !== "object" || !("toolName" in content)) {
    return "";
  }
  const toolName = (content as { toolName?: unknown }).toolName;
  return typeof toolName === "string" ? toolName.trim() : "";
}

function messageMeta(message: ChatHistoryMessage): string | undefined {
  const details = [
    message.role === "toolResult" ? contentToolName(message.content) : "",
    message.runId ? `run ${shortId(message.runId)}` : "",
  ].filter(Boolean);
  return details.length > 0 ? details.join(" · ") : undefined;
}

function historyMessageToDockMessage(message: ChatHistoryMessage): ChatDockMessage {
  return {
    id: message.clientId,
    text: message.text,
    time: formatChatMessageTime(message.timestamp),
    role: historyRoleToDockRole(message.role),
    meta: messageMeta(message),
  };
}

function formatRunStateLabel(runState: ChatRunState | string | undefined): string {
  return runState ? runState.replaceAll("_", " ") : "idle";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

function contextPressurePercent(pressure: number | null | undefined): number | null {
  if (typeof pressure !== "number" || !Number.isFinite(pressure)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(pressure * 100)));
}

function runIdFromTaskName(name: string | undefined): string | null {
  const match = name?.match(/^Run\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function ChatDock({
  open,
  width,
  dragging = false,
  atMax = false,
  messages,
  title = "Chat",
  status = "idle",
  statusLabel = "no process",
  contextLabel = "no history",
  agent,
  userLabel,
  sending = false,
  onResizeStart,
  onToggleOpen,
  onToggleMax,
  onOpenCrew,
  onSendMessage,
  onSelectAgent,
}: ChatDockProps) {
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const activeProcessId = agent?.id?.trim() ?? "";
  const hasActiveProcess = activeProcessId.length > 0;
  const processList = useChatProcessList({ enabled: open });
  const processHistory = useChatProcessHistory({
    enabled: open && hasActiveProcess,
    args: hasActiveProcess ? { pid: activeProcessId } : {},
  });
  const spawnProcess = useSpawnChatProcess();
  const abortProcess = useAbortChatProcess();
  const activeAgent = useMemo(() => buildChatAgentViewModel({
    agent,
    title,
    status,
    statusLabel,
    contextLabel,
  }), [agent, title, status, statusLabel, contextLabel]);
  const transcriptMessages = useMemo(() => {
    if (!processHistory.data) {
      return messages;
    }
    return processHistory.data.messages
      .filter((message) => message.text.trim().length > 0)
      .slice(-TRANSCRIPT_MESSAGE_LIMIT)
      .map(historyMessageToDockMessage);
  }, [messages, processHistory.data]);
  const pendingHil = processHistory.data?.pendingHil ?? null;
  const runState = processHistory.data?.runState ?? (statusLabel === "loading" ? undefined : statusLabel);
  const runStateLabel = formatRunStateLabel(runState);
  const activeRunId = processHistory.data?.activeRunId ?? runIdFromTaskName(activeAgent.tasks[0]?.name);
  const canAbortRun = hasActiveProcess
    && !abortProcess.isPending
    && (Boolean(processHistory.data?.activeRunId) || Boolean(pendingHil) || runState === "running" || runState === "awaiting_hil");
  const context = processHistory.data?.context ?? null;
  const contextPercent = contextPressurePercent(context?.pressure);
  const hasVisibleMessages = transcriptMessages.length > 0;
  const hasTranscriptError = (processHistory.isError && !hasVisibleMessages)
    || (!hasActiveProcess && processList.isError);
  const transcriptState = hasTranscriptError
    ? "error"
    : ((processHistory.isLoading || (!hasActiveProcess && processList.isLoading)) && !hasVisibleMessages)
      ? "loading"
      : "ready";
  const transcriptError = processHistory.isError
    ? errorMessage(processHistory.error, "Process history could not be loaded.")
    : errorMessage(processList.error, "Process list could not be loaded.");
  const controlError = spawnProcess.isError
    ? errorMessage(spawnProcess.error, "Process could not be started.")
    : abortProcess.isError
      ? errorMessage(abortProcess.error, "Run could not be aborted.")
      : "";
  const emptyTitle = hasActiveProcess ? "No visible process messages" : "No process attached";
  const emptyDescription = hasActiveProcess
    ? "This process has not written user, assistant, system, or tool result messages yet."
    : "Start an interactive process to begin a native chat session.";
  const inputDisabled = sending || (!hasActiveProcess && !processList.isLoading);

  const startProcess = () => {
    spawnProcess.mutate({ interactive: true });
  };

  const abortActiveRun = () => {
    if (!hasActiveProcess) {
      return;
    }
    abortProcess.mutate({ pid: activeProcessId });
  };

  const openAgentPanel = () => {
    setAgentPanelOpen(true);
  };

  const closeAgentPanel = () => {
    setAgentPanelOpen(false);
  };

  if (!open) {
    return (
      <button type="button" class="gsv-chat-min" onClick={onToggleOpen}>
        <span class="gsv-chat-avatar">
          <Avatar src={activeAgent.imageSrc} status={activeAgent.status} size={40} />
        </span>
        <span>
          <strong>{activeAgent.name}</strong>
          <small>
            {activeAgent.activity}
            <i />
          </small>
        </span>
        <Icon name="chat" size={18} />
      </button>
    );
  }

  return (
    <aside
      class={`gsv-chat${dragging ? " is-dragging" : ""}`}
      aria-label="Chat"
      style={{ width: `${width}px` }}
    >
      <div class="gsv-chat-resize" onMouseDown={onResizeStart} title="Resize chat" />
      {agentPanelOpen ? (
        <ActiveAgentPanel
          agent={activeAgent}
          onClose={closeAgentPanel}
          onOpenCrew={onOpenCrew}
          onSelectAgent={onSelectAgent}
        />
      ) : null}
      <header class="gsv-chat-head">
        <button
          type="button"
          class="gsv-chat-agent"
          onClick={openAgentPanel}
          aria-haspopup="dialog"
          aria-expanded={agentPanelOpen}
        >
          <span class="gsv-chat-avatar">
            <Avatar src={activeAgent.imageSrc} status={activeAgent.status} size={42} />
          </span>
          <span>
            <strong>{activeAgent.name}</strong>
            <small>
              <StatusDot tone={status} size={7} />
              {activeAgent.activity}
            </small>
          </span>
          <svg class="gsv-chat-agent-chevron" width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
            <path d="M1 1 L6 5 L1 9" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>
        <div class="gsv-chat-actions">
          {!hasActiveProcess ? (
            <button
              type="button"
              class="gsv-chat-command gsv-chat-command-start"
              disabled={spawnProcess.isPending || processList.isLoading}
              onClick={startProcess}
              title="Start process"
              aria-label="Start process"
            >
              <Icon name="plus" size={15} />
            </button>
          ) : null}
          {canAbortRun ? (
            <button
              type="button"
              class="gsv-chat-command gsv-chat-command-abort"
              onClick={abortActiveRun}
              title="Abort current run"
              aria-label="Abort current run"
            >
              <span aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" onClick={onOpenCrew} aria-label="Open crew">
            <Icon name="chat" size={16} />
          </button>
          <IconButton glyph="max" size="medium" title={atMax ? "Restore chat" : "Expand chat"} onClick={onToggleMax} />
          <IconButton glyph="min" size="medium" title="Minimize chat" onClick={onToggleOpen} />
        </div>
      </header>

      <div class="gsv-chat-process">
        <div class="gsv-chat-process-main">
          <StatusDot tone={pendingHil ? "update" : status} size={7} />
          <span>{pendingHil ? "awaiting approval" : runStateLabel}</span>
        </div>
        <div class="gsv-chat-process-meta">
          {hasActiveProcess ? <span>pid {shortId(activeProcessId)}</span> : <span>no pid</span>}
          {activeRunId ? <span>run {shortId(activeRunId)}</span> : null}
          {processHistory.data?.messageCount !== undefined ? (
            <span>{processHistory.data.messageCount} messages</span>
          ) : null}
        </div>
      </div>

      {pendingHil ? (
        <section class="gsv-chat-hil" aria-label="Human approval pending">
          <div>
            <span>HIL PENDING</span>
            <strong>{pendingHil.toolName || pendingHil.syscall}</strong>
          </div>
          <small>
            {pendingHil.syscall}
            {" · request "}
            {shortId(pendingHil.requestId)}
          </small>
        </section>
      ) : null}

      {controlError ? (
        <div class="gsv-chat-control-error" role="status">
          {controlError}
        </div>
      ) : null}

      <ChatTranscript
        action={!hasActiveProcess ? (
          <button
            type="button"
            class="gsv-chat-empty-start"
            disabled={spawnProcess.isPending || processList.isLoading}
            onClick={startProcess}
          >
            <Icon name="plus" size={13} />
            <span>{spawnProcess.isPending ? "STARTING" : "START PROCESS"}</span>
          </button>
        ) : undefined}
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
        errorMessage={transcriptError}
        messages={transcriptMessages}
        state={transcriptState}
      />

      <div class="gsv-chat-context">
        <span>{contextLabel}</span>
        {contextPercent !== null ? (
          <span class="gsv-chat-context-meter" title={`${contextPercent}% context pressure`}>
            <i>
              <b style={{ width: `${contextPercent}%` }} />
            </i>
            <em>{contextPercent}%</em>
          </span>
        ) : null}
      </div>

      <MessageInput
        disabled={inputDisabled}
        placeholder={`Message ${activeAgent.name}...`}
        user={userLabel}
        onSend={onSendMessage}
      />
    </aside>
  );
}
