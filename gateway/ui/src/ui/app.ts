/**
 * GSV App - Main Application Component
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { GatewayClient, type ConnectionState } from "./gateway-client";
import { loadSettings, saveSettings, applyTheme, getGatewayUrl, type UiSettings } from "./storage";
import { navigateTo, getCurrentTab, tabFromPath } from "./navigation";
import type {
  Tab,
  EventFrame,
  SessionRegistryEntry,
  ChatEventPayload,
  Message,
  AssistantMessage,
  ToolDefinition,
  ChannelRegistryEntry,
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

  // ---- Lifecycle ----

  connectedCallback() {
    super.connectedCallback();
    applyTheme(this.settings.theme);
    
    // Only auto-connect if we have previously connected successfully
    // (token is set or user explicitly clicked connect)
    if (this.settings.token || localStorage.getItem("gsv-connected-once")) {
      this.showConnectScreen = false;
      this.startConnection();
    }
    
    // Handle browser back/forward
    window.addEventListener("popstate", this.handlePopState);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.client?.stop();
    window.removeEventListener("popstate", this.handlePopState);
  }

  private handlePopState = () => {
    this.tab = getCurrentTab();
  };

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
    }
  }

  private handleChatEvent(payload: ChatEventPayload) {
    if (payload.sessionKey !== this.settings.sessionKey) return;

    if (payload.state === "partial" && payload.message) {
      this.chatStream = payload.message;
    } else if (payload.state === "final") {
      this.chatStream = null;
      this.chatSending = false;
      this.currentRunId = null;
      // Reload to get proper history
      this.loadChatHistory();
    } else if (payload.state === "error") {
      this.chatStream = null;
      this.chatSending = false;
      this.currentRunId = null;
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

  private async loadChannels() {
    if (!this.client) return;
    this.channelsLoading = true;
    try {
      const res = await this.client.channelsList();
      if (res.ok && res.payload) {
        const data = res.payload as { channels: ChannelRegistryEntry[] };
        this.channels = data.channels || [];
      }
    } catch (e) {
      console.error("Failed to load channels:", e);
    } finally {
      this.channelsLoading = false;
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

  async loadWorkspace(path = "/") {
    if (!this.client) return;
    this.workspaceLoading = true;
    this.workspaceCurrentPath = path;
    try {
      const res = await this.client.workspaceList(path);
      if (res.ok && res.payload) {
        this.workspaceFiles = res.payload as { path: string; files: string[]; directories: string[] };
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
      <div class="app-shell">
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
      <nav class="nav-sidebar">
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
        <h1 class="topbar-title">${TAB_LABELS[this.tab]}</h1>
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

declare global {
  interface HTMLElementTagNameMap {
    "gsv-app": GsvApp;
  }
}
