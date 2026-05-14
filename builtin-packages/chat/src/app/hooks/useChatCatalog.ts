import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { ChatBackend, ConversationRecord, Profile, WorkspaceEntry } from "../types";
import {
  asRecord,
  asString,
  fallbackProfiles,
  formatError,
  normalizeConversation,
  normalizeProfile,
  normalizeWorkspace,
  sortConversations,
} from "../view-helpers";

export function useChatCatalog(backend: ChatBackend) {
  const [profiles, setProfiles] = useState<Profile[]>(() => fallbackProfiles());
  const [draftProfileId, setDraftProfileId] = useState("task");
  const [viewerUsername, setViewerUsername] = useState("You");
  const [threads, setThreads] = useState<WorkspaceEntry[]>([]);
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
      ?? newConversationProfiles[0]
      ?? conversationProfiles.find((profile) => profile.id === "task")
      ?? fallbackProfiles()[1];
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
    if (newConversationProfiles.length > 0 && !newConversationProfiles.some((profile) => profile.id === draftProfileId)) {
      setDraftProfileId(newConversationProfiles[0].id);
    }
  }, [draftProfileId, newConversationProfiles]);

  return {
    conversations,
    conversationsLoading,
    conversationError,
    draftProfile,
    draftProfileId,
    loadConversations,
    loadThreads,
    newConversationProfiles,
    setDraftProfileId,
    threads,
    threadsError,
    threadsLoading,
    viewerUsername,
  };
}
