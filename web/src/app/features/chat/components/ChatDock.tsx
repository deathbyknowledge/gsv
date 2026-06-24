import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ProcMediaInput } from "@humansandmachines/gsv/protocol";
import { AgentImage } from "../../../components/ui/AgentImage";
import { Icon } from "../../../components/ui/Icon";
import { MessageInput, type MessageInputAttachment } from "../../../components/ui/MessageInput";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { JSX } from "preact";
import {
  buildChatAgentViewModel,
  type ChatAgentData,
  type ChatAgentSelection,
  type ChatModelProfileData,
} from "../domain/agent";
import {
  applyChatLiveActivityToAgent,
  deriveChatLiveActivity,
} from "../domain/activity";
import type { ChatHilDecision, ChatRunState } from "../domain/processes";
import {
  useAbortChatProcess,
  useCompactChatConversation,
  useChatConversations,
  useChatProcessAiConfig,
  useForkChatConversation,
  useDecideChatHil,
  useSendChatMessage,
  useSetChatProcessAiConfig,
  useSpawnChatProcess,
  useChatRuntime,
  useChatVoiceRecorder,
  type ChatVoiceAttachment,
} from "../hooks";
import { ActiveAgentPanel } from "./ActiveAgentPanel";
import { ChatApprovalBanner } from "./ChatApprovalBanner";
import { ChatArchivePanel } from "./ChatArchivePanel";
import { ChatConversationBar } from "./ChatConversationBar";
import { ChatDockHeader } from "./ChatDockHeader";
import type { ChatPopoverId } from "./ChatDockPopovers";
import { ChatTranscript, type ChatDockMessage } from "./ChatTranscript";
import { shortId } from "./chatUiFormat";
import "./ChatDock.css";

export type { ChatDockMessage } from "./ChatTranscript";

type ChatDockProps = {
  open: boolean;
  width: number;
  activeConversationId?: string | null;
  dragging?: boolean;
  atMax?: boolean;
  title?: string;
  status?: StatusTone;
  statusLabel?: string;
  contextLabel?: string;
  agent?: ChatAgentData | null;
  userLabel?: string;
  onResizeStart: (event: JSX.TargetedMouseEvent<HTMLDivElement>) => void;
  onToggleOpen: () => void;
  onToggleMax: () => void;
  onOpenCrew: () => void;
  onOpenModels?: () => void;
  onOpenTasks?: () => void;
  onProcessStarted?: (pid: string) => void;
  onSelectConversation?: (conversationId: string) => void;
  onSelectAgent?: (selection: ChatAgentSelection) => void;
};

const TRANSCRIPT_MESSAGE_LIMIT = 24;

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

type DraftAttachment = ProcMediaInput & MessageInputAttachment & {
  previewUrl?: string;
};

function revokeDraftAttachment(attachment: DraftAttachment): void {
  if (!attachment.previewUrl || typeof URL === "undefined") {
    return;
  }
  URL.revokeObjectURL(attachment.previewUrl);
}

function revokeDraftAttachments(attachments: readonly DraftAttachment[]): void {
  attachments.forEach(revokeDraftAttachment);
}

function formatAttachmentSize(size: number | undefined): string {
  if (!size || size <= 0) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function inferAttachmentType(file: File): ProcMediaInput["type"] {
  const mimeType = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (mimeType.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp)$/.test(name)) {
    return "image";
  }
  if (mimeType.startsWith("audio/") || /\.(mp3|wav|ogg|m4a)$/.test(name)) {
    return "audio";
  }
  if (mimeType.startsWith("video/") || /\.(mp4|mov|webm)$/.test(name)) {
    return "video";
  }
  return "document";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Attachment could not be read."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

async function fileToDraftAttachment(file: File): Promise<DraftAttachment> {
  const data = await readFileAsDataUrl(file);
  const mimeType = file.type || "application/octet-stream";
  const type = inferAttachmentType(file);
  const sizeLabel = formatAttachmentSize(file.size);
  const randomId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return {
    id: `${file.name}:${file.size}:${file.lastModified}:${randomId}`,
    type,
    mimeType,
    data,
    filename: file.name || undefined,
    size: file.size,
    label: file.name || "attachment",
    meta: [type, sizeLabel].filter(Boolean).join(" · "),
  };
}

export function ChatDock({
  open,
  width,
  activeConversationId = null,
  dragging = false,
  atMax = false,
  title = "Chat",
  status = "idle",
  statusLabel = "no process",
  contextLabel = "no history",
  agent,
  userLabel,
  onResizeStart,
  onToggleOpen,
  onToggleMax,
  onOpenCrew,
  onOpenModels,
  onOpenTasks,
  onProcessStarted,
  onSelectConversation,
  onSelectAgent,
}: ChatDockProps) {
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [selectedArchiveSegmentId, setSelectedArchiveSegmentId] = useState("");
  const [openPopover, setOpenPopover] = useState<ChatPopoverId | null>(null);
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(TRANSCRIPT_MESSAGE_LIMIT);
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const activeProcessId = agent?.processId?.trim() ?? "";
  const startRunAs = agent?.runAs?.trim() ?? "";
  const hasActiveProcess = activeProcessId.length > 0;
  const canStartProcess = Boolean(agent);
  const chatRuntime = useChatRuntime({
    conversationId: activeConversationId,
    enabled: open && hasActiveProcess,
    processId: activeProcessId,
  });
  const spawnProcess = useSpawnChatProcess();
  const abortProcess = useAbortChatProcess();
  const sendMessage = useSendChatMessage();
  const hilDecision = useDecideChatHil();
  const compactConversation = useCompactChatConversation();
  const forkConversation = useForkChatConversation();
  const processAiConfig = useChatProcessAiConfig({
    enabled: open && hasActiveProcess,
    pid: activeProcessId,
  });
  const setProcessAiConfig = useSetChatProcessAiConfig();
  const conversations = useChatConversations({
    enabled: open && hasActiveProcess,
    args: hasActiveProcess ? { pid: activeProcessId } : {},
  });
  const { history: processHistory, runtime } = chatRuntime;
  const pendingHil = runtime.pendingHil;
  const liveActivity = useMemo(() => deriveChatLiveActivity(runtime), [runtime]);
  const effectiveStatus = liveActivity?.status ?? status;
  const effectiveStatusLabel = liveActivity?.statusLabel ?? statusLabel;
  const effectiveAgent = useMemo(() => applyChatLiveActivityToAgent(
    agent,
    liveActivity,
    activeProcessId,
  ), [activeProcessId, agent, liveActivity]);

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

  useEffect(() => {
    setDraftAttachments((current) => {
      revokeDraftAttachments(current);
      return [];
    });
    setAttachmentError("");
    setArchiveOpen(false);
    setSelectedArchiveSegmentId("");
    setVisibleMessageLimit(TRANSCRIPT_MESSAGE_LIMIT);
  }, [activeProcessId]);

  useEffect(() => {
    setSelectedArchiveSegmentId("");
    setVisibleMessageLimit(TRANSCRIPT_MESSAGE_LIMIT);
  }, [activeProcessId, activeConversationId]);

  useEffect(() => {
    draftAttachmentsRef.current = draftAttachments;
  }, [draftAttachments]);

  useEffect(() => {
    return () => {
      revokeDraftAttachments(draftAttachmentsRef.current);
    };
  }, []);

  const activeAgent = useMemo(() => buildChatAgentViewModel({
    agent: effectiveAgent,
    title,
    status: effectiveStatus,
    statusLabel: effectiveStatusLabel,
    contextLabel,
  }), [effectiveAgent, title, effectiveStatus, effectiveStatusLabel, contextLabel]);
  const transcriptMessages = useMemo(() => {
    return runtime.rows.slice(-visibleMessageLimit);
  }, [runtime.rows, visibleMessageLimit]);
  const hasOlderLoadedMessages = runtime.rows.length > visibleMessageLimit;
  const runState = runtime.runState ?? (effectiveStatusLabel === "loading" ? undefined : effectiveStatusLabel);
  const runStateLabel = liveActivity?.runStateLabel ?? formatRunStateLabel(runState);
  const canAbortRun = hasActiveProcess
    && !abortProcess.isPending
    && (Boolean(runtime.activeRunId) || Boolean(pendingHil) || runState === "running" || runState === "awaiting_hil");
  const context = runtime.context;
  const selectedConversationId = activeConversationId ?? runtime.conversationId ?? "default";
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
  const emptyTitle = hasActiveProcess ? "No visible process messages" : "No process attached";
  const emptyDescription = hasActiveProcess
    ? "This process has not written user, assistant, system, or tool result messages yet."
    : "Start an interactive process to begin a native chat session.";
  const inputDisabled = !hasActiveProcess && !canStartProcess && !processLookupLoading;
  const addVoiceAttachment = useCallback((attachment: ChatVoiceAttachment) => {
    setAttachmentError("");
    setDraftAttachments((current) => current.concat(attachment));
  }, []);
  const voiceRecorder = useChatVoiceRecorder({
    disabled: inputDisabled || sendMessage.isPending || abortProcess.isPending,
    onAttachment: addVoiceAttachment,
  });
  const voiceStatus = voiceRecorder.voice.status;
  const voiceTitle = voiceStatus === "recording"
    ? "Stop recording"
    : voiceStatus === "requesting"
      ? "Requesting microphone"
      : voiceStatus === "processing"
        ? "Preparing voice message"
        : "Record voice";
  const voiceError = voiceRecorder.voice.error ?? "";
  const controlError = spawnProcess.isError
    ? errorMessage(spawnProcess.error, "Process could not be started.")
    : abortProcess.isError
      ? errorMessage(abortProcess.error, "Run could not be aborted.")
      : sendMessage.isError
        ? errorMessage(sendMessage.error, "Message could not be sent.")
        : hilDecision.isError
          ? errorMessage(hilDecision.error, "Tool approval could not be applied.")
          : compactConversation.isError
            ? errorMessage(compactConversation.error, "Conversation could not be compacted.")
            : forkConversation.isError
              ? errorMessage(forkConversation.error, "Conversation could not be branched.")
              : setProcessAiConfig.isError
                ? errorMessage(setProcessAiConfig.error, "Process model settings could not be updated.")
                : attachmentError || voiceError;
  const taskCount = activeAgent.tasksTotal > 0 ? activeAgent.tasksTotal : activeAgent.tasks.length;
  const contextLevel = context?.level ? context.level.toUpperCase() : contextPercent === null ? "UNKNOWN" : "ESTIMATED";
  const contextModel = context ? [context.provider, context.model].filter(Boolean).join(" · ") : activeAgent.modelLabel;
  const compactKeepLast = Math.max(1, Math.min(48, Math.floor(Math.max(runtime.messageCount, transcriptMessages.length) / 2)));
  const canFreeContext = hasActiveProcess
    && !canAbortRun
    && !compactConversation.isPending
    && Math.max(runtime.messageCount, transcriptMessages.length) > compactKeepLast;

  const startProcess = () => {
    spawnProcess.mutate({
      interactive: true,
      ...(startRunAs ? { runAs: startRunAs } : {}),
    }, {
      onSuccess: (result) => {
        onProcessStarted?.(result.pid);
      },
    });
  };

  const abortActiveRun = () => {
    if (!hasActiveProcess) {
      return;
    }
    abortProcess.mutate({ pid: activeProcessId });
  };

  const decidePendingHil = (decision: ChatHilDecision, remember = false) => {
    if (!hasActiveProcess || !pendingHil || hilDecision.isPending) {
      return;
    }
    hilDecision.mutate({
      pid: activeProcessId,
      requestId: pendingHil.requestId,
      decision,
      ...(remember ? { remember } : {}),
    });
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setAttachmentError("");
    void Promise.all(Array.from(files).map(fileToDraftAttachment))
      .then((attachments) => {
        setDraftAttachments((current) => current.concat(attachments));
      })
      .catch((error) => {
        setAttachmentError(errorMessage(error, "Attachment could not be read."));
      });
  };

  const removeAttachment = (attachmentId: string) => {
    setDraftAttachments((current) => {
      const next = current.filter((attachment) => {
        if (attachment.id === attachmentId) {
          revokeDraftAttachment(attachment);
          return false;
        }
        return true;
      });
      return next;
    });
  };

  const handleSendMessage = async (message: string) => {
    if ((!hasActiveProcess && !canStartProcess) || sendMessage.isPending || spawnProcess.isPending) {
      return;
    }
    const media = draftAttachments.map((attachment): ProcMediaInput => ({
      type: attachment.type,
      mimeType: attachment.mimeType,
      ...(attachment.data ? { data: attachment.data } : {}),
      ...(attachment.url ? { url: attachment.url } : {}),
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.size ? { size: attachment.size } : {}),
      ...(attachment.duration ? { duration: attachment.duration } : {}),
      ...(attachment.transcription ? { transcription: attachment.transcription } : {}),
    }));
    const trimmedMessage = message.trim();
    if (!trimmedMessage && media.length === 0) {
      return;
    }
    const outgoingMessage = trimmedMessage
      || (media.some((attachment) => attachment.type === "audio") ? "Voice message." : "Attached media.");
    let targetPid = activeProcessId;
    let targetConversationId = selectedConversationId;
    if (!targetPid) {
      try {
        const spawned = await spawnProcess.mutateAsync({
          interactive: true,
          label: outgoingMessage || activeAgent.name,
          ...(startRunAs ? { runAs: startRunAs } : {}),
        });
        targetPid = spawned.pid;
        targetConversationId = "default";
        onProcessStarted?.(spawned.pid);
      } catch {
        return;
      }
    }

    chatRuntime.appendOptimisticUserMessage(outgoingMessage, media);
    revokeDraftAttachments(draftAttachments);
    setDraftAttachments([]);
    setAttachmentError("");
    sendMessage.mutate({
      message: outgoingMessage,
      pid: targetPid,
      ...(targetConversationId ? { conversationId: targetConversationId } : {}),
      ...(media.length > 0 ? { media } : {}),
    });
  };

  const branchFromMessage = (messageId: number) => {
    if (!hasActiveProcess || forkConversation.isPending) {
      return;
    }
    const targetConversationId = `branch-${Date.now().toString(36)}`;
    forkConversation.mutate({
      pid: activeProcessId,
      conversationId: selectedConversationId,
      throughMessageId: messageId,
      targetConversationId,
      title: `Branch from message ${messageId}`,
    }, {
      onSuccess: (result) => {
        onSelectConversation?.(result.targetConversation.id);
      },
    });
  };

  const freeContext = () => {
    if (!canFreeContext) {
      return;
    }
    compactConversation.mutate({
      pid: activeProcessId,
      conversationId: selectedConversationId,
      keepLast: compactKeepLast,
      generateSummary: true,
    }, {
      onSuccess: (result) => {
        setArchiveOpen(true);
        setSelectedArchiveSegmentId(result.segment.id);
      },
    });
  };

  const setProcessAiKey = (key: string, value: string) => {
    if (!hasActiveProcess || setProcessAiConfig.isPending) {
      return;
    }
    setProcessAiConfig.mutate({
      pid: activeProcessId,
      key,
      value,
    });
  };

  const applyProcessAiProfile = (profile: ChatModelProfileData) => {
    if (!hasActiveProcess || setProcessAiConfig.isPending) {
      return;
    }
    setProcessAiConfig.mutate({
      pid: activeProcessId,
      values: profile.values,
      profile: {
        id: profile.id,
        name: profile.name,
      },
    });
  };

  const clearProcessAiConfig = () => {
    if (!hasActiveProcess || setProcessAiConfig.isPending) {
      return;
    }
    setProcessAiConfig.mutate({
      pid: activeProcessId,
      clear: true,
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
        messageCount={runtime.messageCount}
        openPopover={openPopover}
        processAiConfig={processAiConfig.data ?? null}
        processAiConfigBusy={setProcessAiConfig.isPending}
        processAiConfigLoading={processAiConfig.isLoading}
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
        onApplyModelProfile={applyProcessAiProfile}
        onClearProcessAiConfig={clearProcessAiConfig}
        onSetReasoning={(reasoning) => setProcessAiKey("config/ai/reasoning", reasoning)}
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

      <ChatConversationBar
        activeConversationId={selectedConversationId}
        conversations={conversations.data ?? []}
        onSelect={(conversationId) => {
          setArchiveOpen(false);
          onSelectConversation?.(conversationId);
        }}
      />

      {hasActiveProcess ? (
        <div class="gsv-chat-thread-tools">
          <button
            type="button"
            disabled={!canFreeContext}
            title={canAbortRun ? "Context can be compacted after the active run finishes" : "Archive older messages and keep the latest context live"}
            onClick={freeContext}
          >
            <Icon name="stars" size={12} />
            <span>{compactConversation.isPending ? "FREEING" : "FREE CONTEXT"}</span>
            <small>KEEP {compactKeepLast}</small>
          </button>
          <button
            type="button"
            aria-expanded={archiveOpen}
            onClick={() => setArchiveOpen((value) => !value)}
          >
            <Icon name="folder" family="doticons" size={12} />
            <span>{archiveOpen ? "CLOSE ARCHIVE" : "ARCHIVE"}</span>
          </button>
        </div>
      ) : null}

      {archiveOpen && hasActiveProcess ? (
        <ChatArchivePanel
          conversationId={selectedConversationId}
          processId={activeProcessId}
          selectedSegmentId={selectedArchiveSegmentId}
          onClose={() => setArchiveOpen(false)}
          onSelectSegment={setSelectedArchiveSegmentId}
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
        beforeMessages={hasOlderLoadedMessages ? (
          <button
            type="button"
            class="gsv-chat-load-older"
            onClick={() => setVisibleMessageLimit((current) => current + TRANSCRIPT_MESSAGE_LIMIT)}
          >
            LOAD OLDER
          </button>
        ) : null}
        onBranch={branchFromMessage}
        processId={activeProcessId}
        state={transcriptState}
      />

      <MessageInput
        attachments={draftAttachments}
        busy={sendMessage.isPending || abortProcess.isPending || spawnProcess.isPending}
        canSend={hasActiveProcess || canStartProcess}
        disabled={inputDisabled}
        onFiles={handleFiles}
        onRemoveAttachment={removeAttachment}
        onSend={handleSendMessage}
        onStop={abortActiveRun}
        onVoiceClick={voiceRecorder.toggleRecording}
        placeholder={`Message ${activeAgent.name}...`}
        running={canAbortRun}
        user={userLabel}
        voiceActive={voiceStatus === "recording"}
        voiceDisabled={voiceStatus === "requesting" || voiceStatus === "processing"}
        voiceTitle={voiceTitle}
      />
    </aside>
  );
}
