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
  readAttachmentFile,
  safeText,
  setStoredThreadContext,
  sortConversations,
  systemRow,
  systemRows,
  suggestKeepLast,
  titleForActive,
} from "./view-helpers";

const TARGET_CHAT_PROCESS_EVENT = "gsv:target-chat-process";
const PENDING_TARGETS_KEY = "__gsvPendingChatProcessTargets";
const WINDOW_ID = new URL(window.location.href).searchParams.get("windowId")?.trim() || "";

const EMPTY_ARCHIVE: ArchiveState = {
  loading: false,
  error: "",
  segments: [],
  selectedSegmentId: null,
  messages: [],
  messageCount: 0,
  truncated: false,
};


export function App({ backend }: { backend: ChatBackend }) {
  const [active, setActiveState] = useState<ThreadContext | null>(() => getStoredThreadContext());
  const [profiles, setProfiles] = useState<Profile[]>(() => fallbackProfiles());
  const [draftProfileId, setDraftProfileId] = useState("task");
  const [threads, setThreads] = useState<WorkspaceEntry[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState("");
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationError, setConversationError] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
  const [rows, setRows] = useState<LogRow[]>(() => systemRows("Connecting chat backend."));
  const [messageCount, setMessageCount] = useState(0);
  const [contextState, setContextState] = useState<ContextState | null>(null);
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
  const [archive, setArchive] = useState<ArchiveState>(EMPTY_ARCHIVE);
  const [compactDialog, setCompactDialog] = useState<CompactDialogState>(null);
  const [notice, setNotice] = useState("");
  const [suppressNextAbortedComplete, setSuppressNextAbortedComplete] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

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
  const runActive = pendingAssistant !== null || pendingHil !== null;
  const runStateClass = hostError ? "is-error" : pendingHil ? "is-waiting" : runActive ? "is-running" : "is-ready";
  const runStateLabel = hostError ? "Error" : pendingHil ? "Approval" : runActive ? "Running" : "Ready";
  const canSend = interactive && !messageBusy && hasDraft;
  const canStop = interactive && Boolean(active?.pid) && !abortBusy && runActive && !hasDraft;
  const canActOnConversation = interactive && Boolean(active?.pid) && !messageBusy && pendingAssistant === null;

  const setActive = useCallback((next: ThreadContext | null) => {
    const normalized = setStoredThreadContext(next);
    activeRef.current = normalized;
    setActiveState(normalized);
    setContextState(null);
    setPendingHil(null);
    setPendingAssistant(null);
    setMessageCount(0);
    setArchive(EMPTY_ARCHIVE);
    setWorkspaceView("chat");
    setNotice("");
  }, []);

  const appendSystem = useCallback((text: string) => {
    setRows((current) => dropEmptyPlaceholder(current).concat(systemRow(text)));
  }, []);

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
      setMessageCount(0);
      setRows(systemRows("No thread selected. Send a message to start a new thread."));
      return;
    }

    try {
      const merged: unknown[] = [];
      let offset = 0;
      let total = 0;
      let truncated = false;
      let nextHil: HilRequest | null = null;
      let nextContext: ContextState | null = null;
      for (let page = 0; page < 20; page += 1) {
        const result = await backend.getHistory({
          pid: target.pid,
          conversationId: target.conversationId || "default",
          limit: 200,
          offset,
        });
        const record = asRecord(result);
        if (!record?.ok) {
          setRows(systemRows("history error: " + safeText(record?.error || "unknown error")));
          return;
        }
        const messages = Array.isArray(record.messages) ? record.messages : [];
        if (page === 0) {
          nextHil = normalizeHilRequest(record.pendingHil);
          nextContext = normalizeContextState(record.context);
        }
        merged.push(...messages);
        total = asNumber(record.messageCount) ?? messages.length;
        offset += messages.length;
        truncated = record.truncated === true;
        if (!truncated || messages.length === 0 || offset >= total) {
          break;
        }
      }
      const flattened = flattenHistory(merged);
      if (truncated && offset < total) {
        flattened.push(systemRow(`history truncated at ${offset}/${total} messages`));
      }
      setMessageCount(total);
      setContextState(nextContext);
      setPendingHil(nextHil);
      setPendingAssistant(null);
      setRows(flattened);
      requestAnimationFrame(() => scrollTranscript("bottom"));
    } catch (error) {
      setRows(systemRows("history error: " + formatError(error)));
    }
  }, [backend]);

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
    void loadProfiles();
    void loadThreads();
  }, [loadProfiles, loadThreads]);

  useEffect(() => {
    if (newConversationProfiles.length > 0 && !newConversationProfiles.some((profile) => profile.id === draftProfileId)) {
      setDraftProfileId(newConversationProfiles[0].id);
    }
  }, [draftProfileId, newConversationProfiles]);

  useEffect(() => {
    if (active?.pid) {
      void backend.watchProcessSignals({ pid: active.pid }).catch((error) => setHostError(formatError(error)));
      void loadConversations(active.pid);
      void loadHistory(active);
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
        applyProcessMessageSignal(payload, target, setRows, setPendingAssistant);
      } else if (signal === "process.context") {
        const next = normalizeContextSignal(payload, target);
        if (next) {
          setContextState(next);
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
        setPendingHil(null);
        setPendingAssistant("tool");
        applyToolCallSignal(payload, target, setRows);
      } else if (signal === "chat.tool_result") {
        applyToolResultSignal(payload, target, setRows);
        setPendingAssistant("thinking");
      } else if (signal === "chat.text") {
        applyAssistantSignal(payload, target, setRows);
        setPendingAssistant(null);
      } else if (signal === "chat.complete") {
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
          appendSystem(errorText);
        }
        void loadThreads();
        void loadHistory(target);
      } else if (signal === "chat.hil") {
        setPendingAssistant(null);
        setPendingHil(normalizeHilRequest(payload));
      } else if (signal === "chat.error" || signal === "process.exit") {
        setPendingAssistant(null);
        setPendingHil(null);
        setSuppressNextAbortedComplete(false);
        void loadThreads();
      }
    });
  }, [appendSystem, loadArchiveSegments, loadConversations, loadHistory, loadThreads, suppressNextAbortedComplete, workspaceView]);

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
    setActive(null);
    setComposeText("");
    setAttachments([]);
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
    const message = composeText.trim();
    const media = attachments.slice();
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
      setAttachments([]);
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

  function scrollTranscript(mode: "bottom" | "near-bottom"): void {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    if (mode === "near-bottom" && !isNearBottom(node)) {
      return;
    }
    node.scrollTop = node.scrollHeight;
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
            onRefresh={() => void loadArchiveSegments(true)}
            onSelect={(segmentId) => void readArchiveSegment(segmentId)}
          />
        ) : (
          <>
            <Transcript
              rows={rows}
              pendingAssistant={pendingAssistant}
              pendingHil={pendingHil}
              hilBusy={hilBusy}
              branchBusy={branchBusy}
              refNode={transcriptRef}
              onCopy={(text) => void copyText("message", text)}
              onBranch={(messageId) => void branchFromMessage(messageId)}
              onHilDecision={(requestId, decision, remember) => void decidePendingHil(requestId, decision, remember)}
            />

            <Composer
              value={composeText}
              attachments={attachments}
              disabled={!interactive || messageBusy}
              canSend={canSend}
              canStop={canStop}
              stopBusy={abortBusy}
              onValueChange={setComposeText}
              onSubmit={() => void sendMessage()}
              onStop={() => void abortActiveRun()}
              onFiles={(files) => void readAttachments(files)}
              onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
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
