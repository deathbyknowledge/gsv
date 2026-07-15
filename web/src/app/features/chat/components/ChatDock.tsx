import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ProcContextState, ProcMediaInput, ProcUsageState } from "@humansandmachines/gsv/protocol";
import { AgentImage } from "../../../components/ui/AgentImage";
import { Alert } from "../../../components/ui/Alert";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";
import { Counter } from "../../../components/ui/Counter";
import { Icon } from "../../../components/ui/Icon";
import { IconButton } from "../../../components/ui/IconButton";
import { MessageInput, type MessageInputAttachment } from "../../../components/ui/MessageInput";
import type { StatusTone } from "../../../components/ui/StatusDot";
import { Hint } from "../../../components/ui/Tooltip";
import type { JSX } from "preact";
import {
  buildChatAgentViewModel,
  formatChatReasoningLabel,
  type ChatAgentData,
  type ChatAgentStatus,
  type ChatAgentSelection,
  type ChatModelProfileData,
} from "../domain/agent";
import {
  applyChatLiveActivityToAgent,
  deriveChatLiveActivity,
} from "../domain/activity";
import {
  MAX_CHAT_PROCESS_MEDIA_BYTES,
  type ChatHilDecision,
  type ChatMediaUpload,
  type ChatProcessSummary,
} from "../domain/processes";
import {
  useAbortChatProcess,
  useCompactChatConversation,
  useChatConversations,
  useChatConversationSegments,
  useChatProcessAiConfig,
  useForkChatConversation,
  useDecideChatHil,
  useSendChatMessage,
  useSetChatProcessAiConfig,
  useSpawnChatProcess,
  useChatAmbientTranscription,
  type ChatTranscriptionTarget,
  useChatReplySpeech,
  useChatRuntime,
  useDraggableMinimizedChat,
} from "../hooks";
import { useChatFeedback } from "../hooks/useChatFeedback";
import { ChatAgentPanel } from "./ChatAgentPanel";
import { ChatApprovalBanner } from "./ChatApprovalBanner";
import { ChatArchivePanel } from "./ChatArchivePanel";
import { ChatReasoningPanel, type ChatReasoningTarget } from "./ChatReasoningPanel";
import { ChatDockHeader } from "./ChatDockHeader";
import type { ChatPopoverId } from "./ChatDockPopovers";
import { ChatTranscript, type ChatDockMessage } from "./ChatTranscript";
import { formatCount, formatCurrencyCost, shortId } from "./chatUiFormat";
import "./ChatDock.css";

export type { ChatDockMessage } from "./ChatTranscript";

export type StartedChatProcess = {
  cwd?: string;
  label?: string;
  pid: string;
};

/** What fills the dock below the (always-present) header: the chat itself, the
 *  agent tasks panel, or the full-body reasoning panel. */
type ChatBodyState = "chat" | "agent" | "reasoning";

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
  onProcessStarted?: (process: StartedChatProcess) => void;
  onSelectConversation?: (conversationId: string) => void;
  onSelectAgent?: (selection: ChatAgentSelection) => void;
  /** Increment to request a fresh task (e.g. the Tasks list NEW TASK action):
   *  opens the dock and spawns a new interactive process rather than reopening
   *  whatever was last selected. */
  newTaskSignal?: number;
};

function agentStatusTone(status: ChatAgentStatus | undefined): StatusTone | null {
  if (status === "error" || status === "idle" || status === "live" || status === "online") {
    return status;
  }
  return null;
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

function formatCostSource(source: string | undefined): string {
  if (source === "model-pricing") {
    return "model pricing";
  }
  if (source === "provider") {
    return "provider pricing";
  }
  if (source === "mixed") {
    return "mixed pricing";
  }
  return "pricing unavailable";
}

function formatConversationCostTooltip(context: ProcContextState | null | undefined): string {
  const usage: ProcUsageState | null = context?.conversationUsage ?? null;
  if (!usage) {
    return "";
  }
  const cost = usage.cost;
  const tokens = `${formatCount(usage.totalTokens)} tokens`;
  if (!cost) {
    return `Conversation cost unavailable · ${tokens} · pricing unavailable`;
  }
  const total = `${usage.costIncomplete ? "~" : ""}${formatCurrencyCost(cost.total)}`;
  const details = [
    `Conversation cost ${total}`,
    tokens,
  ];
  if (usage.cacheReadTokens > 0) {
    details.push(`cache read ${formatCount(usage.cacheReadTokens)}`);
  }
  if (usage.cacheWriteTokens > 0) {
    details.push(`cache write ${formatCount(usage.cacheWriteTokens)}`);
  }
  details.push(formatCostSource(cost.source));
  return details.join(" · ");
}

type DraftAttachment = ChatMediaUpload & MessageInputAttachment;

type StoppingRun = {
  pid: string;
  runId: string | null;
};

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

function fileToDraftAttachment(file: File): DraftAttachment {
  const mimeType = file.type || "application/octet-stream";
  const type = inferAttachmentType(file);
  const sizeLabel = formatAttachmentSize(file.size);
  const label = file.name || (type === "image" ? "pasted image" : "attachment");
  const randomId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return {
    id: `${file.name}:${file.size}:${file.lastModified}:${randomId}`,
    type,
    mimeType,
    body: file,
    filename: file.name || undefined,
    label,
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
  newTaskSignal = 0,
}: ChatDockProps) {
  const [bodyState, setBodyState] = useState<ChatBodyState>("chat");
  const [reasoningTarget, setReasoningTarget] = useState<ChatReasoningTarget | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [selectedArchiveSegmentId, setSelectedArchiveSegmentId] = useState("");
  const [openPopover, setOpenPopover] = useState<ChatPopoverId | null>(null);
  const [contextConfirmOpen, setContextConfirmOpen] = useState(false);
  const [compactKeepLastDraft, setCompactKeepLastDraft] = useState(1);
  const [newTaskFocusKey, setNewTaskFocusKey] = useState(0);
  const [composerDraft, setComposerDraft] = useState("");
  const [branchNotice, setBranchNotice] = useState("");
  const minimizedChat = useDraggableMinimizedChat({ open, onActivate: onToggleOpen });
  const [stoppingRun, setStoppingRun] = useState<StoppingRun | null>(null);
  /** Snapshot of the last dismissed control error — a new distinct error re-shows. */
  const [dismissedError, setDismissedError] = useState("");
  const activeProcessId = agent?.processId?.trim() ?? "";
  const startRunAs = agent?.runAs?.trim() ?? "";
  const hasActiveProcess = activeProcessId.length > 0;
  const canStartProcess = Boolean(agent);
  const chatRuntime = useChatRuntime({
    conversationId: activeConversationId,
    enabled: hasActiveProcess,
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
  const feedback = useChatFeedback();
  const pendingHil = runtime.pendingHil;
  const currentRunId = runtime.activeRunId ?? pendingHil?.runId ?? null;
  const currentRunActive = Boolean(currentRunId)
    || runtime.runState === "running"
    || runtime.runState === "awaiting_hil";
  const stoppingCurrentRun = Boolean(
    stoppingRun
    && stoppingRun.pid === activeProcessId
    && currentRunActive
    && (stoppingRun.runId === null || stoppingRun.runId === currentRunId),
  );
  const liveActivity = useMemo(
    () => deriveChatLiveActivity(runtime, stoppingCurrentRun),
    [runtime, stoppingCurrentRun],
  );
  const effectiveAgent = useMemo(() => applyChatLiveActivityToAgent(
    agent,
    liveActivity,
    activeProcessId,
  ), [activeProcessId, agent, liveActivity]);
  const effectiveStatus = liveActivity?.status ?? agentStatusTone(effectiveAgent?.status) ?? status;
  const effectiveStatusLabel = liveActivity?.statusLabel ?? effectiveAgent?.statusLabel ?? statusLabel;

  useEffect(() => {
    if (!open) {
      setBodyState("chat");
      setOpenPopover(null);
    }
  }, [open]);

  useEffect(() => {
    if (
      stoppingRun
      && (
        stoppingRun.pid !== activeProcessId
        || !currentRunActive
        || (stoppingRun.runId !== null && stoppingRun.runId !== currentRunId)
      )
    ) {
      setStoppingRun(null);
    }
  }, [activeProcessId, currentRunActive, currentRunId, stoppingRun]);

  useEffect(() => {
    if (bodyState !== "chat") {
      setOpenPopover(null);
    }
  }, [bodyState]);

  // A blocking approval must never hide behind a panel — yank back to chat.
  useEffect(() => {
    if (pendingHil) {
      setBodyState("chat");
    }
  }, [pendingHil]);

  // Esc closes whichever panel is open and hands focus back to the header
  // avatar button (the panel toggle).
  useEffect(() => {
    if (bodyState === "chat") {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.stopPropagation();
      setBodyState("chat");
      asideRef.current?.querySelector<HTMLButtonElement>(".gsv-chat-agent-main")?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [bodyState]);

  useEffect(() => {
    setDraftAttachments([]);
    setAttachmentError("");
    setArchiveOpen(false);
    setSelectedArchiveSegmentId("");
    setBranchNotice("");
    setDismissedError("");
    feedback.reset();
    setBodyState("chat");
    compactConversation.reset();
  }, [activeProcessId, compactConversation.reset, feedback.reset]);

  useEffect(() => {
    setSelectedArchiveSegmentId("");
    setBodyState("chat");
  }, [activeProcessId, activeConversationId]);

  // Auto-dismiss the branch success notice after a few seconds.
  useEffect(() => {
    if (!branchNotice) {
      return;
    }
    const timer = setTimeout(() => setBranchNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [branchNotice]);

  const activeAgent = useMemo(() => buildChatAgentViewModel({
    agent: effectiveAgent,
    title,
    status: effectiveStatus,
    statusLabel: effectiveStatusLabel,
    contextLabel,
  }), [effectiveAgent, title, effectiveStatus, effectiveStatusLabel, contextLabel]);
  const transcriptMessages = runtime.rows;
  const runState = runtime.runState ?? (effectiveStatusLabel === "loading" ? undefined : effectiveStatusLabel);
  const canAbortRun = hasActiveProcess
    && !abortProcess.isPending
    && !stoppingCurrentRun
    && (Boolean(runtime.activeRunId) || Boolean(pendingHil) || runState === "running" || runState === "awaiting_hil");
  const context = runtime.context;
  const selectedConversationId = activeConversationId ?? runtime.conversationId ?? "default";
  const replySpeech = useChatReplySpeech({
    conversationId: selectedConversationId,
    hydrated: !processHistory.isLoading,
    processId: activeProcessId,
    rows: runtime.rows,
  });
  const conversationSegments = useChatConversationSegments({
    enabled: open && hasActiveProcess,
    args: hasActiveProcess ? { pid: activeProcessId, conversationId: selectedConversationId } : {},
  });
  const hasArchivedMessages = (conversationSegments.data?.length ?? 0) > 0;
  const contextPercent = contextPressurePercent(context?.pressure);
  // Severity tone for the context control: pressure level drives it when we have
  // context data; a load failure with no pressure shows as an error. Everything
  // else (idle / not attached / loading / unknown) stays neutral.
  const contextTone: "default" | "attention" | "error" =
    context?.level === "critical" || context?.level === "full"
      ? "error"
      : context?.level === "warn"
        ? "attention"
        : contextPercent === null && processHistory.isError
          ? "error"
          : "default";
  // No pressure reading — name the specific reason in the tooltip so the empty
  // "CONTEXT" label isn't ambiguous (not attached / load error / loading /
  // unknown / idle).
  const contextTitle = contextPercent !== null
    ? `${contextPercent}% context pressure`
    : !hasActiveProcess
      ? "Context — no process attached"
      : processHistory.isError
        ? "Context — history failed to load"
        : processHistory.isLoading
          ? "Context — loading…"
          : context
            ? "Context — pressure unknown"
            : "Context — process idle";
  const conversationCost = formatConversationCostTooltip(context);
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
  const compactPending = compactConversation.isPending;
  const compactFailed = compactConversation.isError;
  const composerLocked = hasActiveProcess && (compactPending || compactFailed);
  const inputDisabled = (!hasActiveProcess && !canStartProcess && !processLookupLoading) || composerLocked;
  const sendChatDraft = useCallback(async (
    message: string,
    media: ChatMediaUpload[] = [],
    pinnedTarget?: ChatTranscriptionTarget,
    signal?: AbortSignal,
    adoptTarget?: (target: ChatTranscriptionTarget) => void,
  ): Promise<ChatTranscriptionTarget | null> => {
    signal?.throwIfAborted();
    let targetPid = pinnedTarget ? pinnedTarget.processId : activeProcessId;
    let targetConversationId = pinnedTarget ? pinnedTarget.conversationId : selectedConversationId;
    if ((!targetPid && !canStartProcess) || sendMessage.isPending || spawnProcess.isPending) {
      return null;
    }
    const trimmedMessage = message.trim();
    if (!trimmedMessage && media.length === 0) {
      return null;
    }
    const outgoingMessage = trimmedMessage
      || (media.some((attachment) => attachment.type === "audio") ? "Voice message." : "Attached media.");
    if (!targetPid) {
      const spawned = await spawnProcess.mutateAsync({
        interactive: true,
        label: outgoingMessage || activeAgent.name,
        ...(startRunAs ? { runAs: startRunAs } : {}),
      });
      signal?.throwIfAborted();
      targetPid = spawned.pid;
      targetConversationId = "default";
      adoptTarget?.({ processId: targetPid, conversationId: targetConversationId });
      onProcessStarted?.(spawned);
      onSelectConversation?.("default");
    }
    signal?.throwIfAborted();

    if (
      !pinnedTarget ||
      (targetPid === activeProcessId && targetConversationId === selectedConversationId)
    ) {
      chatRuntime.appendOptimisticUserMessage(outgoingMessage, media.map((item): ProcMediaInput => ({
        type: item.type,
        mimeType: item.mimeType,
        ...(item.filename ? { filename: item.filename } : {}),
        size: item.body.size,
        ...(item.duration !== undefined ? { duration: item.duration } : {}),
        ...(item.transcription ? { transcription: item.transcription } : {}),
      })));
    }
    setAttachmentError("");
    signal?.throwIfAborted();
    await sendMessage.mutateAsync({
      message: outgoingMessage,
      pid: targetPid,
      ...(targetConversationId ? { conversationId: targetConversationId } : {}),
      ...(media.length > 0 ? { media } : {}),
    });
    return { processId: targetPid, conversationId: targetConversationId };
  }, [
    activeAgent.name,
    activeProcessId,
    canStartProcess,
    chatRuntime,
    onProcessStarted,
    onSelectConversation,
    selectedConversationId,
    sendMessage,
    spawnProcess,
    startRunAs,
  ]);
  const appendDictationDraft = useCallback((text: string) => {
    const dictation = text.trim();
    if (!dictation) {
      return;
    }
    setComposerDraft((current) => current.trim()
      ? `${current.trimEnd()} ${dictation}`
      : dictation);
    setNewTaskFocusKey((key) => key + 1);
  }, []);
  const ambientTranscription = useChatAmbientTranscription({
    activeRunCount: canAbortRun ? 1 : 0,
    agentName: activeAgent.name,
    conversationId: selectedConversationId,
    disabled: inputDisabled || abortProcess.isPending,
    isSpeechOutputPlaying: replySpeech.isSpeaking,
    onDictation: appendDictationDraft,
    onCancelSpeechOutput: replySpeech.cancelSpeech,
    onTranscript: (text, target, signal, adoptTarget) =>
      sendChatDraft(text, [], target, signal, adoptTarget),
    processId: activeProcessId || null,
  });
  const voiceTitle = ambientTranscription.liveActive
    ? ambientTranscription.liveTitle
    : ambientTranscription.dictationTitle;
  const voiceError = ambientTranscription.error;
  // Voice status feedback lines — transient "Listening…" / "Transcribing…" in
  // the chat body while conversation mode or dictation is active (HAM-473).
  const voiceFeedbackLabel = useRef<string | null>(null);
  useEffect(() => {
    const state = ambientTranscription.state;
    const voiceOn = ambientTranscription.liveActive || ambientTranscription.dictationActive;
    const label = !voiceOn
      ? null
      : state === "recording" || state === "listening" || state === "capturing"
        ? "Listening…"
        : state === "transcribing" || state === "sending"
          ? "Transcribing…"
          : null;
    if (!label) {
      if (voiceFeedbackLabel.current !== null) {
        voiceFeedbackLabel.current = null;
        feedback.clear("voice");
      }
      return;
    }
    if (voiceFeedbackLabel.current === null) {
      feedback.begin("voice", label, { persist: false });
    } else if (voiceFeedbackLabel.current !== label) {
      feedback.update("voice", label);
    }
    voiceFeedbackLabel.current = label;
  }, [
    ambientTranscription.state,
    ambientTranscription.liveActive,
    ambientTranscription.dictationActive,
    feedback.begin,
    feedback.clear,
    feedback.update,
  ]);
  const handleVoiceClick = useCallback(() => {
    if (ambientTranscription.liveActive) {
      ambientTranscription.toggleLive();
      return;
    }
    ambientTranscription.toggleDictation();
  }, [ambientTranscription]);
  // Stop + compaction failures surface as feedback lines in the transcript
  // (HAM-366/434), so they are deliberately absent from this chain.
  const controlError = spawnProcess.isError
    ? errorMessage(spawnProcess.error, "Process could not be started.")
    : sendMessage.isError
      ? errorMessage(sendMessage.error, "Message could not be sent.")
      : hilDecision.isError
        ? errorMessage(hilDecision.error, "Tool approval could not be applied.")
        : forkConversation.isError
          ? errorMessage(forkConversation.error, "Conversation could not be branched.")
          : setProcessAiConfig.isError
            ? errorMessage(setProcessAiConfig.error, "Process model settings could not be updated.")
            : attachmentError || voiceError;
  const taskCount = activeAgent.tasksTotal > 0 ? activeAgent.tasksTotal : activeAgent.tasks.length;
  const contextLevel = context?.level ? context.level.toUpperCase() : contextPercent === null ? "UNKNOWN" : "ESTIMATED";
  const processModel = processAiConfig.data?.values["config/ai/model"]?.trim() ?? "";
  const currentModelLabel = processModel || activeAgent.modelLabel;
  const processReasoning = processAiConfig.data?.values["config/ai/reasoning"]?.trim() ?? "";
  const contextReasoning = context?.reasoning?.trim() ?? "";
  const currentReasoningLabel = formatChatReasoningLabel(processReasoning || contextReasoning || activeAgent.reasoningLabel);
  const compactKeepLast = Math.max(1, Math.min(48, Math.floor(Math.max(runtime.messageCount, transcriptMessages.length) / 2)));
  const compactMessageTotal = Math.max(runtime.messageCount, transcriptMessages.length);
  const compactKeepMax = Math.max(1, Math.min(96, compactMessageTotal - 1));
  const canFreeContext = hasActiveProcess
    && !canAbortRun
    && !compactConversation.isPending
    && compactMessageTotal > compactKeepLast;
  const canStartNewTask = canStartProcess && !spawnProcess.isPending;

  useEffect(() => {
    if (!contextConfirmOpen) {
      setCompactKeepLastDraft(compactKeepLast);
    }
  }, [compactKeepLast, contextConfirmOpen]);

  const startProcess = () => {
    if (!canStartNewTask) {
      return;
    }
    spawnProcess.mutate({
      interactive: true,
      ...(startRunAs ? { runAs: startRunAs } : {}),
    }, {
      onSuccess: (result) => {
        onProcessStarted?.(result);
        onSelectConversation?.("default");
        setNewTaskFocusKey((key) => key + 1);
      },
    });
  };

  const abortActiveRun = () => {
    if (!hasActiveProcess) {
      return;
    }
    const runId = runtime.activeRunId ?? pendingHil?.runId;
    const requestedStop = { pid: activeProcessId, runId: runId ?? null };
    setStoppingRun(requestedStop);
    feedback.begin("abort", "Stopping task");
    abortProcess.mutate({
      pid: activeProcessId,
      ...(runId ? { runId } : {}),
    }, {
      onSuccess: () => {
        feedback.resolve("abort", "success", "Task successfully stopped.");
      },
      onError: () => {
        setStoppingRun((current) => (
          current?.pid === requestedStop.pid && current.runId === requestedStop.runId
            ? null
            : current
        ));
        feedback.resolve("abort", "error", "Error trying to stop task");
      },
    });
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

  const handleFiles = (files: FileList | readonly File[] | null) => {
    if (!files || files.length === 0) {
      return;
    }
    const selected = Array.from(files);
    const accepted = selected.filter((file) => file.size <= MAX_CHAT_PROCESS_MEDIA_BYTES);
    setAttachmentError(accepted.length === selected.length ? "" : "Chat attachments cannot exceed 25 MiB.");
    setDraftAttachments((current) => current.concat(accepted.map(fileToDraftAttachment)));
  };

  const removeAttachment = (attachmentId: string) => {
    setDraftAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  };

  const handleSendMessage = async (message: string) => {
    const sentAttachments = draftAttachments;
    const media = sentAttachments.map((attachment): ChatMediaUpload => ({
      type: attachment.type,
      mimeType: attachment.mimeType,
      body: attachment.body,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.duration ? { duration: attachment.duration } : {}),
      ...(attachment.transcription ? { transcription: attachment.transcription } : {}),
    }));
    if (sentAttachments.length > 0) {
      setAttachmentError("");
      setDraftAttachments([]);
    }
    let sent: ChatTranscriptionTarget | null = null;
    try {
      sent = await sendChatDraft(message, media);
    } catch (error) {
      if (sentAttachments.length > 0) {
        setDraftAttachments((current) => sentAttachments.concat(current));
      }
      setAttachmentError(errorMessage(error, "Message could not be sent."));
      return;
    }
    if (!sent) {
      if (sentAttachments.length > 0) {
        setDraftAttachments((current) => sentAttachments.concat(current));
      }
      return;
    }
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
        setBranchNotice("Successfully branched conversation");
      },
    });
  };

  const prepareNewTask = () => {
    if (!canStartNewTask) {
      return;
    }
    setOpenPopover(null);
    setArchiveOpen(false);
    setSelectedArchiveSegmentId("");
    compactConversation.reset();
    spawnProcess.mutate({
      fresh: true,
      interactive: true,
      label: activeAgent.name,
      ...(startRunAs ? { runAs: startRunAs } : {}),
    }, {
      onSuccess: (result) => {
        onProcessStarted?.(result);
        onSelectConversation?.("default");
        setNewTaskFocusKey((key) => key + 1);
      },
    });
  };

  // External fresh-task request (e.g. the Tasks list NEW TASK action). Fire on
  // each increment of the signal; the initial value never triggers a spawn.
  const lastNewTaskSignal = useRef(newTaskSignal);
  useEffect(() => {
    if (newTaskSignal !== lastNewTaskSignal.current) {
      lastNewTaskSignal.current = newTaskSignal;
      if (newTaskSignal > 0) {
        prepareNewTask();
      }
    }
  }, [newTaskSignal]);

  const requestFreeContext = () => {
    if (!canFreeContext) {
      return;
    }
    setCompactKeepLastDraft(compactKeepLast);
    setContextConfirmOpen(true);
  };

  const freeContext = (keepLast: number) => {
    if (!canFreeContext) {
      return;
    }
    const normalizedKeepLast = Math.max(1, Math.min(compactKeepMax, Math.floor(keepLast)));
    setContextConfirmOpen(false);
    feedback.begin("compact", "Freeing context");
    compactConversation.mutate({
      pid: activeProcessId,
      conversationId: selectedConversationId,
      keepLast: normalizedKeepLast,
      generateSummary: true,
    }, {
      onSuccess: (result) => {
        setArchiveOpen(true);
        setSelectedArchiveSegmentId(result.segment.id);
        feedback.resolve("compact", "success", "Context freed");
      },
      onError: () => {
        feedback.resolve("compact", "error", "Context freeing failed");
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
      profileId: profile.id,
      profileName: profile.name,
    });
  };

  const toggleAgentPanel = () => {
    setBodyState((current) => current === "agent" ? "chat" : "agent");
  };

  const returnToChat = () => {
    setBodyState("chat");
    setReasoningTarget(null);
  };

  const openReasoning = (target: ChatReasoningTarget) => {
    setReasoningTarget(target);
    setBodyState("reasoning");
  };

  const togglePopover = (popover: ChatPopoverId) => {
    setOpenPopover((current) => current === popover ? null : popover);
  };

  const openTaskProcess = (processId: string, process: ChatProcessSummary | null) => {
    const targetProcessId = processId.trim();
    if (!targetProcessId || !onSelectAgent) {
      return;
    }
    setOpenPopover(null);
    onSelectAgent({
      processId: targetProcessId,
      ...(process ? { process } : {}),
    });
  };

  const closePopoverFromOutsideClick = (event: JSX.TargetedMouseEvent<HTMLElement>) => {
    if (!openPopover || !(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest(".gsv-chat-popover")) {
      return;
    }
    const trigger = event.target.closest("[data-chat-popover-trigger]");
    if (trigger?.getAttribute("data-chat-popover-trigger") === openPopover) {
      return;
    }
    setOpenPopover(null);
  };

  if (!open) {
    return (
      <button
        ref={minimizedChat.launcherRef}
        type="button"
        class={`gsv-chat-min${minimizedChat.dragging ? " is-dragging" : ""}`}
        style={minimizedChat.style}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
        aria-label={`Open chat with ${activeAgent.name}; use arrow keys to move`}
        title="Open chat; drag or use arrow keys to move"
        onClick={minimizedChat.onClick}
        onKeyDown={minimizedChat.onKeyDown}
        onLostPointerCapture={minimizedChat.onLostPointerCapture}
        onPointerCancel={minimizedChat.onPointerCancel}
        onPointerDown={minimizedChat.onPointerDown}
        onPointerMove={minimizedChat.onPointerMove}
        onPointerUp={minimizedChat.onPointerUp}
      >
        <AgentImage src={activeAgent.imageSrc} size={40} cover />
        <span class="gsv-chat-min-copy">
          <strong class="gsv-prose-heading">{activeAgent.name}</strong>
          <small class="gsv-label">
            {activeAgent.activity}
            <i />
          </small>
        </span>
      </button>
    );
  }

  return (
    <aside
      ref={asideRef}
      class={`gsv-chat${dragging ? " is-dragging" : ""}`}
      aria-label="Chat"
      style={{ width: `${width}px` }}
      onClickCapture={closePopoverFromOutsideClick}
    >
      <div class="gsv-chat-resize" onMouseDown={onResizeStart} title="Resize chat" />
      {contextConfirmOpen ? (
        <div class="gsv-chat-modal-layer" onClick={() => setContextConfirmOpen(false)}>
          <div class="gsv-chat-modal-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title="FREE CONTEXT"
              message={`Archive older messages, generate a summary, and keep the latest ${compactKeepLastDraft} messages active.`}
              note="Older messages remain available in the archive after compaction."
              confirmLabel="FREE CONTEXT"
              onCancel={() => setContextConfirmOpen(false)}
              onConfirm={() => freeContext(compactKeepLastDraft)}
            >
              <Counter
                label="KEEP MESSAGES"
                description={`Choose how many recent messages stay live. Current conversation has ${compactMessageTotal}.`}
                min={1}
                max={compactKeepMax}
                step={1}
                size="small"
                value={compactKeepLastDraft}
                onChange={setCompactKeepLastDraft}
              />
            </ConfirmModal>
          </div>
        </div>
      ) : null}
      {openPopover ? <button type="button" class="gsv-chat-popover-scrim" aria-label="Close chat menu" onClick={() => setOpenPopover(null)} /> : null}
      <ChatDockHeader
        activeAgent={activeAgent}
        activeProcessId={activeProcessId}
        agentPanelOpen={bodyState === "agent"}
        archiveOpen={archiveOpen}
        atMax={atMax}
        canAbortRun={canAbortRun}
        canFreeContext={canFreeContext}
        compactKeepLast={compactKeepLast}
        compactPending={compactConversation.isPending}
        hasArchivedMessages={hasArchivedMessages}
        onFreeContext={() => {
          setOpenPopover(null);
          requestFreeContext();
        }}
        onToggleArchive={() => {
          setOpenPopover(null);
          setArchiveOpen((value) => !value);
        }}
        conversations={conversations.data ?? []}
        activeConversationId={selectedConversationId}
        onSelectConversation={(conversationId) => {
          setOpenPopover(null);
          setArchiveOpen(false);
          onSelectConversation?.(conversationId);
        }}
        context={context}
        contextLevel={contextLevel}
        contextTone={contextTone}
        contextPercent={contextPercent}
        contextTitle={contextTitle}
        effectiveStatus={effectiveStatus}
        hasActiveProcess={hasActiveProcess}
        messageCount={runtime.messageCount}
        modelLabel={currentModelLabel}
        openPopover={openPopover}
        processAiConfig={processAiConfig.data ?? null}
        processAiConfigBusy={setProcessAiConfig.isPending}
        reasoningLabel={currentReasoningLabel}
        canStartNewTask={canStartNewTask}
        spawnPending={spawnProcess.isPending}
        speakReplies={replySpeech.speakReplies}
        speechStatus={replySpeech.speechStatus}
        taskCount={taskCount}
        onAbortRun={abortActiveRun}
        onOpenAgentPanel={toggleAgentPanel}
        onOpenModels={() => {
          setOpenPopover(null);
          (onOpenModels ?? onOpenCrew)();
        }}
        onOpenTasks={() => {
          setOpenPopover(null);
          (onOpenTasks ?? onOpenCrew)();
        }}
        onOpenTaskProcess={openTaskProcess}
        onStartNewTask={prepareNewTask}
        onStartProcess={startProcess}
        onApplyModelProfile={applyProcessAiProfile}
        onSetReasoning={(reasoning) => setProcessAiKey("config/ai/reasoning", reasoning)}
        onToggleSpeakReplies={() => replySpeech.setSpeakReplies(!replySpeech.speakReplies)}
        onToggleMax={onToggleMax}
        onToggleOpen={onToggleOpen}
        onTogglePopover={togglePopover}
      />

      {bodyState === "agent" ? (
        <ChatAgentPanel
          agent={activeAgent}
          activeProcessId={activeProcessId}
          canStartNewTask={canStartNewTask}
          onOpenTaskProcess={openTaskProcess}
          onStartNewTask={prepareNewTask}
          onSelectAgent={onSelectAgent}
          onOpenCrew={onOpenCrew}
          onClose={returnToChat}
        />
      ) : null}

      {bodyState === "reasoning" && reasoningTarget ? (
        <ChatReasoningPanel
          messages={transcriptMessages}
          target={reasoningTarget}
          onClose={returnToChat}
        />
      ) : null}

      {bodyState === "chat" && archiveOpen && hasActiveProcess ? (
        <ChatArchivePanel
          conversationId={selectedConversationId}
          processId={activeProcessId}
          selectedSegmentId={selectedArchiveSegmentId}
          onClose={() => setArchiveOpen(false)}
          onSelectSegment={setSelectedArchiveSegmentId}
        />
      ) : null}

      {bodyState === "chat" && controlError && controlError !== dismissedError ? (
        <div class="gsv-chat-control-alert">
          <Alert
            variant="error"
            icon="none"
            text={controlError}
            onDismiss={() => setDismissedError(controlError)}
          />
        </div>
      ) : null}

      {bodyState === "chat" && branchNotice ? (
        <div class="gsv-chat-control-alert">
          <Alert
            variant="success"
            text={branchNotice}
            onDismiss={() => setBranchNotice("")}
          />
        </div>
      ) : null}

      {bodyState !== "chat" ? null : <ChatTranscript
        activeRunId={runtime.activeRunId}
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
        conversationId={selectedConversationId}
        feedback={feedback.entries}
        hasOlderMessages={chatRuntime.hasOlderHistory}
        messages={transcriptMessages}
        loadingOlderMessages={chatRuntime.loadingOlderHistory}
        onLoadOlder={chatRuntime.loadOlderHistory}
        onBranch={branchFromMessage}
        onOpenReasoning={openReasoning}
        processId={activeProcessId}
        state={transcriptState}
      />}

      {bodyState === "chat" && pendingHil ? (
        <ChatApprovalBanner
          busy={hilDecision.isPending}
          pendingHil={pendingHil}
          onDecision={decidePendingHil}
        />
      ) : null}

      {bodyState !== "chat" ? null : <div class="gsv-chat-composer-lock">
      <MessageInput
        attachments={draftAttachments}
        busy={sendMessage.isPending || abortProcess.isPending || spawnProcess.isPending}
        canSend={hasActiveProcess || canStartProcess}
        cost={conversationCost}
        disabled={inputDisabled}
        focusKey={newTaskFocusKey}
        value={composerDraft}
        onChange={setComposerDraft}
        onFiles={handleFiles}
        onRemoveAttachment={removeAttachment}
        onSend={handleSendMessage}
        onStop={abortActiveRun}
        onVoiceClick={handleVoiceClick}
        placeholder={`Message ${activeAgent.name}...`}
        running={canAbortRun}
        user={userLabel}
        conversationMode={ambientTranscription.liveActive}
        onEndConversation={ambientTranscription.toggleLive}
        voiceActive={ambientTranscription.dictationActive || ambientTranscription.liveActive}
        voiceAction={(
          <Hint position="top-end" text={ambientTranscription.liveTitle}>
            <IconButton
              variant="floating"
              glyph="transcribe"
              size={26}
              className={`gsv-chat-live-icon${ambientTranscription.liveActive ? " is-active" : ""}`}
              ariaLabel={ambientTranscription.liveActive ? "End conversation" : "Start conversation"}
              disabled={ambientTranscription.liveUnavailable}
              onClick={ambientTranscription.toggleLive}
            />
          </Hint>
        )}
        voiceAvailableWhenBusy={ambientTranscription.active}
        voiceDisabled={ambientTranscription.liveActive
          ? false
          : ambientTranscription.dictationUnavailable}
        voiceTitle={voiceTitle}
      />
      {composerLocked ? (
        <div class="gsv-chat-composer-lock-bubble gsv-sublabel" role="status">
          {compactFailed ? (
            <>
              Context compression has failed -{" "}
              <button
                type="button"
                class="gsv-chat-inline-link"
                disabled={!canStartNewTask}
                onClick={prepareNewTask}
              >
                start a new task
              </button>
              {" "}to continue.
            </>
          ) : (
            "Wait for context compression to continue this conversation."
          )}
        </div>
      ) : null}
      </div>}
    </aside>
  );
}
