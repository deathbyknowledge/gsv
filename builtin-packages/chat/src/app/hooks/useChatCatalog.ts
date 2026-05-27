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
      const result = await backend.listProcesses({});
      const processRows = Array.isArray(asRecord(result)?.processes) ? asRecord(result)?.processes as unknown[] : [];
      setThreads(processRows.map(normalizeProcessEntry).filter(Boolean) as ProcessEntry[]);
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
    void loadThreads();
  }, [loadProfiles, loadThreads, loadViewer]);

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
