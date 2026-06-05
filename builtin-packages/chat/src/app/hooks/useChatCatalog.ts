import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ChatBackend, ConversationRecord, ProcessEntry, Profile } from "../types";
import {
  asNumber,
  asRecord,
  asString,
  fallbackProfiles,
  formatError,
  normalizeConversation,
  normalizeProcessEntry,
  normalizeProfile,
  sortConversations,
} from "../view-helpers";

export function useChatCatalog(backend: ChatBackend) {
  const [profiles, setProfiles] = useState<Profile[]>(() => fallbackProfiles());
  const [draftProfileId, setDraftProfileId] = useState("personal");
  const [viewerUsername, setViewerUsername] = useState("You");
  const [threads, setThreads] = useState<ProcessEntry[]>([]);
  const [homeThread, setHomeThread] = useState<ProcessEntry | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState("");
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationError, setConversationError] = useState("");
  const threadsRef = useRef<ProcessEntry[]>([]);
  const homeThreadRef = useRef<ProcessEntry | null>(null);

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
      ?? conversationProfiles.find((profile) => profile.id === "personal")
      ?? newConversationProfiles[0]
      ?? conversationProfiles.find((profile) => profile.id === "task")
      ?? fallbackProfiles()[0];
  }, [conversationProfiles, draftProfileId, newConversationProfiles]);

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
      const result = await backend.listAgents({});
      const accountRows = Array.isArray(asRecord(result)?.accounts) ? asRecord(result)?.accounts as unknown[] : [];
      const normalized = accountRows.map(normalizeProfile).filter(Boolean) as Profile[];
      setProfiles(normalized.length > 0 ? normalized : fallbackProfiles());
    } catch {
      setProfiles(fallbackProfiles());
    }
  }, [backend]);

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true);
    setThreadsError("");
    try {
      const result = await backend.listProcesses({});
      const processRows = Array.isArray(asRecord(result)?.processes) ? asRecord(result)?.processes as unknown[] : [];
      const normalized = processRows.map(normalizeProcessEntry).filter(Boolean) as ProcessEntry[];
      const nextHomeThread = normalized.find((entry) => entry.isDefaultConversation) ?? null;
      const nextThreads = normalized.filter((entry) => {
        // The personal-agent default conversation is surfaced as the home draft,
        // not a thread; otherwise show every interactive conversation the
        // viewer owns regardless of which agent it runs as.
        if (entry.isDefaultConversation) return false;
        return entry.interactive;
      });
      homeThreadRef.current = nextHomeThread;
      threadsRef.current = nextThreads;
      setHomeThread(nextHomeThread);
      setThreads(nextThreads);
    } catch (error) {
      homeThreadRef.current = null;
      threadsRef.current = [];
      setHomeThread(null);
      setThreads([]);
      setThreadsError(formatError(error));
    } finally {
      setThreadsLoading(false);
    }
  }, [backend]);

  const applyProcessCatalogSignal = useCallback((signal: string, payload: unknown): boolean => {
    const record = asRecord(payload);
    if (!record) return false;
    const pid = asString(record?.pid);
    if (!pid) return false;

    const homeMatches = homeThreadRef.current?.pid === pid;
    const threadIndex = threadsRef.current.findIndex((entry) => entry.pid === pid);
    const knownProcess = homeMatches || threadIndex >= 0;
    if (!knownProcess) return false;

    if (signal === "process.exit") {
      if (homeMatches) {
        homeThreadRef.current = null;
        setHomeThread(null);
      }
      if (threadIndex >= 0) {
        const nextThreads = threadsRef.current.filter((entry) => entry.pid !== pid);
        threadsRef.current = nextThreads;
        setThreads(nextThreads);
      }
      return true;
    }

    const patch = processPatchFromSignal(signal, record);
    if (!patch) return false;

    if (homeMatches && homeThreadRef.current) {
      const nextHomeThread = { ...homeThreadRef.current, ...patch };
      homeThreadRef.current = nextHomeThread;
      setHomeThread(nextHomeThread);
    }
    if (threadIndex >= 0) {
      const nextThreads = threadsRef.current.slice();
      nextThreads[threadIndex] = { ...nextThreads[threadIndex], ...patch };
      threadsRef.current = nextThreads;
      setThreads(nextThreads);
    }
    return true;
  }, []);

  const loadConversations = useCallback(async (pid = "") => {
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

  useEffect(() => {
    void loadViewer();
    void loadProfiles();
  }, [loadProfiles, loadViewer]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (conversationProfiles.length > 0 && !conversationProfiles.some((profile) => profile.id === draftProfileId || profile.alias === draftProfileId)) {
      setDraftProfileId(conversationProfiles.find((profile) => profile.id === "personal")?.id ?? conversationProfiles[0].id);
    }
  }, [conversationProfiles, draftProfileId]);

  return {
    conversations,
    conversationsLoading,
    conversationError,
    draftProfile,
    draftProfileId,
    applyProcessCatalogSignal,
    loadConversations,
    loadThreads,
    homeThread,
    conversationProfiles,
    newConversationProfiles,
    setDraftProfileId,
    threads,
    threadsError,
    threadsLoading,
    viewerUsername,
  };
}

type ProcessSignalPatch = Partial<Pick<ProcessEntry, "state" | "activeRunId" | "activeConversationId" | "queuedCount">>;

function processPatchFromSignal(signal: string, record: Record<string, unknown>): ProcessSignalPatch | null {
  const runId = asString(record.runId);
  const conversationId = asString(record.conversationId);
  const queuedCount = asNumber(record.queuedCount);
  const queuedPatch = typeof queuedCount === "number" ? { queuedCount } : {};

  if (signal === "proc.run.started") {
    return {
      state: "running",
      ...(runId ? { activeRunId: runId } : {}),
      ...(conversationId ? { activeConversationId: conversationId } : {}),
      ...queuedPatch,
    };
  }
  if (signal === "proc.run.hil.requested") {
    return {
      state: "waiting_hil",
      ...(runId ? { activeRunId: runId } : {}),
      ...(conversationId ? { activeConversationId: conversationId } : {}),
      ...queuedPatch,
    };
  }
  if (signal === "proc.run.finished") {
    return {
      state: queuedCount && queuedCount > 0 ? "queued" : "idle",
      activeRunId: null,
      activeConversationId: null,
      ...queuedPatch,
    };
  }
  if (signal === "proc.changed" && typeof queuedCount === "number") {
    return { queuedCount };
  }
  return null;
}
