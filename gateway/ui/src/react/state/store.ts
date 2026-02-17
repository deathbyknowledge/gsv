import { create } from "zustand";
import { GatewayClient, type ConnectionState } from "../../ui/gateway-client";
import { getCurrentTab, navigateTo } from "../../ui/navigation";
import {
  applyTheme,
  getGatewayUrl,
  loadSettings,
  saveSettings,
  type UiSettings,
} from "../../ui/storage";
import type {
  AssistantMessage,
  ChannelAccountStatus,
  ChannelLoginResult,
  ChannelRegistryEntry,
  ChannelStatusResult,
  ChatEventPayload,
  ContentBlock,
  EventFrame,
  Message,
  SessionRegistryEntry,
  Tab,
  ToolDefinition,
} from "../../ui/types";

const DEFAULT_CHANNEL_ACCOUNT_ID = "default";
const CHANNEL_AUTO_REFRESH_MS = 10_000;
const DEFAULT_CHANNELS = ["whatsapp", "discord"];

type DebugEvent = {
  time: Date;
  type: string;
  data: unknown;
};

type WorkspaceListing = {
  path: string;
  files: string[];
  directories: string[];
};

type WorkspaceFileContent = {
  path: string;
  content: string;
};

type LogsData = {
  nodeId: string;
  lines: string[];
  count: number;
  truncated: boolean;
};

type PendingPair = {
  channel: string;
  senderId: string;
  senderName?: string;
  requestedAt: number;
  message?: string;
};

type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronMode =
  | { mode: "systemEvent"; text: string }
  | {
      mode: "task";
      message: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      deliver?: boolean;
      channel?: string;
      to?: string;
    };

type CronJobCreateInput = {
  name: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  spec: CronMode;
  agentId?: string;
};

type ReactUiStore = {
  initialized: boolean;

  connectionState: ConnectionState;
  connectionError: string | null;
  settings: UiSettings;
  showConnectScreen: boolean;

  tab: Tab;
  navDrawerOpen: boolean;
  isMobileLayout: boolean;

  chatMessages: Message[];
  chatLoading: boolean;
  chatSending: boolean;
  chatStream: AssistantMessage | null;
  currentRunId: string | null;

  sessions: SessionRegistryEntry[];
  sessionsLoading: boolean;

  channels: ChannelRegistryEntry[];
  channelsLoading: boolean;
  channelsError: string | null;
  channelStatuses: Record<string, ChannelAccountStatus | null>;
  channelActionLoading: Record<string, string | null>;
  channelMessages: Record<string, string>;
  channelQrData: Record<string, string | null>;

  tools: ToolDefinition[];
  toolsLoading: boolean;

  workspaceFiles: WorkspaceListing | null;
  workspaceLoading: boolean;
  workspaceCurrentPath: string;
  workspaceFileContent: WorkspaceFileContent | null;

  config: Record<string, unknown> | null;
  configLoading: boolean;

  debugLog: DebugEvent[];

  cronStatus: Record<string, unknown> | null;
  cronJobs: unknown[];
  cronRuns: unknown[];
  cronLoading: boolean;
  cronTab: "jobs" | "runs" | "create";

  logsData: LogsData | null;
  logsLoading: boolean;
  logsError: string | null;
  logsNodeId: string;
  logsLines: number;

  pairingRequests: PendingPair[];
  pairingLoading: boolean;

  client: GatewayClient | null;

  initialize: () => void;
  cleanup: () => void;

  syncTabFromLocation: () => void;
  switchTab: (tab: Tab) => void;

  setMobileLayout: (isMobile: boolean) => void;
  setNavDrawerOpen: (open: boolean) => void;
  toggleNavDrawer: () => void;
  closeNavDrawer: () => void;

  startConnection: () => void;
  stopConnection: () => void;
  connect: () => void;
  disconnect: () => void;

  loadTabData: (tab: Tab) => Promise<void>;

  loadChatHistory: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;

  loadSessions: () => Promise<void>;
  selectSession: (sessionKey: string) => Promise<void>;
  resetSession: (sessionKey: string) => Promise<void>;

  refreshChannels: () => Promise<void>;
  loadChannels: (showLoading?: boolean) => Promise<void>;
  channelStatus: (
    channel: string,
    accountId?: string,
  ) => ChannelAccountStatus | null;
  channelActionState: (channel: string, accountId?: string) => string | null;
  channelMessage: (channel: string, accountId?: string) => string | null;
  channelQrCode: (channel: string, accountId?: string) => string | null;
  startChannel: (channel: string, accountId?: string) => Promise<void>;
  stopChannel: (channel: string, accountId?: string) => Promise<void>;
  loginChannel: (
    channel: string,
    accountId?: string,
    force?: boolean,
  ) => Promise<void>;
  logoutChannel: (channel: string, accountId?: string) => Promise<void>;

  loadTools: () => Promise<void>;

  loadWorkspace: (path?: string) => Promise<void>;
  readWorkspaceFile: (path: string) => Promise<void>;
  writeWorkspaceFile: (path: string, content: string) => Promise<void>;

  loadConfig: () => Promise<void>;
  saveConfig: (path: string, value: unknown) => Promise<void>;

  loadCron: () => Promise<void>;
  loadCronRuns: (jobId?: string) => Promise<void>;
  setCronTab: (tab: "jobs" | "runs" | "create") => void;
  cronAdd: (input: CronJobCreateInput) => Promise<void>;
  cronUpdate: (jobId: string, patch: Record<string, unknown>) => Promise<void>;
  cronRemove: (jobId: string) => Promise<void>;
  cronRun: (params?: { id?: string; mode?: "due" | "force" }) => Promise<void>;

  setLogsNodeId: (nodeId: string) => void;
  setLogsLines: (lines: number) => void;
  loadLogs: (params?: { nodeId?: string; lines?: number }) => Promise<void>;

  loadPairing: () => Promise<void>;
  pairApprove: (channel: string, senderId: string) => Promise<void>;
  pairReject: (channel: string, senderId: string) => Promise<void>;

  updateSettings: (updates: Partial<UiSettings>) => void;

  clearDebugLog: () => void;
  rpcRequest: (method: string, params?: unknown) => Promise<unknown>;
};

let channelsRefreshTimer: ReturnType<typeof setInterval> | null = null;

function channelKey(channel: string, accountId = DEFAULT_CHANNEL_ACCOUNT_ID): string {
  return `${channel}:${accountId}`;
}

function stopChannelsAutoRefresh() {
  if (!channelsRefreshTimer) {
    return;
  }
  clearInterval(channelsRefreshTimer);
  channelsRefreshTimer = null;
}

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const noLeadingSlash = trimmed.replace(/^\/+/, "");
  const noTrailingSlash = noLeadingSlash.replace(/\/+$/, "");
  return noTrailingSlash || "/";
}

function normalizeAssistantMessage(message: unknown): AssistantMessage | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidate = message as { content?: unknown; timestamp?: unknown };
  if (!Array.isArray(candidate.content)) {
    return null;
  }

  return {
    role: "assistant",
    content: candidate.content as ContentBlock[],
    timestamp:
      typeof candidate.timestamp === "number"
        ? candidate.timestamp
        : Date.now(),
  };
}

function syncChannelsAutoRefresh(get: () => ReactUiStore) {
  const state = get();
  const shouldRefresh =
    state.tab === "channels" && state.connectionState === "connected";
  if (!shouldRefresh) {
    stopChannelsAutoRefresh();
    return;
  }
  if (channelsRefreshTimer) {
    return;
  }
  channelsRefreshTimer = setInterval(() => {
    void get().loadChannels(false);
  }, CHANNEL_AUTO_REFRESH_MS);
}

export const useReactUiStore = create<ReactUiStore>((set, get) => ({
  initialized: false,

  connectionState: "disconnected",
  connectionError: null,
  settings: loadSettings(),
  showConnectScreen: true,

  tab: getCurrentTab(),
  navDrawerOpen: false,
  isMobileLayout: false,

  chatMessages: [],
  chatLoading: false,
  chatSending: false,
  chatStream: null,
  currentRunId: null,

  sessions: [],
  sessionsLoading: false,

  channels: [],
  channelsLoading: false,
  channelsError: null,
  channelStatuses: {},
  channelActionLoading: {},
  channelMessages: {},
  channelQrData: {},

  tools: [],
  toolsLoading: false,

  workspaceFiles: null,
  workspaceLoading: false,
  workspaceCurrentPath: "/",
  workspaceFileContent: null,

  config: null,
  configLoading: false,

  debugLog: [],

  cronStatus: null,
  cronJobs: [],
  cronRuns: [],
  cronLoading: false,
  cronTab: "jobs",

  logsData: null,
  logsLoading: false,
  logsError: null,
  logsNodeId: "",
  logsLines: 200,

  pairingRequests: [],
  pairingLoading: false,

  client: null,

  initialize: () => {
    if (get().initialized) {
      return;
    }

    applyTheme(get().settings.theme);
    const shouldAutoConnect = Boolean(
      get().settings.token || localStorage.getItem("gsv-connected-once"),
    );

    set({
      initialized: true,
      showConnectScreen: !shouldAutoConnect,
      tab: getCurrentTab(),
    });

    if (shouldAutoConnect) {
      get().startConnection();
    }
  },

  cleanup: () => {
    stopChannelsAutoRefresh();
    const client = get().client;
    client?.stop();
    set({ client: null });
  },

  syncTabFromLocation: () => {
    const tab = getCurrentTab();
    set({ tab });
    get().closeNavDrawer();
    void get().loadTabData(tab);
    syncChannelsAutoRefresh(get);
  },

  switchTab: (tab) => {
    if (get().tab !== tab) {
      set({ tab });
      navigateTo(tab);
      void get().loadTabData(tab);
    }
    get().closeNavDrawer();
    syncChannelsAutoRefresh(get);
  },

  setMobileLayout: (isMobile) => {
    set({ isMobileLayout: isMobile });
    if (!isMobile) {
      set({ navDrawerOpen: false });
    }
  },

  setNavDrawerOpen: (open) => {
    set({ navDrawerOpen: open });
  },

  toggleNavDrawer: () => {
    if (!get().isMobileLayout) {
      return;
    }
    set({ navDrawerOpen: !get().navDrawerOpen });
  },

  closeNavDrawer: () => {
    if (!get().navDrawerOpen) {
      return;
    }
    set({ navDrawerOpen: false });
  },

  startConnection: () => {
    const existingClient = get().client;
    if (existingClient) {
      existingClient.stop();
    }

    set({
      connectionError: null,
      connectionState: "connecting",
    });

    const client = new GatewayClient({
      url: getGatewayUrl(get().settings),
      token: get().settings.token || undefined,
      onStateChange: (state) => {
        set({ connectionState: state });
        if (state === "connected") {
          localStorage.setItem("gsv-connected-once", "true");
          set({
            connectionError: null,
            showConnectScreen: false,
          });
          syncChannelsAutoRefresh(get);
          void Promise.all([
            get().loadTools(),
            get().loadSessions(),
            get().loadChannels(),
          ]).then(() => get().loadTabData(get().tab));
        } else {
          syncChannelsAutoRefresh(get);
        }
      },
      onError: (error) => {
        set({ connectionError: error });
      },
      onEvent: (event) => {
        set((state) => ({
          debugLog: [
            ...state.debugLog.slice(-99),
            { time: new Date(), type: event.event, data: event.payload },
          ],
        }));
        if (event.event === "chat") {
          const payload = event.payload as ChatEventPayload;
          if (payload.sessionKey !== get().settings.sessionKey) {
            return;
          }

          const matchesCurrentRun =
            !get().currentRunId ||
            !payload.runId ||
            payload.runId === get().currentRunId;

          if (payload.state === "partial" && payload.message) {
            const incoming = normalizeAssistantMessage(payload.message);
            if (!incoming) {
              return;
            }

            const currentStream = get().chatStream;
            if (currentStream && payload.runId) {
              set({
                chatStream: mergeAssistantMessages(currentStream, incoming),
              });
            } else {
              set({ chatStream: incoming });
            }
          } else if (payload.state === "final") {
            const finalMessage = payload.message
              ? normalizeAssistantMessage(payload.message)
              : null;
            if (finalMessage) {
              set((state) => ({
                chatMessages: [...state.chatMessages, finalMessage],
              }));
            }
            set({
              chatStream: null,
              chatSending: matchesCurrentRun ? false : get().chatSending,
              currentRunId: matchesCurrentRun ? null : get().currentRunId,
            });
            void get().loadChatHistory();
          } else if (payload.state === "error") {
            set({
              chatStream: null,
              chatSending: matchesCurrentRun ? false : get().chatSending,
              currentRunId: matchesCurrentRun ? null : get().currentRunId,
            });
          }
        }
      },
    });

    set({ client });
    client.start();
  },

  stopConnection: () => {
    stopChannelsAutoRefresh();
    const client = get().client;
    client?.stop();
    set({
      client: null,
      connectionState: "disconnected",
    });
  },

  connect: () => {
    set({ showConnectScreen: false });
    if (
      get().connectionState === "connecting" ||
      get().connectionState === "connected"
    ) {
      return;
    }
    get().startConnection();
  },

  disconnect: () => {
    get().stopConnection();
    set({ showConnectScreen: true });
    localStorage.removeItem("gsv-connected-once");
  },

  loadTabData: async (tab) => {
    if (!get().client || get().connectionState !== "connected") {
      return;
    }

    switch (tab) {
      case "chat":
        await get().loadChatHistory();
        break;
      case "sessions":
        await get().loadSessions();
        break;
      case "channels":
        await get().loadChannels();
        break;
      case "nodes":
        await get().loadTools();
        break;
      case "workspace":
        await get().loadWorkspace();
        break;
      case "config":
        await get().loadConfig();
        break;
      case "cron":
        await get().loadCron();
        break;
      case "pairing":
        await get().loadPairing();
        break;
      default:
        break;
    }
  },

  loadChatHistory: async () => {
    const client = get().client;
    if (!client) {
      return;
    }
    set({ chatLoading: true });
    try {
      const res = await client.sessionPreview(get().settings.sessionKey, 100);
      if (res.ok && res.payload) {
        const data = res.payload as { messages: Message[] };
        set({ chatMessages: data.messages || [] });
      }
    } finally {
      set({ chatLoading: false });
    }
  },

  sendMessage: async (text) => {
    const client = get().client;
    if (!client || !text.trim()) {
      return;
    }

    const runId = crypto.randomUUID();
    set((state) => ({
      chatSending: true,
      currentRunId: runId,
      chatStream: null,
      chatMessages: [
        ...state.chatMessages,
        {
          role: "user",
          content: text,
          timestamp: Date.now(),
        },
      ],
    }));

    try {
      await client.chatSend(get().settings.sessionKey, text, runId);
    } catch {
      set({
        chatSending: false,
        currentRunId: null,
      });
    }
  },

  loadSessions: async () => {
    const client = get().client;
    if (!client) {
      return;
    }
    set({ sessionsLoading: true });
    try {
      const res = await client.sessionsList();
      if (res.ok && res.payload) {
        const data = res.payload as { sessions: SessionRegistryEntry[] };
        set({ sessions: data.sessions || [] });
      }
    } finally {
      set({ sessionsLoading: false });
    }
  },

  selectSession: async (sessionKey) => {
    const settings = { ...get().settings, sessionKey };
    set({ settings });
    saveSettings({ sessionKey });
    get().switchTab("chat");
    await get().loadChatHistory();
  },

  resetSession: async (sessionKey) => {
    const client = get().client;
    if (!client) {
      return;
    }
    await client.sessionReset(sessionKey);
    await get().loadSessions();
    if (sessionKey === get().settings.sessionKey) {
      set({ chatMessages: [] });
    }
  },

  refreshChannels: async () => {
    await get().loadChannels();
  },

  loadChannels: async (showLoading = true) => {
    const client = get().client;
    if (!client) {
      return;
    }
    if (showLoading) {
      set({ channelsLoading: true });
    }
    set({ channelsError: null });
    try {
      const res = await client.channelsList();
      if (res.ok && res.payload) {
        const data = res.payload as { channels: ChannelRegistryEntry[] };
        set({ channels: data.channels || [] });
      } else {
        set({ channelsError: res.error?.message || "Failed to load channels" });
      }

      const targets = new Map<string, { channel: string; accountId: string }>();
      for (const channel of DEFAULT_CHANNELS) {
        const key = channelKey(channel, DEFAULT_CHANNEL_ACCOUNT_ID);
        targets.set(key, { channel, accountId: DEFAULT_CHANNEL_ACCOUNT_ID });
      }
      for (const entry of get().channels) {
        const key = channelKey(entry.channel, entry.accountId);
        targets.set(key, { channel: entry.channel, accountId: entry.accountId });
      }

      const nextStatuses = { ...get().channelStatuses };

      await Promise.all(
        Array.from(targets.entries()).map(async ([key, target]) => {
          try {
            const statusRes = await client.channelStatus(
              target.channel,
              target.accountId,
            );
            if (statusRes.ok && statusRes.payload) {
              const data = statusRes.payload as ChannelStatusResult;
              nextStatuses[key] =
                data.accounts.find((a) => a.accountId === target.accountId) ||
                data.accounts[0] || {
                  accountId: target.accountId,
                  connected: false,
                  authenticated: false,
                };
            } else {
              nextStatuses[key] = {
                accountId: target.accountId,
                connected: false,
                authenticated: false,
                error: statusRes.error?.message || "Failed to load status",
              };
            }
          } catch (e) {
            nextStatuses[key] = {
              accountId: target.accountId,
              connected: false,
              authenticated: false,
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }),
      );

      set({ channelStatuses: nextStatuses });
    } finally {
      if (showLoading) {
        set({ channelsLoading: false });
      }
    }
  },

  channelStatus: (channel, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) =>
    get().channelStatuses[channelKey(channel, accountId)] ?? null,

  channelActionState: (channel, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) =>
    get().channelActionLoading[channelKey(channel, accountId)] ?? null,

  channelMessage: (channel, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) =>
    get().channelMessages[channelKey(channel, accountId)] ?? null,

  channelQrCode: (channel, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) =>
    get().channelQrData[channelKey(channel, accountId)] ?? null,

  startChannel: async (channel, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) => {
    const client = get().client;
    if (!client || get().channelActionState(channel, accountId)) {
      return;
    }
    const key = channelKey(channel, accountId);
    set((state) => ({
      channelActionLoading: { ...state.channelActionLoading, [key]: "start" },
      channelMessages: Object.fromEntries(
        Object.entries(state.channelMessages).filter(([k]) => k !== key),
      ),
    }));
    try {
      const res = await client.channelStart(channel, accountId);
      if (!res.ok) {
        set((state) => ({
          channelMessages: {
            ...state.channelMessages,
            [key]: res.error?.message || "Failed to start channel",
          },
        }));
        return;
      }
      set((state) => ({
        channelMessages: { ...state.channelMessages, [key]: "Channel started" },
      }));
      await get().loadChannels(false);
    } finally {
      set((state) => ({
        channelActionLoading: { ...state.channelActionLoading, [key]: null },
      }));
    }
  },

  stopChannel: async (channel, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) => {
    const client = get().client;
    if (!client || get().channelActionState(channel, accountId)) {
      return;
    }
    const key = channelKey(channel, accountId);
    set((state) => ({
      channelActionLoading: { ...state.channelActionLoading, [key]: "stop" },
      channelMessages: Object.fromEntries(
        Object.entries(state.channelMessages).filter(([k]) => k !== key),
      ),
    }));
    try {
      const res = await client.channelStop(channel, accountId);
      if (!res.ok) {
        set((state) => ({
          channelMessages: {
            ...state.channelMessages,
            [key]: res.error?.message || "Failed to stop channel",
          },
        }));
        return;
      }
      set((state) => ({
        channelQrData: { ...state.channelQrData, [key]: null },
        channelMessages: { ...state.channelMessages, [key]: "Channel stopped" },
      }));
      await get().loadChannels(false);
    } finally {
      set((state) => ({
        channelActionLoading: { ...state.channelActionLoading, [key]: null },
      }));
    }
  },

  loginChannel: async (
    channel,
    accountId = DEFAULT_CHANNEL_ACCOUNT_ID,
    force = false,
  ) => {
    const client = get().client;
    if (!client || get().channelActionState(channel, accountId)) {
      return;
    }
    const key = channelKey(channel, accountId);
    set((state) => ({
      channelActionLoading: { ...state.channelActionLoading, [key]: "login" },
      channelMessages: Object.fromEntries(
        Object.entries(state.channelMessages).filter(([k]) => k !== key),
      ),
    }));
    try {
      const res = await client.channelLogin(channel, accountId, force);
      if (!res.ok) {
        set((state) => ({
          channelMessages: {
            ...state.channelMessages,
            [key]: res.error?.message || "Failed to login",
          },
        }));
        return;
      }
      const data = (res.payload as ChannelLoginResult | undefined) || null;
      set((state) => ({
        channelQrData: { ...state.channelQrData, [key]: data?.qrDataUrl || null },
        channelMessages: {
          ...state.channelMessages,
          [key]: data?.message || "Login started",
        },
      }));
      await get().loadChannels(false);
    } finally {
      set((state) => ({
        channelActionLoading: { ...state.channelActionLoading, [key]: null },
      }));
    }
  },

  logoutChannel: async (channel, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) => {
    const client = get().client;
    if (!client || get().channelActionState(channel, accountId)) {
      return;
    }
    const key = channelKey(channel, accountId);
    set((state) => ({
      channelActionLoading: { ...state.channelActionLoading, [key]: "logout" },
      channelMessages: Object.fromEntries(
        Object.entries(state.channelMessages).filter(([k]) => k !== key),
      ),
    }));
    try {
      const res = await client.channelLogout(channel, accountId);
      if (!res.ok) {
        set((state) => ({
          channelMessages: {
            ...state.channelMessages,
            [key]: res.error?.message || "Failed to logout",
          },
        }));
        return;
      }
      set((state) => ({
        channelQrData: { ...state.channelQrData, [key]: null },
        channelMessages: { ...state.channelMessages, [key]: "Logged out" },
      }));
      await get().loadChannels(false);
    } finally {
      set((state) => ({
        channelActionLoading: { ...state.channelActionLoading, [key]: null },
      }));
    }
  },

  loadTools: async () => {
    const client = get().client;
    if (!client) {
      return;
    }
    set({ toolsLoading: true });
    try {
      const res = await client.toolsList();
      if (res.ok && res.payload) {
        const data = res.payload as { tools: ToolDefinition[] };
        set({ tools: data.tools || [] });
      }
    } finally {
      set({ toolsLoading: false });
    }
  },

  loadWorkspace: async (path = "/") => {
    const client = get().client;
    if (!client) {
      return;
    }
    const normalizedPath = normalizeWorkspacePath(path);
    set({
      workspaceLoading: true,
      workspaceCurrentPath: normalizedPath,
    });
    try {
      const res = await client.workspaceList(normalizedPath);
      if (res.ok && res.payload) {
        const payload = res.payload as WorkspaceListing;
        set({
          workspaceFiles: {
            path: normalizeWorkspacePath(payload.path),
            files: payload.files || [],
            directories: payload.directories || [],
          },
        });
      }
    } finally {
      set({ workspaceLoading: false });
    }
  },

  readWorkspaceFile: async (path) => {
    const client = get().client;
    if (!client) {
      return;
    }
    const res = await client.workspaceRead(path);
    if (res.ok && res.payload) {
      set({ workspaceFileContent: res.payload as WorkspaceFileContent });
    }
  },

  writeWorkspaceFile: async (path, content) => {
    const client = get().client;
    if (!client) {
      return;
    }
    await client.workspaceWrite(path, content);
    set({ workspaceFileContent: { path, content } });
    await get().loadWorkspace(get().workspaceCurrentPath);
  },

  loadConfig: async () => {
    const client = get().client;
    if (!client) {
      return;
    }
    set({ configLoading: true });
    try {
      const res = await client.configGet();
      if (res.ok && res.payload) {
        const data = res.payload as { config: Record<string, unknown> };
        set({ config: data.config });
      }
    } finally {
      set({ configLoading: false });
    }
  },

  saveConfig: async (path, value) => {
    const client = get().client;
    if (!client) {
      return;
    }
    await client.configSet(path, value);
    await get().loadConfig();
  },

  loadCron: async () => {
    const client = get().client;
    if (!client) {
      return;
    }
    set({ cronLoading: true });
    try {
      const [statusRes, listRes] = await Promise.all([
        client.cronStatus(),
        client.cronList({ includeDisabled: true }),
      ]);
      if (statusRes.ok && statusRes.payload) {
        set({ cronStatus: statusRes.payload as Record<string, unknown> });
      }
      if (listRes.ok && listRes.payload) {
        const data = listRes.payload as { jobs: unknown[] };
        set({ cronJobs: data.jobs || [] });
      }
    } finally {
      set({ cronLoading: false });
    }
  },

  loadCronRuns: async (jobId) => {
    const client = get().client;
    if (!client) {
      return;
    }
    const res = await client.cronRuns({ jobId, limit: 50 });
    if (res.ok && res.payload) {
      const data = res.payload as { runs: unknown[] };
      set({ cronRuns: data.runs || [] });
    }
  },

  setCronTab: (tab) => {
    set({ cronTab: tab });
  },

  cronAdd: async (input) => {
    const client = get().client;
    if (!client) {
      return;
    }
    await client.cronAdd(input as Record<string, unknown>);
    await get().loadCron();
  },

  cronUpdate: async (jobId, patch) => {
    const client = get().client;
    if (!client) {
      return;
    }
    await client.cronUpdate(jobId, patch);
    await get().loadCron();
  },

  cronRemove: async (jobId) => {
    const client = get().client;
    if (!client) {
      return;
    }
    await client.cronRemove(jobId);
    await get().loadCron();
  },

  cronRun: async (params) => {
    const client = get().client;
    if (!client) {
      return;
    }
    await client.cronRun(params);
    await get().loadCron();
    await get().loadCronRuns(params?.id);
  },

  setLogsNodeId: (nodeId) => set({ logsNodeId: nodeId }),

  setLogsLines: (lines) => set({ logsLines: lines }),

  loadLogs: async (params) => {
    const client = get().client;
    if (!client) {
      return;
    }
    const selectedNodeId = params?.nodeId ?? get().logsNodeId;
    const nodeId = selectedNodeId || undefined;
    const lines = params?.lines ?? get().logsLines;
    set({ logsLoading: true, logsError: null });
    try {
      const res = await client.logsGet({ nodeId, lines });
      if (res.ok && res.payload) {
        set({ logsData: res.payload as LogsData });
      } else {
        set({ logsError: res.error?.message || "Failed to fetch logs" });
      }
    } catch (e) {
      set({ logsError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ logsLoading: false });
    }
  },

  loadPairing: async () => {
    const client = get().client;
    if (!client) {
      return;
    }
    set({ pairingLoading: true });
    try {
      const res = await client.pairList();
      if (res.ok && res.payload) {
        const data = res.payload as { pairs: Record<string, unknown> };
        const pairs = Object.entries(data.pairs || {}).map(([key, val]) => {
          const pair = val as Record<string, unknown>;
          return {
            channel: (pair.channel as string) || key.split(":")[0] || "unknown",
            senderId: (pair.senderId as string) || key,
            senderName: pair.senderName as string | undefined,
            requestedAt: (pair.requestedAt as number) || Date.now(),
            message: pair.message as string | undefined,
          };
        });
        set({ pairingRequests: pairs });
      }
    } finally {
      set({ pairingLoading: false });
    }
  },

  pairApprove: async (channel, senderId) => {
    const client = get().client;
    if (!client) {
      return;
    }
    await client.pairApprove(channel, senderId);
    await get().loadPairing();
  },

  pairReject: async (channel, senderId) => {
    const client = get().client;
    if (!client) {
      return;
    }
    await client.pairReject(channel, senderId);
    await get().loadPairing();
  },

  updateSettings: (updates) => {
    const nextSettings = { ...get().settings, ...updates };
    set({ settings: nextSettings });
    saveSettings(updates);

    if (updates.theme) {
      applyTheme(updates.theme);
    }

    if (updates.gatewayUrl || updates.token !== undefined) {
      get().startConnection();
    }
  },

  clearDebugLog: () => {
    set({ debugLog: [] });
  },

  rpcRequest: async (method, params) => {
    const client = get().client;
    if (!client) {
      throw new Error("Not connected");
    }
    return client.request(method, params);
  },
}));

function mergeAssistantMessages(
  current: AssistantMessage,
  incoming: AssistantMessage,
): AssistantMessage {
  if (isContentSuperset(incoming.content, current.content)) {
    return incoming;
  }
  if (isContentSuperset(current.content, incoming.content)) {
    return current;
  }

  return {
    role: "assistant",
    timestamp: incoming.timestamp ?? current.timestamp ?? Date.now(),
    content: mergeContentBlocks(current.content, incoming.content),
  };
}

function isContentSuperset(
  maybeSuperset: ContentBlock[],
  maybeSubset: ContentBlock[],
): boolean {
  if (maybeSuperset.length < maybeSubset.length) {
    return false;
  }

  for (let i = 0; i < maybeSubset.length; i++) {
    if (!blockContains(maybeSuperset[i], maybeSubset[i])) {
      return false;
    }
  }

  return true;
}

function blockContains(
  maybeSuperset: ContentBlock | undefined,
  maybeSubset: ContentBlock | undefined,
): boolean {
  if (!maybeSuperset || !maybeSubset || maybeSuperset.type !== maybeSubset.type) {
    return false;
  }

  if (maybeSuperset.type === "text" && maybeSubset.type === "text") {
    return maybeSuperset.text.startsWith(maybeSubset.text);
  }

  if (maybeSuperset.type === "thinking" && maybeSubset.type === "thinking") {
    return maybeSuperset.text.startsWith(maybeSubset.text);
  }

  if (maybeSuperset.type === "toolCall" && maybeSubset.type === "toolCall") {
    return (
      maybeSuperset.id === maybeSubset.id &&
      maybeSuperset.name === maybeSubset.name
    );
  }

  if (maybeSuperset.type === "image" && maybeSubset.type === "image") {
    if (maybeSuperset.r2Key && maybeSubset.r2Key) {
      return maybeSuperset.r2Key === maybeSubset.r2Key;
    }
    if (maybeSuperset.url && maybeSubset.url) {
      return maybeSuperset.url === maybeSubset.url;
    }
    if (maybeSuperset.data && maybeSubset.data) {
      return maybeSuperset.data === maybeSubset.data;
    }
    return false;
  }

  return false;
}

function mergeContentBlocks(
  current: ContentBlock[],
  incoming: ContentBlock[],
): ContentBlock[] {
  const merged = [...current];

  for (const block of incoming) {
    const last = merged[merged.length - 1];

    if (last?.type === "text" && block.type === "text") {
      if (block.text.startsWith(last.text)) {
        merged[merged.length - 1] = block;
      } else if (!last.text.endsWith(block.text)) {
        merged[merged.length - 1] = {
          ...last,
          text: `${last.text}${block.text}`,
        };
      }
      continue;
    }

    if (last?.type === "thinking" && block.type === "thinking") {
      if (block.text.startsWith(last.text)) {
        merged[merged.length - 1] = block;
      } else if (!last.text.endsWith(block.text)) {
        merged[merged.length - 1] = {
          ...last,
          text: `${last.text}${block.text}`,
        };
      }
      continue;
    }

    const exists = merged.some(
      (existing) =>
        blockContains(existing, block) && blockContains(block, existing),
    );
    if (!exists) {
      merged.push(block);
    }
  }

  return merged;
}
