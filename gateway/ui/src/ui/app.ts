/**
 * GSV App - Main Application Component
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { GatewayClient, type ConnectionState } from "./gateway-client";
import {
  loadSettings,
  saveSettings,
  applyTheme,
  applyShellStyle,
  getGatewayUrl,
  type UiSettings,
} from "./storage";
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
import { TAB_GROUPS, TAB_ICONS, TAB_LABELS, WINDOW_DEFAULTS, type WindowState } from "./types";

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

function normalizeContentBlocks(content: unknown[]): ContentBlock[] {
  return content.map((block) => {
    if (!block || typeof block !== "object") {
      return block as ContentBlock;
    }

    const candidate = block as Record<string, unknown>;
    if (candidate.type === "thinking") {
      return {
        ...candidate,
        type: "thinking",
        text: typeof candidate.text === "string"
          ? candidate.text
          : typeof candidate.thinking === "string"
            ? candidate.thinking
            : "",
      } as ContentBlock;
    }

    return candidate as ContentBlock;
  });
}

function normalizeMessageContent(message: Message): Message {
  if (!Array.isArray(message.content)) {
    return message;
  }

  return {
    ...message,
    content: normalizeContentBlocks(message.content),
  } as Message;
}

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

  // ---- Window Management ----
  @state() openWindows: Record<string, WindowState> = {};
  @state() topZIndex = 10;
  @state() showLauncher = false;
  @state() launcherSearch = "";

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
  private dragState: { active: boolean; tab: string; startX: number; startY: number; initialX: number; initialY: number } = {
    active: false, tab: "", startX: 0, startY: 0, initialX: 0, initialY: 0,
  };
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  @state() private clockText = "";

  // ---- Lifecycle ----

  connectedCallback() {
    super.connectedCallback();
    applyTheme(this.settings.theme);
    applyShellStyle(this.settings.shellStyle);

    // Clock for status bar
    this.updateClock();
    this.clockTimer = setInterval(() => this.updateClock(), 1000);
    
    // Only auto-connect if we have previously connected successfully
    // (token is set or user explicitly clicked connect)
    if (this.settings.token || localStorage.getItem("gsv-connected-once")) {
      this.showConnectScreen = false;
      this.startConnection();
    }
    
    // Handle browser back/forward
    window.addEventListener("popstate", this.handlePopState);

    // Global drag listeners
    window.addEventListener("mousemove", this.onDrag);
    window.addEventListener("mouseup", this.stopDrag);
  }

  protected updated(changed: PropertyValues<this>) {
    if (changed.has("openWindows") || changed.has("connectionState")) {
      this.syncChannelsAutoRefresh();
    }

    if (
      this.openWindows["chat"] &&
      (changed.has("openWindows") ||
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
    window.removeEventListener("mousemove", this.onDrag);
    window.removeEventListener("mouseup", this.stopDrag);
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private handlePopState = () => {
    const tab = getCurrentTab();
    this.tab = tab;
    this.openWindow(tab);
  };

  private updateClock() {
    const now = new Date();
    this.clockText = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // ---- Window Management ----

  openWindow(tab: Tab) {
    if (this.openWindows[tab]) {
      // Already open: un-minimize and focus
      if (this.openWindows[tab].minimized) {
        this.openWindows = {
          ...this.openWindows,
          [tab]: { ...this.openWindows[tab], minimized: false },
        };
      }
      this.focusWindow(tab);
      return;
    }

    const defaults = WINDOW_DEFAULTS[tab];
    const offset = Object.keys(this.openWindows).length * 30;
    const newZ = this.topZIndex + 1;
    this.topZIndex = newZ;

    const ws: WindowState = {
      tab,
      x: Math.max(40, Math.round(window.innerWidth / 2 - defaults.width / 2 + offset)),
      y: Math.max(40, Math.round(window.innerHeight / 2 - defaults.height / 2 + offset)),
      width: defaults.width,
      height: defaults.height,
      minimized: false,
      maximized: false,
      zIndex: newZ,
    };

    this.openWindows = { ...this.openWindows, [tab]: ws };
    this.tab = tab;
    navigateTo(tab);
    this.loadTabData(tab);
  }

  closeWindow(tab: string) {
    const next = { ...this.openWindows };
    delete next[tab];
    this.openWindows = next;
  }

  minimizeWindow(tab: string) {
    if (!this.openWindows[tab]) return;
    this.openWindows = {
      ...this.openWindows,
      [tab]: { ...this.openWindows[tab], minimized: !this.openWindows[tab].minimized },
    };
  }

  maximizeWindow(tab: string) {
    if (!this.openWindows[tab]) return;
    this.openWindows = {
      ...this.openWindows,
      [tab]: { ...this.openWindows[tab], maximized: !this.openWindows[tab].maximized },
    };
  }

  focusWindow(tab: string) {
    if (!this.openWindows[tab]) return;
    const newZ = this.topZIndex + 1;
    this.topZIndex = newZ;
    this.openWindows = {
      ...this.openWindows,
      [tab]: { ...this.openWindows[tab], zIndex: newZ },
    };
    this.tab = tab as Tab;
    navigateTo(tab as Tab);
  }

  private startWindowDrag(e: MouseEvent, tab: string) {
    if ((e.target as HTMLElement).closest(".window-controls")) return;
    if (this.openWindows[tab]?.maximized) return;

    e.preventDefault();
    this.focusWindow(tab);

    this.dragState = {
      active: true,
      tab,
      startX: e.clientX,
      startY: e.clientY,
      initialX: this.openWindows[tab].x,
      initialY: this.openWindows[tab].y,
    };

    document.body.classList.add("os-dragging");
  }

  private onDrag = (e: MouseEvent) => {
    if (!this.dragState.active) return;
    e.preventDefault();

    const dx = e.clientX - this.dragState.startX;
    const dy = e.clientY - this.dragState.startY;
    let newY = this.dragState.initialY + dy;
    if (newY < 32) newY = 32; // Don't go above status bar

    const tab = this.dragState.tab;
    if (!this.openWindows[tab]) return;

    this.openWindows = {
      ...this.openWindows,
      [tab]: {
        ...this.openWindows[tab],
        x: this.dragState.initialX + dx,
        y: newY,
      },
    };
  };

  private stopDrag = () => {
    if (!this.dragState.active) return;
    this.dragState.active = false;
    document.body.classList.remove("os-dragging");
  };

  toggleLauncher() {
    this.showLauncher = !this.showLauncher;
    this.launcherSearch = "";
  }

  private closeLauncherOnBackdrop(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("launcher-overlay")) {
      this.showLauncher = false;
      this.launcherSearch = "";
    }
  }

  private launchFromLauncher(tab: Tab) {
    this.showLauncher = false;
    this.launcherSearch = "";
    this.openWindow(tab);
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
      !!this.openWindows["channels"] && this.connectionState === "connected";

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
    this.openWindow(tab);
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
        this.chatMessages = (data.messages || []).map((message) =>
          normalizeMessageContent(message),
        );
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
      content: normalizeContentBlocks(candidate.content),
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
    if (updates.shellStyle) {
      applyShellStyle(updates.shellStyle);
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

    const allTabs: Tab[] = TAB_GROUPS.flatMap(g => g.tabs);
    // Pinned tabs always show in dock; non-pinned only when open
    const dockTabs = allTabs.filter(t => WINDOW_DEFAULTS[t].pinned || this.openWindows[t]);

    return html`
      <!-- Ambient Background -->
      <div class="ambient-bg">
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
        <div class="orb orb-3"></div>
      </div>

      <!-- Status Bar -->
      <div class="status-bar">
        <div class="status-left">
          <div class="status-btn" style="font-weight: 700;">GSV</div>
          <div class="status-btn">
            <span class="status-dot ${this.connectionState}"></span>
            ${this.connectionState === "connected" ? "Connected" :
              this.connectionState === "connecting" ? "Connecting..." :
              "Disconnected"}
          </div>
        </div>
        <div class="status-right">
          <div class="status-btn" @click=${() => this.disconnect()} title="Disconnect">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          </div>
          <div class="status-btn">${this.clockText}</div>
        </div>
      </div>

      <!-- Desktop Area (contains windows) -->
      <div class="desktop">
        ${Object.values(this.openWindows).map(ws => this.renderWindow(ws))}
      </div>

      <!-- Launcher Overlay -->
      <div
        class="launcher-overlay ${this.showLauncher ? "show" : ""}"
        @click=${(e: MouseEvent) => this.closeLauncherOnBackdrop(e)}
      >
        <div class="launcher">
          <div class="launcher-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="text"
              placeholder="Search apps..."
              .value=${this.launcherSearch}
              @input=${(e: Event) => { this.launcherSearch = (e.target as HTMLInputElement).value; }}
            />
          </div>
          <div class="launcher-grid">
            ${allTabs
              .filter(t => !this.launcherSearch || TAB_LABELS[t].toLowerCase().includes(this.launcherSearch.toLowerCase()))
              .map(t => html`
                <button
                  class="launcher-item"
                  @click=${() => this.launchFromLauncher(t)}
                >
                  ${unsafeHTML(TAB_ICONS[t])}
                  <span>${TAB_LABELS[t]}</span>
                </button>
              `)}
          </div>
        </div>
      </div>

      <!-- Dock -->
      <div class="dock-container">
        <div class="dock">
          <button
            class="dock-item"
            @click=${() => this.toggleLauncher()}
            title="App Launcher"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          </button>
          <div class="dock-separator"></div>
          ${dockTabs.map(t => {
            const isOpen = !!this.openWindows[t];
            const isFocused = isOpen && this.openWindows[t].zIndex === this.topZIndex;
            return html`
              <button
                class="dock-item ${isOpen ? "running" : ""} ${isFocused ? "focused" : ""}"
                @click=${() => {
                  if (!isOpen) {
                    this.openWindow(t);
                  } else if (this.openWindows[t].minimized) {
                    this.minimizeWindow(t);
                  } else if (isFocused) {
                    this.minimizeWindow(t);
                  } else {
                    this.focusWindow(t);
                  }
                }}
                title=${TAB_LABELS[t]}
              >
                ${unsafeHTML(TAB_ICONS[t])}
              </button>
            `;
          })}
        </div>
      </div>
    `;
  }

  private renderWindow(ws: WindowState) {
    const isChat = ws.tab === "chat";
    const isDragging = this.dragState.active && this.dragState.tab === ws.tab;

    return html`
      <div
        class="window visible ${ws.minimized ? "minimized" : ""} ${ws.maximized ? "maximized" : ""} ${isDragging ? "dragging" : ""}"
        style="left:${ws.x}px; top:${ws.y}px; width:${ws.width}px; height:${ws.height}px; z-index:${ws.zIndex};"
        @mousedown=${() => this.focusWindow(ws.tab)}
      >
        <div
          class="window-header"
          @mousedown=${(e: MouseEvent) => this.startWindowDrag(e, ws.tab)}
          @dblclick=${() => this.maximizeWindow(ws.tab)}
        >
          <div class="window-controls">
            <button class="control-btn btn-close" @click=${(e: Event) => { e.stopPropagation(); this.closeWindow(ws.tab); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <button class="control-btn btn-minimize" @click=${(e: Event) => { e.stopPropagation(); this.minimizeWindow(ws.tab); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="control-btn btn-maximize" @click=${(e: Event) => { e.stopPropagation(); this.maximizeWindow(ws.tab); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            </button>
          </div>
          <div class="window-title">${TAB_LABELS[ws.tab]}</div>
        </div>
        <div class="window-content ${isChat ? "chat-content" : ""}">
          ${this.renderViewContent(ws.tab)}
        </div>
      </div>
    `;
  }

  private renderConnectScreen() {
    const isConnecting = this.connectionState === "connecting";
    
    return html`
      <!-- Ambient Background -->
      <div class="ambient-bg">
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
        <div class="orb orb-3"></div>
      </div>

      <div class="connect-screen">
        <div class="connect-card">
          <div class="connect-header">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--accent-primary);">
              <polygon points="12 2 2 7 12 12 22 7 12 2"/>
              <polyline points="2 17 12 22 22 17"/>
              <polyline points="2 12 12 17 22 12"/>
            </svg>
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
        </div>
      </div>
    `;
  }

  private renderViewContent(tab: Tab) {
    switch (tab) {
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

function getThinkingText(block: { text?: unknown; thinking?: unknown }): string {
  if (typeof block.text === "string") {
    return block.text;
  }
  if (typeof block.thinking === "string") {
    return block.thinking;
  }
  return "";
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
    return getThinkingText(maybeSuperset).startsWith(getThinkingText(maybeSubset));
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
      const lastText = getThinkingText(last);
      const blockText = getThinkingText(block);
      if (blockText.startsWith(lastText)) {
        merged[merged.length - 1] = {
          ...block,
          text: blockText,
        } as ContentBlock;
      } else if (!lastText.endsWith(blockText)) {
        merged[merged.length - 1] = {
          ...last,
          text: `${lastText}${blockText}`,
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
