import { useEffect, useMemo, useState } from "preact/hooks";
import { AgentImage } from "../../../components/ui/AgentImage";
import { Icon } from "../../../components/ui/Icon";
import { MessageInput } from "../../../components/ui/MessageInput";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { JSX } from "preact";
import { buildChatAgentViewModel, type ChatAgentData } from "../domain/agent";
import type { ChatHilDecision, ChatHistoryMessage, ChatRunState } from "../domain/processes";
import {
  useAbortChatProcess,
  useChatProcessHistory,
  useDecideChatHil,
  useSpawnChatProcess,
} from "../hooks";
import { ActiveAgentPanel } from "./ActiveAgentPanel";
import { ChatApprovalBanner } from "./ChatApprovalBanner";
import { ChatDockHeader } from "./ChatDockHeader";
import type { ChatPopoverId } from "./ChatDockPopovers";
import { ChatTranscript, type ChatDockMessage } from "./ChatTranscript";
import { shortId } from "./chatUiFormat";
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
  onOpenModels?: () => void;
  onOpenTasks?: () => void;
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

function contentToolCallId(content: unknown): string {
  if (!content || typeof content !== "object" || !("toolCallId" in content)) {
    return "";
  }
  const toolCallId = (content as { toolCallId?: unknown }).toolCallId;
  return typeof toolCallId === "string" ? toolCallId.trim() : "";
}

function contentToolIsError(content: unknown): boolean {
  return Boolean(
    content
      && typeof content === "object"
      && "isError" in content
      && (content as { isError?: unknown }).isError === true,
  );
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
    ...(message.runId ? { runId: message.runId } : {}),
    ...(message.role === "toolResult" ? {
      isError: contentToolIsError(message.content),
      toolCallId: contentToolCallId(message.content),
      toolName: contentToolName(message.content),
    } : {}),
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
  onOpenModels,
  onOpenTasks,
  onSendMessage,
  onSelectAgent,
}: ChatDockProps) {
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [openPopover, setOpenPopover] = useState<ChatPopoverId | null>(null);
  const activeProcessId = agent?.processId?.trim() ?? "";
  const startRunAs = agent?.runAs?.trim() ?? "";
  const hasActiveProcess = activeProcessId.length > 0;
  const processHistory = useChatProcessHistory({
    enabled: open && hasActiveProcess,
    args: hasActiveProcess ? { pid: activeProcessId } : {},
  });
  const spawnProcess = useSpawnChatProcess();
  const abortProcess = useAbortChatProcess();
  const hilDecision = useDecideChatHil();
  const pendingHil = processHistory.data?.pendingHil ?? null;
  const effectiveStatus = pendingHil ? "update" : status;
  const effectiveStatusLabel = pendingHil ? "awaiting approval" : statusLabel;

  useEffect(() => {
    if (!open) {
      setAgentPanelOpen(false);
      setOpenPopover(null);
    }
  }, [open]);

  useEffect(() => {
    if (agentPanelOpen) {
      setOpenPopover(null);
    }
  }, [agentPanelOpen]);

  const activeAgent = useMemo(() => buildChatAgentViewModel({
    agent,
    title,
    status: effectiveStatus,
    statusLabel: effectiveStatusLabel,
    contextLabel,
  }), [agent, title, effectiveStatus, effectiveStatusLabel, contextLabel]);
  const transcriptMessages = useMemo(() => {
    if (!processHistory.data) {
      return messages;
    }
    return processHistory.data.messages
      .filter((message) => message.text.trim().length > 0)
      .slice(-TRANSCRIPT_MESSAGE_LIMIT)
      .map(historyMessageToDockMessage);
  }, [messages, processHistory.data]);
  const runState = processHistory.data?.runState ?? (effectiveStatusLabel === "loading" ? undefined : effectiveStatusLabel);
  const runStateLabel = pendingHil ? "awaiting approval" : formatRunStateLabel(runState);
  const canAbortRun = hasActiveProcess
    && !abortProcess.isPending
    && (Boolean(processHistory.data?.activeRunId) || Boolean(pendingHil) || runState === "running" || runState === "awaiting_hil");
  const context = processHistory.data?.context ?? null;
  const contextPercent = contextPressurePercent(context?.pressure);
  const contextTitle = contextPercent === null
    ? contextLabel
    : `${contextPercent}% context pressure`;
  const hasVisibleMessages = transcriptMessages.length > 0;
  const processLookupLoading = !hasActiveProcess && effectiveStatusLabel === "loading";
  const hasTranscriptError = processHistory.isError && !hasVisibleMessages;
  const transcriptState = hasTranscriptError
    ? "error"
    : ((processHistory.isLoading || processLookupLoading) && !hasVisibleMessages)
      ? "loading"
      : "ready";
  const transcriptError = errorMessage(processHistory.error, "Process history could not be loaded.");
  const controlError = spawnProcess.isError
    ? errorMessage(spawnProcess.error, "Process could not be started.")
    : abortProcess.isError
      ? errorMessage(abortProcess.error, "Run could not be aborted.")
      : hilDecision.isError
        ? errorMessage(hilDecision.error, "Tool approval could not be applied.")
        : "";
  const emptyTitle = hasActiveProcess ? "No visible process messages" : "No process attached";
  const emptyDescription = hasActiveProcess
    ? "This process has not written user, assistant, system, or tool result messages yet."
    : "Start an interactive process to begin a native chat session.";
  const inputDisabled = sending || (!hasActiveProcess && !processLookupLoading);
  const taskCount = activeAgent.tasksTotal > 0 ? activeAgent.tasksTotal : activeAgent.tasks.length;
  const contextLevel = context?.level ? context.level.toUpperCase() : contextPercent === null ? "UNKNOWN" : "ESTIMATED";
  const contextModel = context ? [context.provider, context.model].filter(Boolean).join(" · ") : activeAgent.modelLabel;

  const startProcess = () => {
    spawnProcess.mutate({
      interactive: true,
      ...(startRunAs ? { runAs: startRunAs } : {}),
    });
  };

  const abortActiveRun = () => {
    if (!hasActiveProcess) {
      return;
    }
    abortProcess.mutate({ pid: activeProcessId });
  };

  const decidePendingHil = (decision: ChatHilDecision) => {
    if (!hasActiveProcess || !pendingHil || hilDecision.isPending) {
      return;
    }
    hilDecision.mutate({
      pid: activeProcessId,
      requestId: pendingHil.requestId,
      decision,
    });
  };

  const openAgentPanel = () => {
    setAgentPanelOpen(true);
  };

  const closeAgentPanel = () => {
    setAgentPanelOpen(false);
  };

  const togglePopover = (popover: ChatPopoverId) => {
    setOpenPopover((current) => current === popover ? null : popover);
  };

  if (!open) {
    return (
      <button type="button" class="gsv-chat-min" onClick={onToggleOpen}>
        <AgentImage src={activeAgent.imageSrc} size={40} />
        <span class="gsv-chat-min-copy">
          <strong>{activeAgent.name}</strong>
          <small>
            {activeAgent.activity}
            <i />
          </small>
        </span>
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
      {openPopover ? <button type="button" class="gsv-chat-popover-scrim" aria-label="Close chat menu" onClick={() => setOpenPopover(null)} /> : null}
      <ChatDockHeader
        activeAgent={activeAgent}
        agentPanelOpen={agentPanelOpen}
        atMax={atMax}
        canAbortRun={canAbortRun}
        context={context}
        contextLabel={contextLabel}
        contextLevel={contextLevel}
        contextModel={contextModel}
        contextPercent={contextPercent}
        contextTitle={contextTitle}
        effectiveStatus={effectiveStatus}
        hasActiveProcess={hasActiveProcess}
        messageCount={processHistory.data?.messageCount}
        openPopover={openPopover}
        runStateLabel={runStateLabel}
        spawnPending={spawnProcess.isPending}
        taskCount={taskCount}
        onAbortRun={abortActiveRun}
        onOpenAgentPanel={openAgentPanel}
        onOpenModels={() => {
          setOpenPopover(null);
          (onOpenModels ?? onOpenCrew)();
        }}
        onOpenTasks={() => {
          setOpenPopover(null);
          (onOpenTasks ?? onOpenCrew)();
        }}
        onStartProcess={startProcess}
        onToggleMax={onToggleMax}
        onToggleOpen={onToggleOpen}
        onTogglePopover={togglePopover}
      />

      {pendingHil ? (
        <ChatApprovalBanner
          busy={hilDecision.isPending}
          pendingHil={pendingHil}
          onDecision={decidePendingHil}
        />
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
            disabled={spawnProcess.isPending}
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

      <MessageInput
        disabled={inputDisabled}
        placeholder={`Message ${activeAgent.name}...`}
        user={userLabel}
        onSend={onSendMessage}
      />
    </aside>
  );
}
