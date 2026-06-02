import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { ChatBackend, ConversationRecord, ProcessEntry, Profile } from "../types";
import {
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
  const [draftProfileId, setDraftProfileId] = useState("init");
  const [viewerUsername, setViewerUsername] = useState("You");
  const [threads, setThreads] = useState<ProcessEntry[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState("");
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationError, setConversationError] = useState("");

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
      ?? conversationProfiles.find((profile) => profile.id === "init")
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
      setThreads(normalized.filter((entry) => {
        // The personal-agent (init) conversation is surfaced as the home draft,
        // not a thread; otherwise show every interactive conversation the
        // viewer owns regardless of which agent it runs as.
        if (entry.pid.startsWith("init:")) return false;
        return entry.interactive;
      }));
    } catch (error) {
      setThreads([]);
      setThreadsError(formatError(error));
    } finally {
      setThreadsLoading(false);
    }
  }, [backend]);

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
      setDraftProfileId(conversationProfiles.find((profile) => profile.id === "init")?.id ?? conversationProfiles[0].id);
    }
  }, [conversationProfiles, draftProfileId]);

  return {
    conversations,
    conversationsLoading,
    conversationError,
    draftProfile,
    draftProfileId,
    loadConversations,
    loadThreads,
    conversationProfiles,
    newConversationProfiles,
    setDraftProfileId,
    threads,
    threadsError,
    threadsLoading,
    viewerUsername,
  };
}
