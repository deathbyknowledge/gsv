import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { onAppEvent } from "@gsv/package/browser";
import { openApp } from "@gsv/package/host";
import type {
  ArchiveState,
  Attachment,
  ChatBackend,
  CompactDialogState,
  ContextState,
  ConversationRecord,
  ConversationSegment,
  HilRequest,
  LogRow,
  PendingAssistantState,
  Profile,
  ThreadContext,
  VoiceRecordingState,
  WorkspaceView,
  WorkspaceEntry,
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
import {
  CompactIcon,
  FolderIcon,
  MoreIcon,
  TerminalIcon,
} from "./icons";
import {
  applyAssistantSignal,
  applyProcessMessageSignal,
  applyToolCallSignal,
  applyToolResultSignal,
  asNumber,
  asRecord,
  asString,
  closeChatMenus,
  closeContainingChatMenu,
  copyTextToClipboard,
  deriveThreadLabel,
  dropEmptyPlaceholder,
  draftConversationMeta,
  draftConversationTitle,
  fallbackProfiles,
  flattenHistory,
  formatError,
  getStatusText,
  getStoredThreadContext,
  isInsideChatMenu,
  isNearBottom,
  normalizeContextSignal,
  normalizeContextState,
  normalizeConversation,
  normalizeConversationSegment,
  normalizeHilRequest,
  normalizeProfile,
  normalizeThreadContext,
  normalizeWorkspace,
  readAttachmentBlob,
  readAttachmentFile,
  safeText,
  setStoredThreadContext,
  signalMatchesActiveThread,
  sortConversations,
  systemRow,
  systemRows,
  suggestKeepLast,
  titleForActive,
} from "./view-helpers";

const TARGET_CHAT_PROCESS_EVENT = "gsv:target-chat-process";
const PENDING_TARGETS_KEY = "__gsvPendingChatProcessTargets";
const WINDOW_ID = new URL(window.location.href).searchParams.get("windowId")?.trim() || "";
const HISTORY_PAGE_SIZE = 50;

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

const EMPTY_ARCHIVE: ArchiveState = {
  loading: false,
  error: "",
  segments: [],
  selectedSegmentId: null,
  messages: [],
  messageCount: 0,
  truncated: false,
};

const EMPTY_VOICE_RECORDING: VoiceRecordingState = { status: "idle", elapsedMs: 0 };
const VOICE_AUDIO_BITS_PER_SECOND = 128000;
const MAX_VOICE_RECORDING_MS = 10 * 60 * 1000;
const VOICE_RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
];

function canUseBrowserVoiceRecorder(): boolean {
  return typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== "undefined";
}

async function requestVoiceStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}

function selectVoiceRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return VOICE_RECORDER_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

function extensionForVoiceMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/mp4" || normalized === "audio/aac") return "m4a";
  if (normalized === "audio/wav" || normalized === "audio/wave" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/mpeg") return "mp3";
  return "webm";
}

function voiceRecordingFilename(mimeType: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `voice-${stamp}.${extensionForVoiceMimeType(mimeType)}`;
}

function stripAttachmentPreview(attachment: Attachment): Attachment {
  const next = { ...attachment };
  delete next.previewUrl;
  return next;
}

function revokeAttachmentPreview(attachment: Attachment): void {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

function cleanupAttachmentPreview(attachment: Attachment, previewUrls: Set<string>): void {
  revokeAttachmentPreview(attachment);
  if (attachment.previewUrl) {
    previewUrls.delete(attachment.previewUrl);
  }
}

function mediaSourceKey(media: unknown): string | null {
  const record = asRecord(media);
  return asString(record?.key);
}

function mediaOwnerPidFromKey(key: string): string | null {
  const match = /^var\/media\/[^/]+\/(.+)\/[^/]+$/.exec(key);
  return match?.[1] || null;
}

function removeRecordKey(record: Record<string, string>, key: string): Record<string, string> {
  if (!(key in record)) {
    return record;
  }
  const next = { ...record };
  delete next[key];
  return next;
}

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
  const [profiles, setProfiles] = useState<Profile[]>(() => fallbackProfiles());
  const [draftProfileId, setDraftProfileId] = useState("task");
  const [viewerUsername, setViewerUsername] = useState("You");
  const [threads, setThreads] = useState<WorkspaceEntry[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState("");
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationError, setConversationError] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
  const [rows, setRows] = useState<LogRow[]>(() => systemRows("Connecting chat backend."));
  const [messageCount, setMessageCount] = useState(0);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>(EMPTY_HISTORY_WINDOW);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [contextState, setContextState] = useState<ContextState | null>(null);
  const [contextStatesByConversation, setContextStatesByConversation] = useState<Record<string, ContextState>>({});
  const [pendingAssistant, setPendingAssistant] = useState<PendingAssistantState>(null);
  const [pendingHil, setPendingHil] = useState<HilRequest | null>(null);
  const [messageBusy, setMessageBusy] = useState(false);
  const [abortBusy, setAbortBusy] = useState(false);
  const [hilBusy, setHilBusy] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [branchBusy, setBranchBusy] = useState(false);
  const [hostError, setHostError] = useState("");
  const [composeText, setComposeText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [voice, setVoice] = useState<VoiceRecordingState>(EMPTY_VOICE_RECORDING);
  const [mediaSources, setMediaSources] = useState<Record<string, string>>({});
  const [mediaSourceErrors, setMediaSourceErrors] = useState<Record<string, string>>({});
  const [archive, setArchive] = useState<ArchiveState>(EMPTY_ARCHIVE);
  const [compactDialog, setCompactDialog] = useState<CompactDialogState>(null);
  const [notice, setNotice] = useState("");
  const [suppressNextAbortedComplete, setSuppressNextAbortedComplete] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const mountedRef = useRef(true);
  const attachmentsRef = useRef(attachments);
  const mediaSourcesRef = useRef(mediaSources);
  const mediaSourceLoadingRef = useRef<Set<string>>(new Set());
  const mediaSourceFailedRef = useRef<Set<string>>(new Set());
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recorderStartedAtRef = useRef(0);
  const recorderElapsedMsRef = useRef(0);
  const recorderTimerRef = useRef<number | null>(null);
  const recorderCancelRef = useRef(false);
  const skipNextHistoryLoadRef = useRef<string | null>(null);
  const historyWindowRef = useRef<HistoryWindow>(EMPTY_HISTORY_WINDOW);
  const hasNewMessagesRef = useRef(false);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    mediaSourcesRef.current = mediaSources;
  }, [mediaSources]);

  const conversationProfiles = useMemo(
    () => profiles.filter((profile) => profile.interactive === true && profile.startable === true),
    [profiles],
  );
  const newConversationProfiles = useMemo(
    () => conversationProfiles.filter((profile) => profile.spawnMode === "new"),
    [conversationProfiles],
  );
  const draftProfile = useMemo(() => {
    return conversationProfiles.find((profile) => profile.id === draftProfileId || profile.alias === draftProfileId)
      ?? newConversationProfiles[0]
      ?? conversationProfiles.find((profile) => profile.id === "task")
      ?? fallbackProfiles()[1];
  }, [conversationProfiles, draftProfileId, newConversationProfiles]);
  const voiceRecorderAvailable = useMemo(() => canUseBrowserVoiceRecorder(), []);

  const activeConversationId = active?.conversationId || "default";
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
  const activeTitle = active ? titleForActive(active, activeConversation, threads) : draftConversationTitle(draftProfile);
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
  const hasDraft = composeText.trim().length > 0 || attachments.length > 0;
  const voiceActive = voice.status !== "idle";
  const runActive = pendingAssistant !== null || pendingHil !== null;
  const runStateClass = hostError ? "is-error" : pendingHil ? "is-waiting" : runActive ? "is-running" : "is-ready";
  const runStateLabel = hostError ? "Error" : pendingHil ? "Approval" : runActive ? "Running" : "Ready";
  const canSend = interactive && !messageBusy && hasDraft && !voiceActive;
  const canStop = interactive && Boolean(active?.pid) && !abortBusy && runActive && !hasDraft && !voiceActive;
  const canActOnConversation = interactive && Boolean(active?.pid) && !messageBusy && pendingAssistant === null;

  const updateHistoryWindow = useCallback((next: HistoryWindow) => {
    historyWindowRef.current = next;
    setHistoryWindow(next);
  }, []);

  const clearNewMessages = useCallback(() => {
    if (!hasNewMessagesRef.current) {
      return;
    }
    hasNewMessagesRef.current = false;
    setHasNewMessages(false);
  }, []);

  const prepareForLiveTranscriptActivity = useCallback(() => {
    const node = transcriptRef.current;
    const atBottom = !node || isNearBottom(node);
    stickToBottomRef.current = atBottom;
    if (atBottom || hasNewMessagesRef.current) {
      return;
    }
    hasNewMessagesRef.current = true;
    setHasNewMessages(true);
  }, []);

  const handleTranscriptScroll = useCallback((node: HTMLElement) => {
    const atBottom = isNearBottom(node);
    stickToBottomRef.current = atBottom;
    if (atBottom) {
      clearNewMessages();
    }
  }, [clearNewMessages]);

  const setActive = useCallback((next: ThreadContext | null) => {
    const previous = activeRef.current;
    const normalized = setStoredThreadContext(next);
    const processChanged = previous?.pid !== normalized?.pid;
    activeRef.current = normalized;
    setActiveState(normalized);
    if (!normalized) {
      setContextState(null);
      setPendingHil(null);
      setPendingAssistant(null);
      setMessageCount(0);
      updateHistoryWindow(EMPTY_HISTORY_WINDOW);
      clearNewMessages();
      setArchive(EMPTY_ARCHIVE);
    } else if (processChanged) {
      setContextState(null);
      setContextStatesByConversation({});
      setPendingHil(null);
      setPendingAssistant(null);
      setMessageCount(0);
      updateHistoryWindow(EMPTY_HISTORY_WINDOW);
      clearNewMessages();
      setArchive(EMPTY_ARCHIVE);
    } else {
      setContextState((current) => {
        const cached = contextStatesByConversation[normalized.conversationId] ?? null;
        return cached ?? current;
      });
    }
    setWorkspaceView("chat");
    setNotice("");
  }, [clearNewMessages, contextStatesByConversation, updateHistoryWindow]);

  const appendSystem = useCallback((text: string) => {
    setRows((current) => dropEmptyPlaceholder(current).concat(systemRow(text)));
  }, []);

  const clearVoiceTimer = useCallback(() => {
    if (recorderTimerRef.current !== null) {
      window.clearInterval(recorderTimerRef.current);
      recorderTimerRef.current = null;
    }
  }, []);

  const stopVoiceStream = useCallback(() => {
    const stream = recorderStreamRef.current;
    recorderStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const cleanupVoiceRecorder = useCallback(() => {
    clearVoiceTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // Recorder state can change between the state check and stop call.
      }
    }
    stopVoiceStream();
    recorderRef.current = null;
    recorderChunksRef.current = [];
    recorderStartedAtRef.current = 0;
    recorderElapsedMsRef.current = 0;
  }, [clearVoiceTimer, stopVoiceStream]);

  const finishVoiceRecording = useCallback(async () => {
    clearVoiceTimer();
    const recorder = recorderRef.current;
    const chunks = recorderChunksRef.current.slice();
    const cancelled = recorderCancelRef.current;
    const startedAt = recorderStartedAtRef.current;
    const elapsedMs = Math.max(recorderElapsedMsRef.current, startedAt > 0 ? Date.now() - startedAt : 0);
    const mimeType = recorder?.mimeType || chunks.find((chunk) => chunk.type)?.type || "audio/webm";
    cleanupVoiceRecorder();
    recorderCancelRef.current = false;

    if (!mountedRef.current) {
      return;
    }
    if (cancelled) {
      setVoice(EMPTY_VOICE_RECORDING);
      return;
    }

    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
      setVoice({ status: "idle", elapsedMs: 0, error: "No audio was captured." });
      return;
    }

    const previewUrl = URL.createObjectURL(blob);
    previewUrlsRef.current.add(previewUrl);
    try {
      const attachment = await readAttachmentBlob(blob, voiceRecordingFilename(mimeType), elapsedMs / 1000);
      if (!mountedRef.current) {
        URL.revokeObjectURL(previewUrl);
        previewUrlsRef.current.delete(previewUrl);
        return;
      }
      setAttachments((current) => current.concat({ ...attachment, type: "audio", previewUrl }));
      setVoice(EMPTY_VOICE_RECORDING);
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      previewUrlsRef.current.delete(previewUrl);
      if (mountedRef.current) {
        setVoice({ status: "idle", elapsedMs: 0, error: "Voice read failed: " + formatError(error) });
      }
    }
  }, [cleanupVoiceRecorder, clearVoiceTimer]);

  const stopVoiceRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    const startedAt = recorderStartedAtRef.current;
    const elapsedMs = Math.max(recorderElapsedMsRef.current, startedAt > 0 ? Date.now() - startedAt : 0);
    recorderElapsedMsRef.current = elapsedMs;
    setVoice({ status: "processing", elapsedMs });
    recorder.stop();
  }, []);

  const cancelVoiceRecording = useCallback(() => {
    recorderCancelRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }
    cleanupVoiceRecorder();
    setVoice(EMPTY_VOICE_RECORDING);
  }, [cleanupVoiceRecorder]);

  const startVoiceRecording = useCallback(async () => {
    if (!interactive || messageBusy || voice.status !== "idle") {
      return;
    }
    if (!voiceRecorderAvailable) {
      setVoice({ status: "idle", elapsedMs: 0, error: "Voice recording is not available in this browser." });
      return;
    }

    cleanupVoiceRecorder();
    recorderCancelRef.current = false;
    recorderChunksRef.current = [];
    setVoice({ status: "requesting", elapsedMs: 0 });

    try {
      const stream = await requestVoiceStream();
      if (!mountedRef.current || recorderCancelRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        recorderCancelRef.current = false;
        if (mountedRef.current) {
          setVoice(EMPTY_VOICE_RECORDING);
        }
        return;
      }
      const mimeType = selectVoiceRecorderMimeType();
      const options: MediaRecorderOptions = { audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND };
      if (mimeType) {
        options.mimeType = mimeType;
      }
      const recorder = new MediaRecorder(stream, options);
      recorderRef.current = recorder;
      recorderStreamRef.current = stream;
      recorderStartedAtRef.current = Date.now();
      recorderElapsedMsRef.current = 0;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recorderChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        recorderCancelRef.current = true;
        cleanupVoiceRecorder();
        setVoice({ status: "idle", elapsedMs: 0, error: "Voice recording failed." });
      };
      recorder.onstop = () => {
        void finishVoiceRecording();
      };

      recorder.start(1000);
      recorderTimerRef.current = window.setInterval(() => {
        const elapsedMs = Date.now() - recorderStartedAtRef.current;
        recorderElapsedMsRef.current = elapsedMs;
        setVoice((current) => current.status === "recording" ? { ...current, elapsedMs } : current);
        if (elapsedMs >= MAX_VOICE_RECORDING_MS && recorderRef.current?.state === "recording") {
          setVoice({ status: "processing", elapsedMs });
          recorderRef.current.stop();
        }
      }, 250);
      setVoice({ status: "recording", elapsedMs: 0 });
    } catch (error) {
      cleanupVoiceRecorder();
      recorderCancelRef.current = false;
      if (mountedRef.current) {
        setVoice({ status: "idle", elapsedMs: 0, error: "Microphone failed: " + formatError(error) });
      }
    }
  }, [cleanupVoiceRecorder, finishVoiceRecording, interactive, messageBusy, voice.status, voiceRecorderAvailable]);

  const clearVoiceError = useCallback(() => {
    setVoice(EMPTY_VOICE_RECORDING);
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      recorderCancelRef.current = true;
      cleanupVoiceRecorder();
      attachmentsRef.current.forEach(revokeAttachmentPreview);
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current.clear();
    };
  }, [cleanupVoiceRecorder]);

  const loadViewer = useCallback(async () => {
    try {
      const result = await backend.getViewer({});
      const username = asString(asRecord(result)?.username)?.trim();
      setViewerUsername(username || "You");
    } catch {
      setViewerUsername("You");
    }
  }, [backend]);

  const loadProfiles = useCallback(async () => {
    try {
      const result = await backend.listProfiles({});
      const profileRows = Array.isArray(asRecord(result)?.profiles) ? asRecord(result)?.profiles as unknown[] : [];
      const normalized = profileRows.map(normalizeProfile).filter(Boolean) as Profile[];
      setProfiles(normalized.length > 0 ? normalized : fallbackProfiles());
    } catch {
      setProfiles(fallbackProfiles());
    }
  }, [backend]);

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true);
    setThreadsError("");
    try {
      const result = await backend.listWorkspaces({ kind: "thread", limit: 64 });
      const workspaceRows = Array.isArray(asRecord(result)?.workspaces) ? asRecord(result)?.workspaces as unknown[] : [];
      setThreads(workspaceRows.map(normalizeWorkspace).filter(Boolean) as WorkspaceEntry[]);
    } catch (error) {
      setThreads([]);
      setThreadsError(formatError(error));
    } finally {
      setThreadsLoading(false);
    }
  }, [backend]);

  const loadConversations = useCallback(async (pid = activeRef.current?.pid || "") => {
    if (!pid) {
      setConversations([]);
      return;
    }
    setConversationsLoading(true);
    setConversationError("");
    try {
      const result = await backend.listConversations({ pid });
      const conversationRows = Array.isArray(asRecord(result)?.conversations)
        ? asRecord(result)?.conversations as unknown[]
        : [];
      setConversations(sortConversations(conversationRows.map(normalizeConversation).filter(Boolean) as ConversationRecord[]));
    } catch (error) {
      setConversations([]);
      setConversationError(formatError(error));
    } finally {
      setConversationsLoading(false);
    }
  }, [backend]);

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
      setPendingHil(normalizeHilRequest(record.pendingHil));
      setPendingAssistant(null);
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

  const loadArchiveSegments = useCallback(async (preserveSelection = true) => {
    const target = activeRef.current;
    if (!target?.pid) {
      setArchive(EMPTY_ARCHIVE);
      return;
    }
    setArchive((current) => ({ ...current, loading: true, error: "" }));
    try {
      const result = await backend.listConversationSegments({
        pid: target.pid,
        conversationId: target.conversationId || "default",
      });
      const record = asRecord(result);
      if (!record?.ok) {
        setArchive((current) => ({ ...current, loading: false, error: safeText(record?.error || "archive load failed"), segments: [] }));
        return;
      }
      const segments = (Array.isArray(record.segments) ? record.segments : [])
        .map(normalizeConversationSegment)
        .filter(Boolean)
        .reverse() as ConversationSegment[];
      let selected = preserveSelection ? archive.selectedSegmentId : null;
      if (!selected || !segments.some((segment) => segment.id === selected)) {
        selected = segments[0]?.id ?? null;
      }
      setArchive((current) => ({
        ...current,
        loading: false,
        error: "",
        segments,
        selectedSegmentId: selected,
        messages: selected ? current.messages : [],
        messageCount: selected ? current.messageCount : 0,
        truncated: selected ? current.truncated : false,
      }));
      if (selected) {
        await readArchiveSegment(selected);
      }
    } catch (error) {
      setArchive((current) => ({ ...current, loading: false, error: formatError(error), segments: [] }));
    }
  }, [archive.selectedSegmentId, backend]);

  const readArchiveSegment = useCallback(async (segmentId: string) => {
    const target = activeRef.current;
    if (!target?.pid || !segmentId) {
      return;
    }
    setArchive((current) => ({
      ...current,
      loading: true,
      error: "",
      selectedSegmentId: segmentId,
      messages: [],
      messageCount: 0,
      truncated: false,
    }));
    try {
      const result = await backend.readConversationSegment({
        pid: target.pid,
        conversationId: target.conversationId || "default",
        segmentId,
        limit: 100,
      });
      const record = asRecord(result);
      if (!record?.ok) {
        setArchive((current) => ({ ...current, loading: false, error: safeText(record?.error || "segment read failed") }));
        return;
      }
      const messages = Array.isArray(record.messages) ? record.messages : [];
      setArchive((current) => ({
        ...current,
        loading: false,
        error: "",
        selectedSegmentId: segmentId,
        messages,
        messageCount: asNumber(record.messageCount) ?? messages.length,
        truncated: record.truncated === true,
      }));
    } catch (error) {
      setArchive((current) => ({ ...current, loading: false, error: formatError(error) }));
    }
  }, [backend]);

  useEffect(() => {
    void loadViewer();
    void loadProfiles();
    void loadThreads();
  }, [loadProfiles, loadThreads, loadViewer]);

  useEffect(() => {
    if (newConversationProfiles.length > 0 && !newConversationProfiles.some((profile) => profile.id === draftProfileId)) {
      setDraftProfileId(newConversationProfiles[0].id);
    }
  }, [draftProfileId, newConversationProfiles]);

  useEffect(() => {
    if (active?.pid) {
      void backend.watchProcessSignals({ pid: active.pid }).catch((error) => setHostError(formatError(error)));
      void loadConversations(active.pid);
      const historyKey = historyTargetKey(active);
      if (skipNextHistoryLoadRef.current === historyKey) {
        skipNextHistoryLoadRef.current = null;
      } else {
        void loadHistory(active);
      }
      return () => {
        void backend.unwatchProcessSignals({ pid: active.pid }).catch(() => {});
      };
    }
    void backend.unwatchProcessSignals({ pid: "" }).catch(() => {});
    setConversations([]);
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

  useEffect(() => {
    function handleTargetEvent(event: Event) {
      const detail = asRecord((event as CustomEvent).detail);
      if (!detail) {
        return;
      }
      const targetWindowId = asString(detail.windowId)?.trim() || "";
      if (WINDOW_ID && targetWindowId && targetWindowId !== WINDOW_ID) {
        return;
      }
      const next = normalizeThreadContext(detail);
      if (next) {
        setActive(next);
      }
    }

    try {
      const store = window.parent?.[PENDING_TARGETS_KEY as keyof Window];
      if (WINDOW_ID && store instanceof Map && store.has(WINDOW_ID)) {
        const pending = normalizeThreadContext(store.get(WINDOW_ID));
        store.delete(WINDOW_ID);
        if (pending) {
          setActive(pending);
        }
      }
      window.parent?.addEventListener(TARGET_CHAT_PROCESS_EVENT, handleTargetEvent);
    } catch {
      // Ignore parent access issues outside the desktop shell.
    }
    return () => {
      try {
        window.parent?.removeEventListener(TARGET_CHAT_PROCESS_EVENT, handleTargetEvent);
      } catch {}
    };
  }, [setActive]);

  useEffect(() => {
    return onAppEvent((signal, payload) => {
      const target = activeRef.current;
      if (!target) {
        return;
      }
      if (signal === "process.message") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        prepareForLiveTranscriptActivity();
        applyProcessMessageSignal(payload, target, setRows, setPendingAssistant);
      } else if (signal === "process.context") {
        const next = normalizeContextSignal(payload, target);
        if (next) {
          setContextStatesByConversation((current) => ({ ...current, [next.conversationId]: next }));
          setContextState(next);
          setMessageCount((current) => next.messageCount ?? current);
          setHistoryWindow((current) => {
            if (current.targetKey !== historyTargetKey(target)) {
              return current;
            }
            const newestMessageId = typeof next.lastMessageId === "number" ? next.lastMessageId : current.newestMessageId;
            const updated = { ...current, newestMessageId };
            historyWindowRef.current = updated;
            return updated;
          });
          if (next.runId && typeof next.lastMessageId === "number") {
            setRows((current) => {
              for (let index = current.length - 1; index >= 0; index -= 1) {
                const row = current[index];
                if (row.kind === "message" && row.role === "assistant" && row.runId === next.runId && !row.messageId) {
                  const updated = current.slice();
                  updated[index] = { ...row, messageId: next.lastMessageId };
                  return updated;
                }
              }
              return current;
            });
          }
        }
      } else if (signal === "process.lifecycle") {
        const record = asRecord(payload);
        const pid = asString(record?.pid);
        if (pid && pid !== target.pid) {
          return;
        }
        const event = asString(record?.event);
        if (event === "conversation.compacted" || event === "conversation.forked" || event === "conversation.auto_compacted") {
          void loadConversations(target.pid);
          void loadHistory(target);
          if (event === "conversation.compacted" || event === "conversation.auto_compacted" || workspaceView === "archive") {
            void loadArchiveSegments(true);
          }
        }
      } else if (signal === "chat.tool_call") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        prepareForLiveTranscriptActivity();
        setPendingHil(null);
        setPendingAssistant("tool");
        applyToolCallSignal(payload, target, setRows);
      } else if (signal === "chat.tool_result") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        prepareForLiveTranscriptActivity();
        applyToolResultSignal(payload, target, setRows);
        setPendingAssistant("thinking");
      } else if (signal === "chat.text") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        prepareForLiveTranscriptActivity();
        applyAssistantSignal(payload, target, setRows);
        setPendingAssistant(null);
      } else if (signal === "chat.complete") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        const record = asRecord(payload);
        setPendingHil(null);
        setPendingAssistant((current) => {
          if (record?.aborted === true && suppressNextAbortedComplete) {
            return current;
          }
          return null;
        });
        setSuppressNextAbortedComplete(false);
        const errorText = asString(record?.error);
        if (errorText) {
          prepareForLiveTranscriptActivity();
          appendSystem(errorText);
        }
        void loadThreads();
      } else if (signal === "chat.hil") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        prepareForLiveTranscriptActivity();
        setPendingAssistant(null);
        setPendingHil(normalizeHilRequest(payload));
      } else if (signal === "chat.error" || signal === "process.exit") {
        setPendingAssistant(null);
        setPendingHil(null);
        setSuppressNextAbortedComplete(false);
        void loadThreads();
      }
    });
  }, [appendSystem, loadArchiveSegments, loadConversations, loadHistory, loadThreads, prepareForLiveTranscriptActivity, suppressNextAbortedComplete, workspaceView]);

  useEffect(() => {
    scrollTranscript("near-bottom");
  }, [rows.length, pendingAssistant, pendingHil]);

  async function openHome(): Promise<void> {
    setNotice("");
    try {
      const result = await backend.spawnProcess({
        profile: "init",
        label: "Home",
        workspace: { mode: "none" },
      });
      const record = asRecord(result);
      if (!record?.ok) {
        appendSystem("home open failed: " + safeText(record?.error || "unknown error"));
        return;
      }
      setActive(normalizeThreadContext({
        pid: record.pid,
        workspaceId: record.workspaceId,
        cwd: record.cwd,
        conversationId: "default",
      }));
    } catch (error) {
      appendSystem("home open failed: " + formatError(error));
    }
  }

  async function openThread(workspaceId: string): Promise<void> {
    const entry = threads.find((candidate) => candidate.workspaceId === workspaceId);
    if (!entry) {
      appendSystem("thread not found: " + workspaceId);
      return;
    }
    if (entry.activeProcess) {
      setActive(normalizeThreadContext({
        pid: entry.activeProcess.pid,
        workspaceId: entry.workspaceId,
        cwd: entry.activeProcess.cwd,
        conversationId: "default",
      }));
      return;
    }
    try {
      const result = await backend.spawnProcess({
        profile: "task",
        label: entry.label || undefined,
        workspace: { mode: "attach", workspaceId: entry.workspaceId },
      });
      const record = asRecord(result);
      if (!record?.ok) {
        appendSystem("thread reopen failed: " + safeText(record?.error || "unknown error"));
        return;
      }
      setActive(normalizeThreadContext({
        pid: record.pid,
        workspaceId: record.workspaceId,
        cwd: record.cwd,
        conversationId: "default",
      }));
      void loadThreads();
    } catch (error) {
      appendSystem("thread reopen failed: " + formatError(error));
    }
  }

  function resetToNewThread(): void {
    cancelVoiceRecording();
    setActive(null);
    setComposeText("");
    setAttachments((current) => {
      current.forEach((attachment) => cleanupAttachmentPreview(attachment, previewUrlsRef.current));
      return [];
    });
    setWorkspaceView("chat");
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
    setWorkspaceView("chat");
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
        const spawnResult = await backend.spawnProcess({
          profile: draftProfile.id || "task",
          label: deriveThreadLabel(message) || draftProfile.displayName,
          workspace: draftProfile.spawnMode === "new"
            ? { mode: "new", kind: "thread" }
            : { mode: "none" },
        });
        const record = asRecord(spawnResult);
        if (!record?.ok) {
          appendSystem("thread start failed: " + safeText(record?.error || "unknown error"));
          return;
        }
        target = normalizeThreadContext({
          pid: record.pid,
          workspaceId: record.workspaceId,
          cwd: record.cwd,
          conversationId: "default",
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
      setRows((current) => dropEmptyPlaceholder(current).concat({
        kind: "message",
        role: "user",
        text: message,
        media,
        timestamp: Date.now(),
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
      setPendingAssistant("thinking");
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
          setPendingAssistant("thinking");
        } else {
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
      if (!nextHil) {
        setPendingAssistant("thinking");
      }
    } catch (error) {
      appendSystem("tool confirmation failed: " + formatError(error));
    } finally {
      setHilBusy(false);
    }
  }

  function openCompanion(target: "files" | "shell"): void {
    if (!active) {
      return;
    }
    if (target === "files") {
      openApp({ target: "files", payload: { path: active.cwd, context: active } });
      return;
    }
    openApp({ target: "shell", payload: { cwd: active.cwd, context: active } });
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
      setWorkspaceView("chat");
      setNotice("Created and opened " + nextTitle + " from message " + messageId + ".");
      await loadConversations(target.pid);
    } catch (error) {
      appendSystem("branch failed: " + formatError(error));
    } finally {
      setBranchBusy(false);
    }
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

  function loadMediaSource(media: unknown): void {
    const key = mediaSourceKey(media);
    if (
      !key
      || mediaSourcesRef.current[key]
      || mediaSourceLoadingRef.current.has(key)
      || mediaSourceFailedRef.current.has(key)
    ) {
      return;
    }
    const targetPid = mediaOwnerPidFromKey(key) ?? activeRef.current?.pid ?? "";
    if (!targetPid) {
      return;
    }

    const record = asRecord(media);
    const mimeType = asString(record?.mimeType) || undefined;
    mediaSourceLoadingRef.current.add(key);
    backend.readProcessMedia({ pid: targetPid, key, mimeType })
      .then((result) => {
        const response = asRecord(result);
        const dataUrl = asString(response?.dataUrl);
        if (!mountedRef.current) {
          return;
        }
        if (!response?.ok || !dataUrl) {
          const error = safeText(response?.error || "media load failed");
          mediaSourceFailedRef.current.add(key);
          setMediaSourceErrors((current) => current[key] === error ? current : { ...current, [key]: error });
          return;
        }
        mediaSourceFailedRef.current.delete(key);
        setMediaSourceErrors((current) => removeRecordKey(current, key));
        setMediaSources((current) => {
          if (current[key] === dataUrl) {
            return current;
          }
          return { ...current, [key]: dataUrl };
        });
      })
      .catch((error) => {
        const message = formatError(error);
        mediaSourceFailedRef.current.add(key);
        setMediaSourceErrors((current) => current[key] === message ? current : { ...current, [key]: message });
        appendSystem("media load failed: " + message);
      })
      .finally(() => {
        mediaSourceLoadingRef.current.delete(key);
      });
  }

  function retryMediaSource(media: unknown): void {
    const key = mediaSourceKey(media);
    if (!key) {
      return;
    }
    mediaSourceFailedRef.current.delete(key);
    setMediaSourceErrors((current) => removeRecordKey(current, key));
    loadMediaSource(media);
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

  function scrollTranscript(mode: "bottom" | "near-bottom"): void {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    if (mode === "near-bottom" && !stickToBottomRef.current && !isNearBottom(node)) {
      return;
    }
    node.scrollTop = node.scrollHeight;
    stickToBottomRef.current = true;
    clearNewMessages();
  }

  function jumpToLatest(): void {
    scrollTranscript("bottom");
  }

  return (
    <main class="chat-app">
      <ChatNavigator
        active={active}
        threads={threads}
        threadsLoading={threadsLoading}
        threadsError={threadsError}
        profiles={newConversationProfiles}
        draftProfileId={draftProfile.id}
        onDraftProfileChange={setDraftProfileId}
        onHome={() => void openHome()}
        onNew={resetToNewThread}
        onRefreshThreads={() => void loadThreads()}
        onOpenThread={(workspaceId) => void openThread(workspaceId)}
      />

      <section class={"chat-stage" + (workspaceView === "archive" ? " is-archive" : "")}>
        <header class="chat-stage-head">
          <MobileProcessNav
            active={active}
            threads={threads}
            threadsLoading={threadsLoading}
            threadsError={threadsError}
            profiles={newConversationProfiles}
            draftProfileId={draftProfile.id}
            onDraftProfileChange={setDraftProfileId}
            onHome={() => void openHome()}
            onNew={resetToNewThread}
            onRefreshThreads={() => void loadThreads()}
            onOpenThread={(workspaceId) => void openThread(workspaceId)}
          />
          <div class="chat-stage-title">
            <h1>{activeTitle}</h1>
            {!active ? (
              <div class="identity-icons is-draft">
                <span class="draft-meta">{draftConversationMeta(draftProfile)}</span>
              </div>
            ) : null}
            <ContextMeter state={active ? contextState : null} />
            <ConversationBar
              active={active}
              activeConversationId={activeConversationId}
              conversations={conversations}
              loading={conversationsLoading}
              error={conversationError}
              archiveCount={archive.segments.length}
              archiveActive={workspaceView === "archive"}
              onSelect={(conversation) => void switchConversation(conversation)}
              onRefresh={() => active?.pid ? void loadConversations(active.pid) : undefined}
              onArchiveToggle={() => {
                if (workspaceView === "archive") {
                  setWorkspaceView("chat");
                  return;
                }
                setWorkspaceView("archive");
                void loadArchiveSegments(true);
              }}
            />
          </div>
          <div class="chat-stage-actions">
            <span class={"run-status " + runStateClass} title={`${runStateLabel}: ${statusText}`} aria-label={`${runStateLabel}: ${statusText}`}>
              <TerminalIcon />
            </span>
            <span class="connection-dot is-connected" title="connected" aria-label="connected" />
            <details class="process-menu">
              <summary class="icon-button" title="Process actions" aria-label="Process actions" onClick={(event) => {
                closeChatMenus((event.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null);
              }}>
                <MoreIcon />
              </summary>
              <div class="process-menu-popover">
                <button type="button" class="menu-action" disabled={!active} onClick={(event) => { closeContainingChatMenu(event.currentTarget); openCompanion("files"); }}>
                  <FolderIcon />
                  <span>Files</span>
                </button>
                <button type="button" class="menu-action" disabled={!active} onClick={(event) => { closeContainingChatMenu(event.currentTarget); openCompanion("shell"); }}>
                  <TerminalIcon />
                  <span>Shell</span>
                </button>
                <button type="button" class="menu-action" disabled={!active} onClick={(event) => {
                  closeContainingChatMenu(event.currentTarget);
                  if (active) void copyText("process id", active.pid);
                }}>
                  <TerminalIcon />
                  <span>Copy process ID</span>
                </button>
                <button type="button" class="menu-action" disabled={!active} onClick={(event) => {
                  closeContainingChatMenu(event.currentTarget);
                  if (active) void copyText("workspace", active.cwd);
                }}>
                  <FolderIcon />
                  <span>Copy workspace</span>
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

        {workspaceView === "archive" ? (
          <ArchiveWorkspace
            archive={archive}
            userLabel={viewerUsername}
            mediaSources={mediaSources}
            mediaSourceErrors={mediaSourceErrors}
            onRefresh={() => void loadArchiveSegments(true)}
            onSelect={(segmentId) => void readArchiveSegment(segmentId)}
            onLoadMediaSource={loadMediaSource}
            onRetryMediaSource={retryMediaSource}
          />
        ) : (
          <>
            <Transcript
              rows={rows}
              userLabel={viewerUsername}
              pendingAssistant={pendingAssistant}
              pendingHil={pendingHil}
              hasOlderHistory={historyWindow.hasMoreBefore}
              loadingOlderHistory={historyWindow.loadingOlder}
              hasNewMessages={hasNewMessages}
              hilBusy={hilBusy}
              branchBusy={branchBusy}
              refNode={transcriptRef}
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
          </>
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
