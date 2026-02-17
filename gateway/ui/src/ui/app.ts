/**
 * GSV App - Main Application Component
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";
import { GatewayClient, type ConnectionState } from "./gateway-client";
import { loadSettings, saveSettings, applyTheme, getGatewayUrl, type UiSettings } from "./storage";
import { navigateTo, getCurrentTab } from "./navigation";
import type {
  Tab,
  EventFrame,
  SessionRegistryEntry,
  ChatEventPayload,
  Message,
  AssistantMessage,
  ToolDefinition,
  ChannelRegistryEntry,
  ChannelAccountStatus,
  ChannelStatusResult,
  ChannelLoginResult,
  ContentBlock,
} from "./types";
import { TAB_GROUPS, TAB_ICONS, TAB_LABELS } from "./types";

// View imports
import { renderChat } from "./views/chat";
import { renderOverview } from "./views/overview";
import { renderSessions } from "./views/sessions";
import { renderChannels } from "./views/channels";
import { renderNodes } from "./views/nodes";
import { renderWorkspace } from "./views/workspace";
import { renderCron } from "./views/cron";
import { renderLogs } from "./views/logs";
import { renderPairing } from "./views/pairing";
import { renderConfig } from "./views/config";
import { renderDebug } from "./views/debug";

const DEFAULT_CHANNEL_ACCOUNT_ID = "default";
const CHANNEL_AUTO_REFRESH_MS = 10_000;
const DEFAULT_CHANNELS = ["whatsapp", "discord"];

@customElement("gsv-app")
export class GsvApp extends LitElement {
  // Disable shadow DOM to use global styles
  createRenderRoot() {
    return this;
  }

  // ---- Connection State ----
  @state() connectionState: ConnectionState = "disconnected";
  @state() settings: UiSettings = loadSettings();
  @state() connectionError: string | null = null;
  @state() showConnectScreen = true; // Show connect screen until first successful connection
  
  client: GatewayClient | null = null;

  // ---- Navigation ----
  @state() tab: Tab = getCurrentTab();
  @state() navDrawerOpen = false;
  @state() isMobileLayout = false;

  // ---- Chat State ----
  @state() chatMessages: Message[] = [];
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatStream: AssistantMessage | null = null;
  @state() currentRunId: string | null = null;

  // ---- Sessions State ----
  @state() sessions: SessionRegistryEntry[] = [];
  @state() sessionsLoading = false;

  // ---- Channels State ----
  @state() channels: ChannelRegistryEntry[] = [];
  @state() channelsLoading = false;
  @state() channelsError: string | null = null;
  @state() channelStatuses: Record<string, ChannelAccountStatus | null> = {};
  @state() channelActionLoading: Record<string, string | null> = {};
  @state() channelMessages: Record<string, string> = {};
  @state() channelQrData: Record<string, string | null> = {};

  // ---- Nodes State ----
  @state() tools: ToolDefinition[] = [];
  @state() toolsLoading = false;

  // ---- Workspace State ----
  @state() workspaceFiles: { path: string; files: string[]; directories: string[] } | null = null;
  @state() workspaceLoading = false;
  @state() workspaceCurrentPath = "/";
  @state() workspaceFileContent: { path: string; content: string } | null = null;

  // ---- Config State ----
  @state() config: Record<string, unknown> | null = null;
  @state() configLoading = false;

  // ---- Debug State ----
  @state() debugLog: { time: Date; type: string; data: unknown }[] = [];

  // ---- Cron State ----
  @state() cronStatus: Record<string, unknown> | null = null;
  @state() cronJobs: unknown[] = [];
  @state() cronRuns: unknown[] = [];
  @state() cronLoading = false;
  @state() cronTab = "jobs";

  // ---- Logs State ----
  @state() logsData: { nodeId: string; lines: string[]; count: number; truncated: boolean } | null = null;
  @state() logsLoading = false;
  @state() logsError: string | null = null;

  // ---- Pairing State ----
  @state() pairingRequests: unknown[] = [];
  @state() pairingLoading = false;

  private chatAutoScrollRaf: number | null = null;
  private chatStreamRunId: string | null = null;
  private channelsRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private mobileMediaQuery: MediaQueryList | null = null;

  // ---- Lifecycle ----

  connectedCallback() {
    super.connectedCallback();
    applyTheme(this.settings.theme);
    this.mobileMediaQuery = window.matchMedia("(max-width: 960px)");
    this.isMobileLayout = this.mobileMediaQuery.matches;
    this.mobileMediaQuery.addEventListener("change", this.handleMobileMedia);
    
    // Only auto-connect if we have previously connected successfully
    // (token is set or user explicitly clicked connect)
    if (this.settings.token || localStorage.getItem("gsv-connected-once")) {
      this.showConnectScreen = false;
      this.startConnection();
    }
    
    // Handle browser back/forward
    window.addEventListener("popstate", this.handlePopState);
  }

  protected updated(changed: PropertyValues<this>) {
    if (changed.has("tab") || changed.has("connectionState")) {
      this.syncChannelsAutoRefresh();
    }

    if (
      this.tab === "chat" &&
      (changed.has("tab") ||
        changed.has("chatMessages") ||
        changed.has("chatStream") ||
        changed.has("chatLoading") ||
        changed.has("chatSending"))
    ) {
      this.scheduleChatAutoScroll();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.chatAutoScrollRaf !== null) {
      cancelAnimationFrame(this.chatAutoScrollRaf);
      this.chatAutoScrollRaf = null;
    }
    this.stopChannelsAutoRefresh();
    this.client?.stop();
    window.removeEventListener("popstate", this.handlePopState);
    this.mobileMediaQuery?.removeEventListener("change", this.handleMobileMedia);
    this.mobileMediaQuery = null;
  }

  private handlePopState = () => {
    this.tab = getCurrentTab();
    this.closeNavDrawer();
  };

  private handleMobileMedia = (event: MediaQueryListEvent) => {
    this.isMobileLayout = event.matches;
    if (!event.matches) {
      this.navDrawerOpen = false;
    }
  };

  private toggleNavDrawer() {
    if (!this.isMobileLayout) {
      return;
    }
    this.navDrawerOpen = !this.navDrawerOpen;
  }

  private closeNavDrawer() {
    if (!this.navDrawerOpen) {
      return;
    }
    this.navDrawerOpen = false;
  }

  private scheduleChatAutoScroll() {
    if (this.chatAutoScrollRaf !== null) {
      cancelAnimationFrame(this.chatAutoScrollRaf);
    }

    this.chatAutoScrollRaf = requestAnimationFrame(() => {
      this.chatAutoScrollRaf = null;
      const container = this.querySelector(".chat-messages");
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  private syncChannelsAutoRefresh() {
    const shouldRefresh =
      this.tab === "channels" && this.connectionState === "connected";

    if (!shouldRefresh) {
      this.stopChannelsAutoRefresh();
      return;
    }

    if (this.channelsRefreshTimer) {
      return;
    }

    this.channelsRefreshTimer = setInterval(() => {
      void this.loadChannels(false);
    }, CHANNEL_AUTO_REFRESH_MS);
  }

  private stopChannelsAutoRefresh() {
    if (!this.channelsRefreshTimer) {
      return;
    }

    clearInterval(this.channelsRefreshTimer);
    this.channelsRefreshTimer = null;
  }

  // ---- Connection ----

  private startConnection() {
    if (this.client) {
      this.client.stop();
    }

    this.connectionError = null;

    this.client = new GatewayClient({
      url: getGatewayUrl(this.settings),
      token: this.settings.token || undefined,
      onStateChange: (state) => {
        this.connectionState = state;
        if (state === "connected") {
          this.connectionError = null;
          this.showConnectScreen = false;
          localStorage.setItem("gsv-connected-once", "true");
          this.onConnected();
        }
      },
      onError: (error) => {
        this.connectionError = error;
      },
      onEvent: (event) => this.handleEvent(event),
    });

    this.client.start();
  }

  /** Manual connect triggered from connect screen */
  connect() {
    this.showConnectScreen = false;
    this.startConnection();
  }

  /** Disconnect and show connect screen */
  disconnect() {
    this.stopChannelsAutoRefresh();
    this.client?.stop();
    this.showConnectScreen = true;
    localStorage.removeItem("gsv-connected-once");
  }

  private async onConnected() {
    // Load essential data on connect (for Overview)
    await Promise.all([
      this.loadTools(),
      this.loadSessions(),
      this.loadChannels(),
    ]);
    
    // Then load tab-specific data
    this.loadTabData(this.tab);
  }

  private handleEvent(event: EventFrame) {
    this.debugLog = [...this.debugLog.slice(-99), { time: new Date(), type: event.event, data: event.payload }];
    
    if (event.event === "chat") {
      this.handleChatEvent(event.payload as ChatEventPayload);
    }
  }

  // ---- Tab Navigation ----

  switchTab(tab: Tab) {
    if (this.tab !== tab) {
      this.tab = tab;
      navigateTo(tab);
      this.loadTabData(tab);
    }
    this.closeNavDrawer();
  }

  private async loadTabData(tab: Tab) {
    if (!this.client || this.connectionState !== "connected") return;

    switch (tab) {
      case "chat":
        await this.loadChatHistory();
        break;
      case "sessions":
        await this.loadSessions();
        break;
      case "channels":
        await this.loadChannels();
        break;
      case "nodes":
        await this.loadTools();
        break;
      case "workspace":
        await this.loadWorkspace();
        break;
      case "config":
        await this.loadConfig();
        break;
      case "cron":
        await this.loadCron();
        break;
      case "logs":
        // Logs are loaded on demand via button
        break;
      case "pairing":
        await this.loadPairing();
        break;
    }
  }

  // ---- Chat ----

  private async loadChatHistory() {
    if (!this.client) return;
    this.chatLoading = true;
    try {
      const res = await this.client.sessionPreview(this.settings.sessionKey, 100);
      if (res.ok && res.payload) {
        const data = res.payload as { messages: Message[] };
        this.chatMessages = data.messages || [];
      }
    } catch (e) {
      console.error("Failed to load chat:", e);
    } finally {
      this.chatLoading = false;
    }
  }

  async sendMessage(text: string) {
    if (!this.client || !text.trim()) return;
    
    this.chatSending = true;
    this.currentRunId = crypto.randomUUID();
    this.chatStream = null;
    this.chatStreamRunId = null;
    
    // Optimistic update
    this.chatMessages = [
      ...this.chatMessages,
      { role: "user", content: text, timestamp: Date.now() },
    ];
    
    try {
      await this.client.chatSend(this.settings.sessionKey, text, this.currentRunId);
    } catch (e) {
      console.error("Failed to send:", e);
      this.chatSending = false;
      this.currentRunId = null;
    }
  }

  private normalizeAssistantMessage(message: unknown): AssistantMessage | null {
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

  private handleChatEvent(payload: ChatEventPayload) {
    if (payload.sessionKey !== this.settings.sessionKey) return;
    const matchesCurrentRun =
      !this.currentRunId || !payload.runId || payload.runId === this.currentRunId;

    if (payload.state === "partial" && payload.message) {
      const incoming = this.normalizeAssistantMessage(payload.message);
      if (!incoming) {
        return;
      }

      if (
        this.chatStream &&
        payload.runId &&
        this.chatStreamRunId === payload.runId
      ) {
        this.chatStream = mergeAssistantMessages(this.chatStream, incoming);
      } else {
        this.chatStream = incoming;
      }

      this.chatStreamRunId = payload.runId ?? this.chatStreamRunId;
    } else if (payload.state === "final") {
      const finalMessage = payload.message
        ? this.normalizeAssistantMessage(payload.message)
        : null;
      if (finalMessage) {
        this.chatMessages = [...this.chatMessages, finalMessage];
      }

      this.chatStream = null;
      this.chatStreamRunId = null;

      if (matchesCurrentRun) {
        this.chatSending = false;
        this.currentRunId = null;
      }

      // Refresh from source of truth so toolResult messages are included.
      void this.loadChatHistory();
    } else if (payload.state === "error") {
      this.chatStream = null;
      this.chatStreamRunId = null;
      if (matchesCurrentRun) {
        this.chatSending = false;
        this.currentRunId = null;
      }
      console.error("Chat error:", payload.error);
    }
  }

  // ---- Sessions ----

  private async loadSessions() {
    if (!this.client) return;
    this.sessionsLoading = true;
    try {
      const res = await this.client.sessionsList();
      if (res.ok && res.payload) {
        const data = res.payload as { sessions: SessionRegistryEntry[] };
        this.sessions = data.sessions || [];
      }
    } catch (e) {
      console.error("Failed to load sessions:", e);
    } finally {
      this.sessionsLoading = false;
    }
  }

  async selectSession(sessionKey: string) {
    this.settings = { ...this.settings, sessionKey };
    saveSettings({ sessionKey });
    this.switchTab("chat");
    await this.loadChatHistory();
  }

  async resetSession(sessionKey: string) {
    if (!this.client) return;
    if (!confirm(`Reset session ${sessionKey}? This will archive all messages.`)) return;
    
    try {
      await this.client.sessionReset(sessionKey);
      await this.loadSessions();
      if (sessionKey === this.settings.sessionKey) {
        this.chatMessages = [];
      }
    } catch (e) {
      console.error("Failed to reset session:", e);
    }
  }

  // ---- Channels ----

  private channelKey(channel: string, accountId = DEFAULT_CHANNEL_ACCOUNT_ID): string {
    return `${channel}:${accountId}`;
  }

  private setChannelActionState(
    channel: string,
    accountId: string,
    action: string | null,
  ) {
    const key = this.channelKey(channel, accountId);
    this.channelActionLoading = {
      ...this.channelActionLoading,
      [key]: action,
    };
  }

  private setChannelMessage(channel: string, accountId: string, message: string | null) {
    const key = this.channelKey(channel, accountId);
    const next = { ...this.channelMessages };
    if (message) {
      next[key] = message;
    } else {
      delete next[key];
    }
    this.channelMessages = next;
  }

  private setChannelQrData(channel: string, accountId: string, qrDataUrl: string | null) {
    const key = this.channelKey(channel, accountId);
    this.channelQrData = {
      ...this.channelQrData,
      [key]: qrDataUrl,
    };
  }

  channelStatus(channel: string, accountId = DEFAULT_CHANNEL_ACCOUNT_ID): ChannelAccountStatus | null {
    return this.channelStatuses[this.channelKey(channel, accountId)] ?? null;
  }

  channelActionState(channel: string, accountId = DEFAULT_CHANNEL_ACCOUNT_ID): string | null {
    return this.channelActionLoading[this.channelKey(channel, accountId)] ?? null;
  }

  channelMessage(channel: string, accountId = DEFAULT_CHANNEL_ACCOUNT_ID): string | null {
    return this.channelMessages[this.channelKey(channel, accountId)] ?? null;
  }

  channelQrCode(channel: string, accountId = DEFAULT_CHANNEL_ACCOUNT_ID): string | null {
    return this.channelQrData[this.channelKey(channel, accountId)] ?? null;
  }

  private getKnownChannels(): string[] {
    const known = new Set<string>(DEFAULT_CHANNELS);
    for (const entry of this.channels) {
      known.add(entry.channel);
    }
    return Array.from(known);
  }

  private async loadChannelStatuses() {
    if (!this.client) {
      return;
    }

    const targets = new Map<string, { channel: string; accountId: string }>();
    for (const channel of this.getKnownChannels()) {
      const key = this.channelKey(channel, DEFAULT_CHANNEL_ACCOUNT_ID);
      targets.set(key, { channel, accountId: DEFAULT_CHANNEL_ACCOUNT_ID });
    }
    for (const entry of this.channels) {
      const key = this.channelKey(entry.channel, entry.accountId);
      targets.set(key, { channel: entry.channel, accountId: entry.accountId });
    }

    const nextStatuses = { ...this.channelStatuses };

    await Promise.all(Array.from(targets.entries()).map(async ([key, target]) => {
      try {
        const res = await this.client!.channelStatus(
          target.channel,
          target.accountId,
        );
        if (res.ok && res.payload) {
          const data = res.payload as ChannelStatusResult;
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
            error: res.error?.message || "Failed to load status",
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
    }));

    this.channelStatuses = nextStatuses;
  }

  async refreshChannels() {
    await this.loadChannels();
  }

  private async loadChannels(showLoading = true) {
    if (!this.client) return;
    if (showLoading) {
      this.channelsLoading = true;
    }
    this.channelsError = null;
    try {
      const res = await this.client.channelsList();
      if (res.ok && res.payload) {
        const data = res.payload as { channels: ChannelRegistryEntry[] };
        this.channels = data.channels || [];
      } else {
        this.channelsError = res.error?.message || "Failed to load channels";
      }
      await this.loadChannelStatuses();
    } catch (e) {
      console.error("Failed to load channels:", e);
      this.channelsError = e instanceof Error ? e.message : String(e);
    } finally {
      if (showLoading) {
        this.channelsLoading = false;
      }
    }
  }

  async startChannel(channel: string, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) {
    if (!this.client) {
      return;
    }

    const currentAction = this.channelActionState(channel, accountId);
    if (currentAction) {
      return;
    }

    this.setChannelActionState(channel, accountId, "start");
    this.setChannelMessage(channel, accountId, null);

    try {
      const res = await this.client.channelStart(channel, accountId);
      if (!res.ok) {
        this.setChannelMessage(
          channel,
          accountId,
          res.error?.message || "Failed to start channel",
        );
        return;
      }

      this.setChannelMessage(channel, accountId, "Channel started");
      await this.loadChannels(false);
    } catch (e) {
      this.setChannelMessage(
        channel,
        accountId,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      this.setChannelActionState(channel, accountId, null);
    }
  }

  async stopChannel(channel: string, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) {
    if (!this.client) {
      return;
    }

    const currentAction = this.channelActionState(channel, accountId);
    if (currentAction) {
      return;
    }

    this.setChannelActionState(channel, accountId, "stop");
    this.setChannelMessage(channel, accountId, null);

    try {
      const res = await this.client.channelStop(channel, accountId);
      if (!res.ok) {
        this.setChannelMessage(
          channel,
          accountId,
          res.error?.message || "Failed to stop channel",
        );
        return;
      }

      this.setChannelQrData(channel, accountId, null);
      this.setChannelMessage(channel, accountId, "Channel stopped");
      await this.loadChannels(false);
    } catch (e) {
      this.setChannelMessage(
        channel,
        accountId,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      this.setChannelActionState(channel, accountId, null);
    }
  }

  async loginChannel(
    channel: string,
    accountId = DEFAULT_CHANNEL_ACCOUNT_ID,
    force = false,
  ) {
    if (!this.client) {
      return;
    }

    const currentAction = this.channelActionState(channel, accountId);
    if (currentAction) {
      return;
    }

    this.setChannelActionState(channel, accountId, "login");
    this.setChannelMessage(channel, accountId, null);

    try {
      const res = await this.client.channelLogin(channel, accountId, force);
      if (!res.ok) {
        this.setChannelMessage(
          channel,
          accountId,
          res.error?.message || "Failed to login",
        );
        return;
      }

      const data = (res.payload as ChannelLoginResult | undefined) || null;
      this.setChannelQrData(channel, accountId, data?.qrDataUrl || null);
      this.setChannelMessage(channel, accountId, data?.message || "Login started");
      await this.loadChannels(false);
    } catch (e) {
      this.setChannelMessage(
        channel,
        accountId,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      this.setChannelActionState(channel, accountId, null);
    }
  }

  async logoutChannel(channel: string, accountId = DEFAULT_CHANNEL_ACCOUNT_ID) {
    if (!this.client) {
      return;
    }

    const currentAction = this.channelActionState(channel, accountId);
    if (currentAction) {
      return;
    }

    this.setChannelActionState(channel, accountId, "logout");
    this.setChannelMessage(channel, accountId, null);

    try {
      const res = await this.client.channelLogout(channel, accountId);
      if (!res.ok) {
        this.setChannelMessage(
          channel,
          accountId,
          res.error?.message || "Failed to logout",
        );
        return;
      }

      this.setChannelQrData(channel, accountId, null);
      this.setChannelMessage(channel, accountId, "Logged out");
      await this.loadChannels(false);
    } catch (e) {
      this.setChannelMessage(
        channel,
        accountId,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      this.setChannelActionState(channel, accountId, null);
    }
  }

  // ---- Nodes / Tools ----

  private async loadTools() {
    if (!this.client) return;
    this.toolsLoading = true;
    try {
      const res = await this.client.toolsList();
      if (res.ok && res.payload) {
        const data = res.payload as { tools: ToolDefinition[] };
        this.tools = data.tools || [];
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    } finally {
      this.toolsLoading = false;
    }
  }

  // ---- Workspace ----

  private normalizeWorkspacePath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed || trimmed === "/") {
      return "/";
    }

    const noLeadingSlash = trimmed.replace(/^\/+/, "");
    const noTrailingSlash = noLeadingSlash.replace(/\/+$/, "");
    return noTrailingSlash || "/";
  }

  async loadWorkspace(path = "/") {
    if (!this.client) return;
    const normalizedPath = this.normalizeWorkspacePath(path);
    this.workspaceLoading = true;
    this.workspaceCurrentPath = normalizedPath;
    try {
      const res = await this.client.workspaceList(normalizedPath);
      if (res.ok && res.payload) {
        const payload = res.payload as {
          path: string;
          files: string[];
          directories: string[];
        };
        this.workspaceFiles = {
          path: this.normalizeWorkspacePath(payload.path),
          files: payload.files || [],
          directories: payload.directories || [],
        };
      }
    } catch (e) {
      console.error("Failed to load workspace:", e);
    } finally {
      this.workspaceLoading = false;
    }
  }

  async readWorkspaceFile(path: string) {
    if (!this.client) return;
    try {
      const res = await this.client.workspaceRead(path);
      if (res.ok && res.payload) {
        this.workspaceFileContent = res.payload as { path: string; content: string };
      }
    } catch (e) {
      console.error("Failed to read file:", e);
    }
  }

  async writeWorkspaceFile(path: string, content: string) {
    if (!this.client) return;
    try {
      await this.client.workspaceWrite(path, content);
      this.workspaceFileContent = { path, content };
      await this.loadWorkspace(this.workspaceCurrentPath);
    } catch (e) {
      console.error("Failed to write file:", e);
    }
  }

  // ---- Config ----

  private async loadConfig() {
    if (!this.client) return;
    this.configLoading = true;
    try {
      const res = await this.client.configGet();
      if (res.ok && res.payload) {
        const data = res.payload as { config: Record<string, unknown> };
        this.config = data.config;
      }
    } catch (e) {
      console.error("Failed to load config:", e);
    } finally {
      this.configLoading = false;
    }
  }

  async saveConfig(path: string, value: unknown) {
    if (!this.client) return;
    try {
      await this.client.configSet(path, value);
      await this.loadConfig();
    } catch (e) {
      console.error("Failed to save config:", e);
    }
  }

  // ---- Cron ----

  async loadCron() {
    if (!this.client) return;
    this.cronLoading = true;
    try {
      const [statusRes, listRes] = await Promise.all([
        this.client.cronStatus(),
        this.client.cronList({ includeDisabled: true }),
      ]);
      if (statusRes.ok && statusRes.payload) {
        this.cronStatus = statusRes.payload as Record<string, unknown>;
      }
      if (listRes.ok && listRes.payload) {
        const data = listRes.payload as { jobs: unknown[] };
        this.cronJobs = data.jobs || [];
      }
    } catch (e) {
      console.error("Failed to load cron:", e);
    } finally {
      this.cronLoading = false;
    }
  }

  async loadCronRuns(jobId?: string) {
    if (!this.client) return;
    try {
      const res = await this.client.cronRuns({ jobId, limit: 50 });
      if (res.ok && res.payload) {
        const data = res.payload as { runs: unknown[] };
        this.cronRuns = data.runs || [];
      }
    } catch (e) {
      console.error("Failed to load cron runs:", e);
    }
  }

  // ---- Logs ----

  async loadLogs() {
    if (!this.client) return;
    this.logsLoading = true;
    this.logsError = null;
    try {
      const nodeId = (document.getElementById("logs-node-id") as HTMLSelectElement)?.value || undefined;
      const lines = parseInt((document.getElementById("logs-lines") as HTMLInputElement)?.value || "200", 10);
      const res = await this.client.logsGet({ nodeId, lines });
      if (res.ok && res.payload) {
        this.logsData = res.payload as { nodeId: string; lines: string[]; count: number; truncated: boolean };
      } else {
        this.logsError = res.error?.message || "Failed to fetch logs";
      }
    } catch (e) {
      this.logsError = e instanceof Error ? e.message : String(e);
    } finally {
      this.logsLoading = false;
    }
  }

  // ---- Pairing ----

  async loadPairing() {
    if (!this.client) return;
    this.pairingLoading = true;
    try {
      const res = await this.client.pairList();
      if (res.ok && res.payload) {
        const data = res.payload as { pairs: Record<string, unknown> };
        // Convert the pairs map to an array for display
        const pairs = Object.entries(data.pairs || {}).map(([key, val]) => {
          const pair = val as Record<string, unknown>;
          return {
            channel: pair.channel as string || key.split(":")[0] || "unknown",
            senderId: pair.senderId as string || key,
            senderName: pair.senderName as string | undefined,
            requestedAt: pair.requestedAt as number || Date.now(),
            message: pair.message as string | undefined,
          };
        });
        this.pairingRequests = pairs;
      }
    } catch (e) {
      console.error("Failed to load pairing requests:", e);
    } finally {
      this.pairingLoading = false;
    }
  }

  // ---- Settings ----

  updateSettings(updates: Partial<UiSettings>) {
    this.settings = { ...this.settings, ...updates };
    saveSettings(updates);
    
    if (updates.theme) {
      applyTheme(updates.theme);
    }
    
    if (updates.gatewayUrl || updates.token !== undefined) {
      this.startConnection();
    }
  }

  // ---- Render ----

  render() {
    // Show connect screen if not connected yet
    if (this.showConnectScreen) {
      return this.renderConnectScreen();
    }

    return html`
      <div class="app-shell ${this.isMobileLayout ? "mobile" : ""} ${this.navDrawerOpen ? "nav-open" : ""}">
        <button
          type="button"
          class="nav-backdrop ${this.navDrawerOpen ? "open" : ""}"
          @click=${() => this.closeNavDrawer()}
          aria-label="Close navigation menu"
        ></button>
        ${this.renderNav()}
        <div class="main-content">
          ${this.renderTopbar()}
          <div class="page-content">
            ${this.renderView()}
          </div>
        </div>
      </div>
    `;
  }

  private renderConnectScreen() {
    const isConnecting = this.connectionState === "connecting";
    
    return html`
      <div class="connect-screen">
        <div class="connect-card">
          <div class="connect-header">
            <span class="connect-logo">🚀</span>
            <h1>GSV</h1>
            <p class="text-secondary">Connect to your Gateway</p>
          </div>
          
          <div class="connect-form">
            <div class="form-group">
              <label class="form-label">Gateway URL</label>
              <input 
                type="text" 
                class="form-input mono"
                placeholder=${getGatewayUrl(this.settings)}
                .value=${this.settings.gatewayUrl}
                @input=${(e: Event) => {
                  this.settings = { ...this.settings, gatewayUrl: (e.target as HTMLInputElement).value };
                }}
                ?disabled=${isConnecting}
              />
              <p class="form-hint">
                ${this.settings.gatewayUrl 
                  ? "Custom WebSocket URL" 
                  : `Will connect to: ${getGatewayUrl(this.settings)}`}
              </p>
            </div>
            
            <div class="form-group">
              <label class="form-label">Auth Token</label>
              <input 
                type="password" 
                class="form-input mono"
                placeholder="Leave empty if no auth required"
                .value=${this.settings.token}
                @input=${(e: Event) => {
                  this.settings = { ...this.settings, token: (e.target as HTMLInputElement).value };
                }}
                ?disabled=${isConnecting}
              />
              <p class="form-hint">Required if your Gateway has authentication enabled</p>
            </div>
            
            ${this.connectionError ? html`
              <div class="connect-error">
                ${this.connectionError}
              </div>
            ` : nothing}
            
            <button 
              class="btn btn-primary btn-lg connect-btn"
              @click=${() => {
                saveSettings({ gatewayUrl: this.settings.gatewayUrl, token: this.settings.token });
                this.connect();
              }}
              ?disabled=${isConnecting}
            >
              ${isConnecting ? html`<span class="spinner"></span> Connecting...` : "Connect"}
            </button>
          </div>
          
          <div class="connect-footer">
            <p class="text-secondary">
              Theme: 
              <button 
                class="btn btn-ghost btn-sm"
                @click=${() => {
                  const newTheme = this.settings.theme === "dark" ? "light" : "dark";
                  this.settings = { ...this.settings, theme: newTheme };
                  saveSettings({ theme: newTheme });
                  applyTheme(newTheme);
                }}
              >
                ${this.settings.theme === "dark" ? "🌙 Dark" : "☀️ Light"}
              </button>
            </p>
          </div>
        </div>
      </div>
    `;
  }

  private renderNav() {
    return html`
      <nav class="nav-sidebar ${this.navDrawerOpen ? "open" : ""}">
        <div class="nav-header">
          <span class="nav-logo">🚀</span>
          <span class="nav-title">GSV</span>
        </div>
        
        <div class="nav-groups">
          ${TAB_GROUPS.map(group => html`
            <div class="nav-group">
              <div class="nav-group-label">${group.label}</div>
              ${group.tabs.map(tab => html`
                <div 
                  class="nav-item ${this.tab === tab ? "active" : ""}"
                  @click=${() => this.switchTab(tab)}
                >
                  <span class="nav-item-icon">${TAB_ICONS[tab]}</span>
                  <span class="nav-item-label">${TAB_LABELS[tab]}</span>
                </div>
              `)}
            </div>
          `)}
        </div>
        
        <div class="nav-footer">
          <div class="connection-status">
            <span class="connection-dot ${this.connectionState}"></span>
            <span>${this.connectionState === "connected" ? "Connected" : 
                   this.connectionState === "connecting" ? "Connecting..." : 
                   "Disconnected"}</span>
          </div>
        </div>
      </nav>
    `;
  }

  private renderTopbar() {
    return html`
      <header class="topbar">
        <div class="topbar-title-wrap">
          <button
            class="btn btn-ghost btn-icon topbar-menu-btn"
            @click=${() => this.toggleNavDrawer()}
            title="Toggle navigation"
            aria-label="Toggle navigation menu"
          >
            ☰
          </button>
          <h1 class="topbar-title">${TAB_LABELS[this.tab]}</h1>
        </div>
        <div class="topbar-actions">
          <button 
            class="btn btn-ghost btn-icon"
            @click=${() => this.updateSettings({ theme: this.settings.theme === "dark" ? "light" : "dark" })}
            title="Toggle theme"
          >
            ${this.settings.theme === "dark" ? "🌙" : "☀️"}
          </button>
        </div>
      </header>
    `;
  }

  private renderView() {
    switch (this.tab) {
      case "chat":
        return renderChat(this);
      case "overview":
        return renderOverview(this);
      case "sessions":
        return renderSessions(this);
      case "channels":
        return renderChannels(this);
      case "nodes":
        return renderNodes(this);
      case "workspace":
        return renderWorkspace(this);
      case "cron":
        return renderCron(this);
      case "logs":
        return renderLogs(this);
      case "pairing":
        return renderPairing(this);
      case "config":
        return renderConfig(this);
      case "debug":
        return renderDebug(this);
      default:
        return html`<div>Unknown view</div>`;
    }
  }
}

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

declare global {
  interface HTMLElementTagNameMap {
    "gsv-app": GsvApp;
  }
}
