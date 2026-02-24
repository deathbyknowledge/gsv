/**
 * GSV UI Types
 * Matches the Gateway protocol types from gateway/src/types.ts
 */

// WebSocket Frame types
export type Frame = RequestFrame | ResponseFrame | EventFrame;

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

export type EventFrame = {
  type: "evt";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type ErrorShape = {
  code: number;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

// Tool types
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type SessionSettings = {
  model?: { provider: string; id: string };
  thinkingLevel?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  systemPrompt?: string;
  maxTokens?: number;
};

export type ResetPolicy = {
  mode: "manual" | "daily" | "idle";
  atHour?: number;
  idleMinutes?: number;
};

export type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

export type SessionRegistryEntry = {
  sessionKey: string;
  createdAt: number;
  lastActiveAt: number;
  label?: string;
};

// Channel types
export type ChannelRegistryEntry = {
  channel: string;
  accountId: string;
  connectedAt: number;
  lastMessageAt?: number;
};

export type ChannelAccountStatus = {
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode?: string;
  lastActivity?: number;
  error?: string;
  extra?: Record<string, unknown>;
};

export type ChannelStatusResult = {
  channel: string;
  accounts: ChannelAccountStatus[];
};

export type ChannelLoginResult = {
  ok: true;
  channel: string;
  accountId: string;
  qrDataUrl?: string;
  message: string;
};

// Chat types
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type UserMessage = {
  role: "user";
  content: string | ContentBlock[];
  timestamp?: number;
};

export type AssistantMessage = {
  role: "assistant";
  content: ContentBlock[];
  timestamp?: number;
};

export type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  isError?: boolean;
  timestamp?: number;
};

export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock | ThinkingBlock;

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ImageBlock = {
  type: "image";
  data?: string;
  mimeType?: string;
  r2Key?: string;
  url?: string;
};

export type ThinkingBlock = {
  type: "thinking";
  text: string;
};

// Chat event payload
export type ChatEventPayload = {
  runId: string | null;
  sessionKey: string;
  state: "partial" | "final" | "error" | "paused";
  message?: AssistantMessage;
  error?: string;
  channelContext?: {
    channel: string;
    accountId: string;
    peer: {
      kind: string;
      id: string;
      name?: string;
    };
    inboundMessageId: string;
    agentId?: string;
  };
};

// Config types
export type GsvConfig = {
  model: { provider: string; id: string };
  apiKeys: {
    anthropic?: string;
    openai?: string;
    google?: string;
  };
  systemPrompt?: string;
  timeouts?: {
    llmMs?: number;
    toolMs?: number;
  };
};

// Navigation
export type Tab =
  | "chat"
  | "overview"
  | "sessions"
  | "channels"
  | "nodes"
  | "workspace"
  | "cron"
  | "logs"
  | "pairing"
  | "config"
  | "debug"
  | "settings";

export const TAB_GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: "Chat", tabs: ["chat"] },
  { label: "Control", tabs: ["overview", "sessions", "channels", "nodes"] },
  { label: "Agent", tabs: ["workspace", "cron", "logs"] },
  { label: "Settings", tabs: ["pairing", "config", "debug"] },
];

/** Tabs that appear in the OS dock (settings replaces pairing/config/debug). */
export const OS_DOCK_TABS: Tab[] = [
  "chat", "overview", "sessions", "channels", "nodes",
  "workspace", "cron", "logs", "settings",
];

// SVG icon strings (Feather-style, stroke-based)
export const TAB_ICONS: Record<Tab, string> = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  sessions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  channels: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>',
  nodes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
  workspace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  cron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  pairing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  config: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  debug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

export const TAB_LABELS: Record<Tab, string> = {
  chat: "Chat",
  overview: "Overview",
  sessions: "Sessions",
  channels: "Channels",
  nodes: "Nodes",
  workspace: "Workspace",
  cron: "Cron Jobs",
  logs: "Logs",
  pairing: "Pairing",
  config: "Config",
  debug: "Debug",
  settings: "Settings",
};

// Window defaults
export const WINDOW_DEFAULTS: Record<Tab, { width: number; height: number; pinned: boolean }> = {
  chat: { width: 700, height: 550, pinned: true },
  overview: { width: 820, height: 520, pinned: true },
  sessions: { width: 700, height: 480, pinned: true },
  channels: { width: 740, height: 520, pinned: true },
  nodes: { width: 680, height: 460, pinned: false },
  workspace: { width: 920, height: 600, pinned: true },
  cron: { width: 780, height: 520, pinned: false },
  logs: { width: 720, height: 480, pinned: false },
  pairing: { width: 620, height: 420, pinned: false },
  config: { width: 780, height: 560, pinned: false },
  debug: { width: 680, height: 440, pinned: false },
  settings: { width: 800, height: 560, pinned: false },
};

export type WindowState = {
  tab: Tab;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  zIndex: number;
};
