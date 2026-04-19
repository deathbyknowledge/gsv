/**
 * Re-export types from the shared channel interface.
 * 
 * This file exists so Discord channel can import types without
 * reaching into the gateway package directly.
 * 
 * TODO: Move these to a shared @gsv/channel-interface package.
 */

// ============================================================================
// Core Types (copied from gateway/src/channel-interface.ts)
// ============================================================================

export type ChannelPeer = {
  kind: "dm" | "group" | "channel" | "thread";
  id: string;
  name?: string;
  handle?: string;
  threadId?: string;
};

export type ChannelSender = {
  id: string;
  name?: string;
  handle?: string;
};

export type ChannelMedia = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  data?: string;
  url?: string;
  filename?: string;
  size?: number;
  duration?: number;
  transcription?: string;
};

export type ChannelInboundMessage = {
  messageId: string;
  peer: ChannelPeer;
  sender?: ChannelSender;
  text: string;
  media?: ChannelMedia[];
  replyToId?: string;
  replyToText?: string;
  timestamp?: number;
  wasMentioned?: boolean;
};

export type ChannelOutboundMessage = {
  peer: ChannelPeer;
  text: string;
  media?: ChannelMedia[];
  replyToId?: string;
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

export type ChannelCapabilities = {
  chatTypes: Array<"dm" | "group" | "channel" | "thread">;
  media: boolean;
  reactions: boolean;
  threads: boolean;
  typing: boolean;
  editing: boolean;
  deletion: boolean;
  qrLogin?: boolean;
};

// ============================================================================
// Result Types
// ============================================================================

export type StartResult = { ok: true } | { ok: false; error: string };
export type StopResult = { ok: true } | { ok: false; error: string };
export type SendResult = { ok: true; messageId?: string } | { ok: false; error: string };
export type LoginResult = { ok: true; qrDataUrl?: string; message: string } | { ok: false; error: string };
export type LogoutResult = { ok: true } | { ok: false; error: string };

// ============================================================================
// Interface
// ============================================================================

export interface ChannelWorkerInterface {
  readonly channelId: string;
  readonly capabilities: ChannelCapabilities;
  
  start(accountId: string, config: Record<string, unknown>): Promise<StartResult>;
  stop(accountId: string): Promise<StopResult>;
  status(accountId?: string): Promise<ChannelAccountStatus[]>;
  
  send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult>;
  setTyping?(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void>;
  
  login?(accountId: string, options?: { force?: boolean }): Promise<LoginResult>;
  logout?(accountId: string): Promise<LogoutResult>;
}
