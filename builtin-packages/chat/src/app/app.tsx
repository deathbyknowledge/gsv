import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type {
  Attachment,
  ChatBackend,
  CompactDialogState,
  ContextState,
  ConversationRecord,
  HilRequest,
  LogRow,
  PendingAssistantState,
  ThreadContext,
  StageView,
} from "./types";
import {
  ArchiveWorkspace,
  ChatNavigator,
  CompactDialog,
  Composer,
  ConversationBar,
  ContextMeter,
  MobileProcessNav,
  Transcript,
} from "./components";
import { AgentAvatar } from "./components/navigation/AgentAvatar";
import {
  ArchiveIcon,
  CompactIcon,
  MoreIcon,
  TerminalIcon,
} from "./icons";
import {
  cleanupAttachmentPreview,
  revokeAttachmentPreview,
  stripAttachmentPreview,
} from "./domain/attachment-previews";
import { useArchive } from "./hooks/useArchive";
import { useChatCatalog } from "./hooks/useChatCatalog";
import { useMediaSources } from "./hooks/useMediaSources";
import { useProcessSignals } from "./hooks/useProcessSignals";
import { useTargetProcessEvent } from "./hooks/useTargetProcessEvent";
import { useTranscriptScroll } from "./hooks/useTranscriptScroll";
import { useVoiceRecorder } from "./hooks/useVoiceRecorder";
import {
  asNumber,
  asRecord,
  asString,
  activeMeta,
  closeChatMenus,
  closeContainingChatMenu,
  copyTextToClipboard,
  deriveThreadLabel,
  dropEmptyPlaceholder,
  draftConversationMeta,
  draftConversationTitle,
  flattenHistory,
  formatError,
  getStatusText,
  getStoredThreadContext,
  isInsideChatMenu,
  normalizeContextState,
  normalizeHilRequest,
  normalizeThreadContext,
  personalProfileLabel,
  readAttachmentFile,
  safeText,
  setStoredThreadContext,
  systemRow,
  systemRows,
  suggestKeepLast,
  titleForActive,
} from "./view-helpers";

const HISTORY_PAGE_SIZE = 50;
const DEFAULT_COMPOSER_DOCK_HEIGHT = 104;

function historyTargetKey(target: Pick<ThreadContext, "pid" | "conversationId">): string {
  return `${target.pid}\n${target.conversationId || "default"}`;
}

type HistoryWindow = {
  targetKey: string;
  oldestMessageId: number | null;
  newestMessageId: number | null;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
};

const EMPTY_HISTORY_WINDOW: HistoryWindow = {
  targetKey: "",
  oldestMessageId: null,
  newestMessageId: null,
  hasMoreBefore: false,
  loadingOlder: false,
};

function historyMessageIds(messages: unknown[]): { first: number | null; last: number | null } {
  const ids = messages
    .map((message) => asNumber(asRecord(message)?.id))
    .filter((id): id is number => typeof id === "number");
  return {
    first: ids[0] ?? null,
    last: ids[ids.length - 1] ?? null,
  };
}

export function App({ backend }: { backend: ChatBackend }) {
  const [active, setActiveState] = useState<ThreadContext | null>(() => getStoredThreadContext());
  const [stageView, setStageView] = useState<StageView>("chat");
  const [rows, setRows] = useState<LogRow[]>(() => systemRows("Connecting chat backend."));
  const [messageCount, setMessageCount] = useState(0);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>(EMPTY_HISTORY_WINDOW);
  const [contextState, setContextState] = useState<ContextState | null>(null);
  const [contextStatesByConversation, setContextStatesByConversation] = useState<Record<string, ContextState>>({});
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<PendingAssistantState>(null);
  const [pendingHil, setPendingHil] = useState<HilRequest | null>(null);
  const [messageBusy, setMessageBusy] = useState(false);
  const [abortBusy, setAbortBusy] = useState(false);
  const [hilBusy, setHilBusy] = useState(false);
  const [forceNewProcess, setForceNewProcess] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [branchBusy, setBranchBusy] = useState(false);
  const [composerDockNode, setComposerDockNode] = useState<HTMLDivElement | null>(null);
  const [composerDockHeight, setComposerDockHeight] = useState(DEFAULT_COMPOSER_DOCK_HEIGHT);
  const [hostError, setHostError] = useState("");
  const [composeText, setComposeText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [compactDialog, setCompactDialog] = useState<CompactDialogState>(null);
  const [notice, setNotice] = useState("");
  const [suppressNextAbortedComplete, setSuppressNextAbortedComplete] = useState(false);
  const activeRef = useRef(active);
  const mountedRef = useRef(true);
  const attachmentsRef = useRef(attachments);
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const skipNextHistoryLoadRef = useRef<string | null>(null);
  const autoHomeOpenRef = useRef(false);
  const historyWindowRef = useRef<HistoryWindow>(EMPTY_HISTORY_WINDOW);
  const {
    transcriptRef,
    setTranscriptContentNode,
    hasNewMessages,
    stickToBottomRef,
    clearNewMessages,
    prepareForLiveTranscriptActivity,
    handleTranscriptScroll,
    scrollTranscript,
    jumpToLatest,
  } = useTranscriptScroll();
  const {
    conversations,
    conversationProfiles,
    draftProfile,
    loadConversations,
    loadThreads,
    setDraftProfileId,
    threads,
    threadsError,
    threadsLoading,
    viewerUsername,
  } = useChatCatalog(backend);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useLayoutEffect(() => {
    const node = composerDockNode;
    if (!node) {
      return undefined;
    }
    const updateHeight = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      if (nextHeight > 0) {
        setComposerDockHeight((current) => current === nextHeight ? current : nextHeight);
      }
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [composerDockNode]);

  useLayoutEffect(() => {
    scrollTranscript("near-bottom");
  }, [composerDockHeight, scrollTranscript]);

  const activeConversationId = active?.conversationId || "default";
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
  const homeProfileLabel = personalProfileLabel(conversationProfiles);
  const homeProfile = conversationProfiles.find((profile) =>
    profile.spawnMode === "default" ||
    profile.id === "personal" ||
    profile.kind === "personal-agent"
  ) ?? null;
  const activeThread = active ? threads.find((thread) => thread.pid === active.pid) ?? null : null;
  const activeTitle = active ? titleForActive(active, activeConversation, threads, homeProfileLabel) : draftConversationTitle(draftProfile);
  const assistantLabel = active
    ? active.isHome
      ? homeProfile?.newProcessRunAs || homeProfile?.runAs || homeProfile?.displayName || homeProfileLabel
      : activeThread?.username || activeThread?.profile || activeThread?.label || activeTitle
    : draftProfile.runAs || draftProfile.newProcessRunAs || draftProfile.displayName;
  const stageAgentLabel = assistantLabel || activeTitle;
  const stageAgentSeed = active
    ? active.isHome
      ? homeProfile?.newProcessRunAs || homeProfile?.runAs || homeProfile?.id || stageAgentLabel
      : activeThread?.username || activeThread?.profile || active.pid
    : draftProfile.newProcessRunAs || draftProfile.runAs || draftProfile.id || stageAgentLabel;
  const stageProcessLabel = active ? activeMeta(active, activeConversation) : draftConversationMeta(draftProfile);
  const statusText = getStatusText({
    active,
    draftProfile,
    hostError,
    pendingAssistant,
    pendingHil,
    messageBusy,
    abortBusy,
    hilBusy,
  });
  const interactive = !hostError;
  const addVoiceAttachment = useCallback((attachment: Attachment) => {
    setAttachments((current) => current.concat(attachment));
  }, []);
  const {
    voice,
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    clearVoiceError,
  } = useVoiceRecorder({
    interactive,
    messageBusy,
    previewUrlsRef,
    onAttachment: addVoiceAttachment,
  });
  const hasDraft = composeText.trim().length > 0 || attachments.length > 0;
  const voiceActive = voice.status !== "idle";
  const runActive = activeRunId !== null || pendingAssistant !== null || pendingHil !== null;
  const runStateClass = hostError ? "is-error" : pendingHil ? "is-waiting" : runActive ? "is-running" : "is-ready";
  const runStateLabel = hostError ? "Error" : pendingHil ? "Approval" : runActive ? "Running" : "Ready";
  const canSend = interactive && !messageBusy && hasDraft && !voiceActive;
  const canStop = interactive && Boolean(active?.pid) && !abortBusy && runActive && !hasDraft && !voiceActive;
  const canActOnConversation = interactive && Boolean(active?.pid) && !messageBusy && pendingAssistant === null;

  const updateHistoryWindow = useCallback((next: HistoryWindow) => {
    historyWindowRef.current = next;
    setHistoryWindow(next);
  }, []);

  const updateNewestHistoryMessageId = useCallback((target: ThreadContext, newestMessageId: number) => {
    setHistoryWindow((current) => {
      if (current.targetKey !== historyTargetKey(target)) {
        return current;
      }
      const updated = { ...current, newestMessageId };
      historyWindowRef.current = updated;
      return updated;
    });
  }, []);

  const {
    archive,
    loadArchiveSegments,
    readArchiveSegment,
    resetArchive,
  } = useArchive({ backend, activeRef });

  const setActive = useCallback((next: ThreadContext | null) => {
    const previous = activeRef.current;
    const normalized = setStoredThreadContext(next);
    const processChanged = previous?.pid !== normalized?.pid;
    activeRef.current = normalized;
    setActiveState(normalized);
    if (normalized) {
      setForceNewProcess(false);
    }
    if (!normalized) {
      setContextState(null);
      setPendingHil(null);
      setPendingAssistant(null);
      setActiveRunId(null);
      setMessageCount(0);
      updateHistoryWindow(EMPTY_HISTORY_WINDOW);
      clearNewMessages();
      resetArchive();
    } else if (processChanged) {
      setContextState(null);
      setContextStatesByConversation({});
      setPendingHil(null);
      setPendingAssistant(null);
      setActiveRunId(null);
      setMessageCount(0);
      updateHistoryWindow(EMPTY_HISTORY_WINDOW);
      clearNewMessages();
      resetArchive();
    } else {
      setContextState((current) => {
        const cached = contextStatesByConversation[normalized.conversationId] ?? null;
        return cached ?? current;
      });
    }
    setStageView("chat");
    setNotice("");
  }, [clearNewMessages, contextStatesByConversation, resetArchive, updateHistoryWindow]);

  const appendSystem = useCallback((text: string) => {
    setRows((current) => dropEmptyPlaceholder(current).concat(systemRow(text)));
  }, []);

  const {
    mediaSources,
    mediaSourceErrors,
    loadMediaSource,
    retryMediaSource,
  } = useMediaSources({ backend, activeRef, mountedRef, appendSystem });

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      attachmentsRef.current.forEach(revokeAttachmentPreview);
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current.clear();
    };
  }, []);

  const loadHistory = useCallback(async (target = activeRef.current) => {
    if (!target?.pid) {
      setContextState(null);
      setContextStatesByConversation({});
      setMessageCount(0);
      updateHistoryWindow(EMPTY_HISTORY_WINDOW);
      clearNewMessages();
      setRows(systemRows("No thread selected. Send a message to start a new thread."));
      return;
    }

    try {
      const targetKey = historyTargetKey(target);
      updateHistoryWindow({ ...EMPTY_HISTORY_WINDOW, targetKey });
      const result = await backend.getHistory({
        pid: target.pid,
        conversationId: target.conversationId || "default",
        limit: HISTORY_PAGE_SIZE,
        tail: true,
      });
      const activeTarget = activeRef.current;
      if (!activeTarget || historyTargetKey(activeTarget) !== targetKey) {
        return;
      }
      const record = asRecord(result);
      if (!record?.ok) {
        setRows(systemRows("history error: " + safeText(record?.error || "unknown error")));
        return;
      }
      const messages = Array.isArray(record.messages) ? record.messages : [];
      const flattened = flattenHistory(messages);
      const ids = historyMessageIds(messages);
      const total = asNumber(record.messageCount) ?? messages.length;
      updateHistoryWindow({
        targetKey,
        oldestMessageId: ids.first,
        newestMessageId: ids.last,
        hasMoreBefore: record.hasMoreBefore === true,
        loadingOlder: false,
      });
      setMessageCount(total);
      const nextContext = normalizeContextState(record.context);
      setContextState(nextContext);
      setContextStatesByConversation((current) => {
        const conversationId = target.conversationId || "default";
        if (!nextContext) {
          if (!(conversationId in current)) {
            return current;
          }
          const nextStates = { ...current };
          delete nextStates[conversationId];
          return nextStates;
        }
        return { ...current, [conversationId]: nextContext };
      });
      const targetConversationId = target.conversationId || "default";
      const nextHil = normalizeHilRequest(record.pendingHil);
      const targetHil = nextHil?.conversationId === targetConversationId ? nextHil : null;
      const historyActiveRunId = asString(record.activeRunId);
      const historyActiveConversationId = asString(record.activeConversationId) || "default";
      const activeRunMatchesTarget = Boolean(historyActiveRunId)
        && historyActiveConversationId === targetConversationId;
      setPendingHil(targetHil);
      setActiveRunId(targetHil?.runId ?? (activeRunMatchesTarget ? historyActiveRunId : null));
      setPendingAssistant(targetHil ? null : activeRunMatchesTarget ? "thinking" : null);
      setRows(flattened);
      clearNewMessages();
      requestAnimationFrame(() => scrollTranscript("bottom"));
    } catch (error) {
      setRows(systemRows("history error: " + formatError(error)));
    }
  }, [backend, clearNewMessages, updateHistoryWindow]);

  const loadOlderHistory = useCallback(async () => {
    const target = activeRef.current;
    if (!target?.pid) {
      return;
    }
    const currentWindow = historyWindowRef.current;
    if (!currentWindow.hasMoreBefore || currentWindow.loadingOlder || currentWindow.oldestMessageId === null) {
      return;
    }
    const targetKey = historyTargetKey(target);
    if (currentWindow.targetKey !== targetKey) {
      return;
    }

    const node = transcriptRef.current;
    const previousScrollHeight = node?.scrollHeight ?? 0;
    const previousScrollTop = node?.scrollTop ?? 0;
    stickToBottomRef.current = false;
    updateHistoryWindow({ ...currentWindow, loadingOlder: true });

    try {
      const result = await backend.getHistory({
        pid: target.pid,
        conversationId: target.conversationId || "default",
        limit: HISTORY_PAGE_SIZE,
        beforeMessageId: currentWindow.oldestMessageId,
      });
      const activeTarget = activeRef.current;
      if (!activeTarget || historyTargetKey(activeTarget) !== targetKey) {
        return;
      }
      const record = asRecord(result);
      if (!record?.ok) {
        appendSystem("history error: " + safeText(record?.error || "unknown error"));
        updateHistoryWindow({ ...historyWindowRef.current, loadingOlder: false });
        return;
      }
      const messages = Array.isArray(record.messages) ? record.messages : [];
      const ids = historyMessageIds(messages);
      const olderRows = messages.length > 0 ? flattenHistory(messages) : [];
      setRows((current) => olderRows.concat(dropEmptyPlaceholder(current)));
      updateHistoryWindow({
        targetKey,
        oldestMessageId: ids.first ?? currentWindow.oldestMessageId,
        newestMessageId: currentWindow.newestMessageId,
        hasMoreBefore: record.hasMoreBefore === true,
        loadingOlder: false,
      });
      setMessageCount((current) => asNumber(record.messageCount) ?? current);
      requestAnimationFrame(() => {
        const nextNode = transcriptRef.current;
        if (!nextNode) {
          return;
        }
        nextNode.scrollTop = nextNode.scrollHeight - previousScrollHeight + previousScrollTop;
      });
    } catch (error) {
      const activeTarget = activeRef.current;
      if (!activeTarget || historyTargetKey(activeTarget) !== targetKey) {
        return;
      }
      appendSystem("history error: " + formatError(error));
      updateHistoryWindow({ ...historyWindowRef.current, loadingOlder: false });
    }
  }, [appendSystem, backend, updateHistoryWindow]);

  useEffect(() => {
    if (active?.pid) {
      const pid = active.pid;
      void backend.watchProcessSignals({ pid }).catch((error) => setHostError(formatError(error)));
      void loadConversations(active.pid);
      const historyKey = historyTargetKey(active);
      if (skipNextHistoryLoadRef.current === historyKey) {
        skipNextHistoryLoadRef.current = null;
      } else {
        void loadHistory(active);
      }
      return () => {
        void backend.unwatchProcessSignals({ pid }).catch(() => {});
      };
    }
    void backend.unwatchProcessSignals({ pid: "" }).catch(() => {});
    void loadConversations("");
    setRows(systemRows(draftConversationMeta(draftProfile)));
    return undefined;
  }, [active?.pid, active?.conversationId, backend, draftProfile, loadConversations, loadHistory]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent): void {
      if (!isInsideChatMenu(event.target)) {
        closeChatMenus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  useTargetProcessEvent(setActive);

  useEffect(() => {
    if (active || forceNewProcess || hostError || autoHomeOpenRef.current) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (activeRef.current || forceNewProcess || autoHomeOpenRef.current) {
        return;
      }
      autoHomeOpenRef.current = true;
      void openHome();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, forceNewProcess, hostError, homeProfileLabel]);

  useProcessSignals({
    activeRef,
    appendSystem,
    loadArchiveSegments,
    loadConversations,
    loadHistory,
    loadThreads,
    onContextMessageId: updateNewestHistoryMessageId,
    prepareForLiveTranscriptActivity,
    setContextState,
    setContextStatesByConversation,
    setMessageCount,
    setActiveRunId,
    setPendingAssistant,
    setPendingHil,
    setRows,
    setSuppressNextAbortedComplete,
    suppressNextAbortedComplete,
    stageView,
  });

  useLayoutEffect(() => {
    scrollTranscript("near-bottom");
  }, [rows, pendingAssistant, pendingHil, scrollTranscript]);

  async function openHome(): Promise<void> {
    setNotice("");
    try {
      const result = await backend.spawnProcess({
        label: homeProfileLabel,
      });
      const record = asRecord(result);
      if (!record?.ok) {
        appendSystem("home open failed: " + safeText(record?.error || "unknown error"));
        return;
      }
      setActive(normalizeThreadContext({
        pid: record.pid,
        cwd: record.cwd,
        conversationId: "default",
        isHome: true,
      }));
    } catch (error) {
      appendSystem("home open failed: " + formatError(error));
    }
  }

  async function openThread(pid: string): Promise<void> {
    const entry = threads.find((candidate) => candidate.pid === pid);
    if (!entry) {
      appendSystem("process not found: " + pid);
      return;
    }
    setActive(normalizeThreadContext({
      pid: entry.pid,
      cwd: entry.cwd,
      conversationId: "default",
    }));
  }

  function resetToNewThread(): void {
    cancelVoiceRecording();
    setForceNewProcess(true);
    setActive(null);
    setComposeText("");
    setAttachments((current) => {
      current.forEach((attachment) => cleanupAttachmentPreview(attachment, previewUrlsRef.current));
      return [];
    });
    setStageView("chat");
  }

  async function switchConversation(conversation: ConversationRecord): Promise<void> {
    if (!active) {
      return;
    }
    setActive({
      ...active,
      conversationId: conversation.id,
      conversationTitle: conversation.title,
    });
    setStageView("chat");
  }

  async function sendMessage(): Promise<void> {
    if (voice.status !== "idle") {
      return;
    }
    const message = composeText.trim();
    const media = attachments.map(stripAttachmentPreview);
    if (!message && media.length === 0) {
      return;
    }
    setMessageBusy(true);
    setNotice("");
    try {
      let target = activeRef.current;
      if (!target?.pid) {
        const runAs = draftProfile.runAs ?? (forceNewProcess ? draftProfile.newProcessRunAs : undefined);
        // Default personal-agent drafts use the default conversation. Explicit
        // New Process can still start a fresh personal-agent process.
        const spawnResult = await backend.spawnProcess(
          runAs
            ? {
                runAs,
                label: deriveThreadLabel(message) || draftProfile.displayName,
              }
            : { label: draftProfile.displayName },
        );
        const record = asRecord(spawnResult);
        if (!record?.ok) {
          appendSystem("thread start failed: " + safeText(record?.error || "unknown error"));
          return;
        }
        target = normalizeThreadContext({
          pid: record.pid,
          cwd: record.cwd,
          conversationId: "default",
          isHome: !runAs,
        });
        if (!target) {
          appendSystem("thread start failed: invalid process target");
          return;
        }
        skipNextHistoryLoadRef.current = historyTargetKey(target);
        setActive(target);
        await backend.watchProcessSignals({ pid: target.pid }).catch((error) => setHostError(formatError(error)));
        void loadThreads();
      }
      if (!target?.pid) {
        appendSystem("thread start failed: missing process id");
        return;
      }
      const optimisticTimestamp = Date.now();
      setRows((current) => dropEmptyPlaceholder(current).concat({
        kind: "message",
        role: "user",
        text: message,
        media,
        timestamp: optimisticTimestamp,
      }));
      setComposeText("");
      setAttachments((current) => {
        current.forEach((attachment) => cleanupAttachmentPreview(attachment, previewUrlsRef.current));
        return [];
      });
      const result = await backend.sendMessage({
        message,
        pid: target.pid,
        conversationId: target.conversationId || "default",
        ...(media.length > 0 ? { media } : {}),
      });
      const record = asRecord(result);
      if (!record?.ok) {
        appendSystem("send failed: " + safeText(record?.error || "unknown error"));
        return;
      }
      const runId = asString(record.runId);
      if (runId) {
        setRows((current) => current.map((row) => (
          row.kind === "message"
          && row.role === "user"
          && row.timestamp === optimisticTimestamp
          && !row.runId
            ? { ...row, runId }
            : row
        )));
        if (record.queued !== true) {
          setActiveRunId(runId);
        }
      }
      if (record.queued !== true) {
        setPendingAssistant("thinking");
      }
      if (record.queued === true) {
        appendSystem("message queued while process is busy");
      }
    } catch (error) {
      appendSystem("send failed: " + formatError(error));
    } finally {
      setMessageBusy(false);
    }
  }

  async function abortActiveRun(): Promise<void> {
    const target = activeRef.current;
    if (!target?.pid || abortBusy) {
      return;
    }
    setAbortBusy(true);
    try {
      const result = await backend.abortRun({ pid: target.pid });
      const record = asRecord(result);
      if (!record?.ok) {
        appendSystem("stop failed");
        return;
      }
      if (record.aborted === true) {
        setPendingHil(null);
        if (record.continuedQueuedRunId) {
          setSuppressNextAbortedComplete(true);
          setActiveRunId(asString(record.continuedQueuedRunId));
          setPendingAssistant("thinking");
        } else {
          setActiveRunId(null);
          setPendingAssistant(null);
          appendSystem("run interrupted");
        }
      }
    } catch (error) {
      appendSystem("stop failed: " + formatError(error));
    } finally {
      setAbortBusy(false);
    }
  }

  async function decidePendingHil(requestId: string, decision: "approve" | "deny", remember = false): Promise<void> {
    const target = activeRef.current;
    if (!target?.pid || !pendingHil || pendingHil.requestId !== requestId || hilBusy) {
      return;
    }
    setHilBusy(true);
    try {
      const result = await backend.decideHil({ pid: target.pid, requestId, decision, remember });
      const record = asRecord(result);
      if (!record?.ok) {
        appendSystem("tool confirmation failed");
        return;
      }
      const nextHil = normalizeHilRequest(record.pendingHil);
      setPendingHil(nextHil);
      setActiveRunId(nextHil?.runId ?? activeRunId);
      if (!nextHil) {
        setPendingAssistant("thinking");
      }
    } catch (error) {
      appendSystem("tool confirmation failed: " + formatError(error));
    } finally {
      setHilBusy(false);
    }
  }

  function openCompactDialog(): void {
    const suggested = suggestKeepLast(messageCount, contextState);
    setCompactDialog({ keepLast: String(suggested), suggested });
  }

  async function compactActiveConversation(): Promise<void> {
    const target = activeRef.current;
    if (!target?.pid || !compactDialog) {
      return;
    }
    const keepLast = Number.parseInt(compactDialog.keepLast.trim(), 10);
    if (!Number.isInteger(keepLast) || keepLast < 0) {
      setNotice("Keep-last must be a non-negative integer.");
      return;
    }
    setCompactBusy(true);
    setNotice("");
    try {
      const result = await backend.compactConversation({
        pid: target.pid,
        conversationId: target.conversationId || "default",
        keepLast,
      });
      const record = asRecord(result);
      if (!record?.ok) {
        appendSystem("compact failed: " + safeText(record?.error || "unknown error"));
        return;
      }
      setCompactDialog(null);
      appendSystem("conversation compacted: " + safeText(record.archivedMessages) + " messages archived");
      await loadHistory(target);
      await loadConversations(target.pid);
      await loadArchiveSegments(true);
    } catch (error) {
      appendSystem("compact failed: " + formatError(error));
    } finally {
      setCompactBusy(false);
    }
  }

  async function branchFromMessage(messageId: number): Promise<void> {
    const target = activeRef.current;
    if (!target?.pid || !messageId) {
      return;
    }
    setBranchBusy(true);
    setNotice("");
    try {
      const title = "Branch from message " + messageId;
      const result = await backend.forkConversation({
        pid: target.pid,
        conversationId: target.conversationId || "default",
        throughMessageId: messageId,
        targetConversationId: "branch-" + Date.now().toString(36),
        title,
      });
      const record = asRecord(result);
      if (!record?.ok) {
        appendSystem("branch failed: " + safeText(record?.error || "unknown error"));
        return;
      }
      const targetConversation = asRecord(record.targetConversation);
      const nextConversationId = asString(targetConversation?.id) || "default";
      const nextTitle = asString(targetConversation?.title) || title;
      setActive({
        ...target,
        conversationId: nextConversationId,
        conversationTitle: nextTitle,
      });
      setStageView("chat");
      setNotice("Created and opened " + nextTitle + " from message " + messageId + ".");
      await loadConversations(target.pid);
    } catch (error) {
      appendSystem("branch failed: " + formatError(error));
    } finally {
      setBranchBusy(false);
    }
  }

  function toggleArchiveView(): void {
    if (stageView === "archive") {
      setStageView("chat");
      return;
    }
    setStageView("archive");
    void loadArchiveSegments(true);
  }

  async function copyText(label: string, text: string): Promise<void> {
    try {
      await copyTextToClipboard(text);
      setNotice("Copied " + label + ".");
    } catch (error) {
      appendSystem("copy failed: " + formatError(error));
    }
  }

  async function readAttachments(files: FileList | null): Promise<void> {
    const selected = Array.from(files || []);
    if (selected.length === 0) {
      return;
    }
    try {
      const next = await Promise.all(selected.map(readAttachmentFile));
      setAttachments((current) => current.concat(next));
    } catch (error) {
      appendSystem("attachment read failed: " + formatError(error));
    }
  }

  function removeAttachment(index: number): void {
    setAttachments((current) => {
      const removed = current[index];
      if (removed) {
        cleanupAttachmentPreview(removed, previewUrlsRef.current);
      }
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  }

  return (
    <main class="chat-app">
      <ChatNavigator
        active={active}
        threads={threads}
        threadsLoading={threadsLoading}
        threadsError={threadsError}
        profiles={conversationProfiles}
        homeLabel={homeProfileLabel}
        draftProfileId={draftProfile.id}
        onDraftProfileChange={setDraftProfileId}
        onHome={() => void openHome()}
        onNew={resetToNewThread}
        onOpenThread={(pid) => void openThread(pid)}
      />

      <section class={"chat-stage" + (stageView === "archive" ? " is-archive" : "")}>
        <header class="chat-stage-head">
          <MobileProcessNav
            active={active}
            threads={threads}
            threadsLoading={threadsLoading}
            threadsError={threadsError}
            profiles={conversationProfiles}
            homeLabel={homeProfileLabel}
            draftProfileId={draftProfile.id}
            onDraftProfileChange={setDraftProfileId}
            onHome={() => void openHome()}
            onNew={resetToNewThread}
            onOpenThread={(pid) => void openThread(pid)}
          />
          <div class="chat-stage-title">
            <AgentAvatar seed={stageAgentSeed} label={stageAgentLabel} />
            <div class="chat-stage-title-main">
              <div class="chat-stage-title-line">
                <h1>{stageAgentLabel}</h1>
                <span class={"stage-run-state " + runStateClass} title={`${runStateLabel}: ${statusText}`} aria-label={`${runStateLabel}: ${statusText}`}>
                  {runStateClass !== "is-ready" ? <span>{runStateLabel}</span> : null}
                </span>
              </div>
              <p class="stage-process-label">{stageProcessLabel}</p>
            </div>
            <ConversationBar
              active={active}
              activeConversationId={activeConversationId}
              conversations={conversations}
              onSelect={(conversation) => void switchConversation(conversation)}
            />
          </div>
          <div class="chat-stage-actions">
            <ContextMeter state={active ? contextState : null} />
            <details class="process-menu">
              <summary class="icon-button" title="Process actions" aria-label="Process actions" onClick={(event) => {
                closeChatMenus((event.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null);
              }}>
                <MoreIcon />
              </summary>
              <div class="process-menu-popover">
                <button type="button" class="menu-action" disabled={!active} onClick={(event) => { closeContainingChatMenu(event.currentTarget); toggleArchiveView(); }}>
                  <ArchiveIcon />
                  <span>{stageView === "archive" ? "Return to chat" : archive.segments.length > 0 ? `Open archive (${archive.segments.length})` : "Open archive"}</span>
                </button>
                <button type="button" class="menu-action" disabled={!active} onClick={(event) => {
                  closeContainingChatMenu(event.currentTarget);
                  if (active) void copyText("process id", active.pid);
                }}>
                  <TerminalIcon />
                  <span>Copy process ID</span>
                </button>
                <button type="button" class="menu-action" disabled={!canActOnConversation || compactBusy} onClick={(event) => { closeContainingChatMenu(event.currentTarget); openCompactDialog(); }}>
                  <CompactIcon />
                  <span>{compactBusy ? "Compacting..." : "Compact"}</span>
                </button>
              </div>
            </details>
          </div>
        </header>

        <div class={"chat-notice-row" + (!notice ? " is-empty" : "")}>
          {notice ? <span class="chat-notice">{notice}</span> : null}
        </div>

        {stageView === "archive" ? (
          <ArchiveWorkspace
            archive={archive}
            userLabel={viewerUsername}
            assistantLabel={assistantLabel}
            mediaSources={mediaSources}
            mediaSourceErrors={mediaSourceErrors}
            onRefresh={() => void loadArchiveSegments(true)}
            onSelect={(segmentId) => void readArchiveSegment(segmentId)}
            onLoadMediaSource={loadMediaSource}
            onRetryMediaSource={retryMediaSource}
          />
        ) : (
          <div
            class="chat-live-area"
            style={`--chat-composer-inset: ${composerDockHeight}px;`}
          >
            <Transcript
              rows={rows}
              userLabel={viewerUsername}
              assistantLabel={assistantLabel}
              activeRunId={activeRunId}
              pendingAssistant={pendingAssistant}
              pendingHil={pendingHil}
              hasOlderHistory={historyWindow.hasMoreBefore}
              loadingOlderHistory={historyWindow.loadingOlder}
              hasNewMessages={hasNewMessages}
              hilBusy={hilBusy}
              branchBusy={branchBusy}
              refNode={transcriptRef}
              onContentNode={setTranscriptContentNode}
              mediaSources={mediaSources}
              mediaSourceErrors={mediaSourceErrors}
              onCopy={(text) => void copyText("message", text)}
              onBranch={(messageId) => void branchFromMessage(messageId)}
              onHilDecision={(requestId, decision, remember) => void decidePendingHil(requestId, decision, remember)}
              onLoadOlderHistory={() => void loadOlderHistory()}
              onJumpToLatest={jumpToLatest}
              onViewedLatest={handleTranscriptScroll}
              onLoadMediaSource={loadMediaSource}
              onRetryMediaSource={retryMediaSource}
            />

            <div class="composer-dock" ref={setComposerDockNode}>
              <Composer
                value={composeText}
                attachments={attachments}
                disabled={!interactive || messageBusy}
                canSend={canSend}
                canStop={canStop}
                stopBusy={abortBusy}
                voice={voice}
                canRecord={interactive && !messageBusy}
                onValueChange={setComposeText}
                onSubmit={() => void sendMessage()}
                onStop={() => void abortActiveRun()}
                onFiles={(files) => void readAttachments(files)}
                onRemoveAttachment={removeAttachment}
                onStartVoice={() => void startVoiceRecording()}
                onStopVoice={stopVoiceRecording}
                onCancelVoice={cancelVoiceRecording}
                onClearVoiceError={clearVoiceError}
              />
            </div>
          </div>
        )}
      </section>

      {compactDialog ? (
        <CompactDialog
          value={compactDialog.keepLast}
          messageCount={messageCount}
          compactBusy={compactBusy}
          onChange={(keepLast) => setCompactDialog({ ...compactDialog, keepLast })}
          onCancel={() => setCompactDialog(null)}
          onConfirm={() => void compactActiveConversation()}
        />
      ) : null}
    </main>
  );
}
