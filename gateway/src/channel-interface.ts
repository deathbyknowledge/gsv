/**
 * GSV Channel Interface
 * 
 * Channels are separate Cloudflare Workers that connect to the Gateway via Service Bindings.
 * Each channel implements this interface as a WorkerEntrypoint.
 * 
 * Communication:
 * - Gateway → Channel: Direct RPC calls (send, setTyping, etc.)
 * - Channel → Gateway: Channel calls Gateway's `channelInbound()` method via its Service Binding
 */

import { WorkerEntrypoint } from "cloudflare:workers";

// ============================================================================
// Core Types
// ============================================================================

/**
 * Conversation target (DM, group, channel, thread, etc.)
 */
export type ChannelPeer = {
  /** Type of conversation */
  kind: "dm" | "group" | "channel" | "thread";
  /** Platform-specific ID (chat ID, channel ID, email address, etc.) */
  id: string;
  /** Display name */
  name?: string;
  /** Handle/username */
  handle?: string;
  /** Thread/topic ID for threaded conversations */
  threadId?: string;
};

/**
 * Sender within a group/channel (distinct from peer)
 */
export type ChannelSender = {
  id: string;
  name?: string;
  handle?: string;
};

/**
 * Media attachment
 */
export type ChannelMedia = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  /** Base64-encoded data */
  data?: string;
  /** URL (alternative to data) */
  url?: string;
  filename?: string;
  size?: number;
  /** Duration in seconds (audio/video) */
  duration?: number;
  /** Transcription (audio) */
  transcription?: string;
};

/**
 * Inbound message (Channel → Gateway)
 */
export type ChannelInboundMessage = {
  /** Platform-specific message ID */
  messageId: string;
  /** Conversation target */
  peer: ChannelPeer;
  /** Sender (for groups) */
  sender?: ChannelSender;
  /** Message text */
  text: string;
  /** Media attachments */
  media?: ChannelMedia[];
  /** Reply context */
  replyToId?: string;
  replyToText?: string;
  /** Timestamp */
  timestamp?: number;
  /** Was the bot explicitly mentioned? */
  wasMentioned?: boolean;
};

/**
 * Outbound message (Gateway → Channel)
 */
export type ChannelOutboundMessage = {
  /** Target conversation */
  peer: ChannelPeer;
  /** Message text */
  text: string;
  /** Media to send */
  media?: ChannelMedia[];
  /** Reply to a specific message */
  replyToId?: string;
};

/**
 * Channel account status
 */
export type ChannelAccountStatus = {
  accountId: string;
  /** Is the account connected/running? */
  connected: boolean;
  /** Is authentication valid? */
  authenticated: boolean;
  /** Connection mode (polling, webhook, websocket) */
  mode?: string;
  /** Last activity timestamp */
  lastActivity?: number;
  /** Error message if something's wrong */
  error?: string;
  /** Channel-specific extra info */
  extra?: Record<string, unknown>;
};

/**
 * Channel capabilities
 */
export type ChannelCapabilities = {
  /** Supported conversation types */
  chatTypes: Array<"dm" | "group" | "channel" | "thread">;
  /** Can send/receive media */
  media: boolean;
  /** Supports reactions */
  reactions: boolean;
  /** Supports threads */
  threads: boolean;
  /** Supports typing indicators */
  typing: boolean;
  /** Can edit sent messages */
  editing: boolean;
  /** Can delete messages */
  deletion: boolean;
  /** Requires QR code login */
  qrLogin?: boolean;
};

// ============================================================================
// Channel Worker Interface
// ============================================================================

/**
 * Result types for RPC methods
 */
export type StartResult = { ok: true } | { ok: false; error: string };
export type StopResult = { ok: true } | { ok: false; error: string };
export type SendResult = { ok: true; messageId?: string } | { ok: false; error: string };
export type LoginResult = { ok: true; qrDataUrl?: string; message: string } | { ok: false; error: string };
export type LogoutResult = { ok: true } | { ok: false; error: string };

/**
 * Channel Worker Entrypoint Interface
 * 
 * Channel workers extend WorkerEntrypoint and implement these methods.
 * The Gateway calls these via Service Bindings (RPC).
 * 
 * Example implementation:
 * ```typescript
 * export default class DiscordChannel extends WorkerEntrypoint implements ChannelWorkerInterface {
 *   readonly channelId = "discord";
 *   readonly capabilities = { ... };
 *   
 *   async start(accountId: string, config: Record<string, unknown>) {
 *     // Start Discord gateway connection via Durable Object
 *   }
 * }
 * ```
 */
export interface ChannelWorkerInterface {
  // ─────────────────────────────────────────────────────────
  // Identity
  // ─────────────────────────────────────────────────────────
  
  /** Channel identifier (e.g., "discord", "whatsapp", "email") */
  readonly channelId: string;
  
  /** Channel capabilities */
  readonly capabilities: ChannelCapabilities;

  // ─────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────
  
  /**
   * Start the channel for an account.
   * This should establish the connection (WebSocket, polling, etc.)
   * 
   * @param accountId - Unique account identifier
   * @param config - Channel-specific configuration (token, credentials, etc.)
   */
  start(accountId: string, config: Record<string, unknown>): Promise<StartResult>;
  
  /**
   * Stop the channel for an account.
   * Disconnect and clean up resources.
   */
  stop(accountId: string): Promise<StopResult>;
  
  /**
   * Get status for one or all accounts.
   */
  status(accountId?: string): Promise<ChannelAccountStatus[]>;

  // ─────────────────────────────────────────────────────────
  // Messaging (Gateway → Channel)
  // ─────────────────────────────────────────────────────────
  
  /**
   * Send a message to a peer.
   */
  send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult>;
  
  /**
   * Send typing indicator.
   */
  setTyping?(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void>;

  // ─────────────────────────────────────────────────────────
  // Authentication (optional, for QR-based channels)
  // ─────────────────────────────────────────────────────────
  
  /**
   * Start login flow (returns QR code if needed).
   */
  login?(accountId: string, options?: { force?: boolean }): Promise<LoginResult>;
  
  /**
   * Logout and clear credentials.
   */
  logout?(accountId: string): Promise<LogoutResult>;
}

// ============================================================================
// Gateway Entrypoint (for Channel → Gateway communication)
// ============================================================================

/**
 * Gateway methods that channels can call via Service Binding.
 * 
 * Channels use this to deliver inbound messages to the Gateway.
 */
export interface GatewayChannelInterface {
  /**
   * Deliver an inbound message from a channel to the Gateway.
   * The Gateway will route this to the appropriate Session.
   */
  channelInbound(
    channelId: string,
    accountId: string,
    message: ChannelInboundMessage,
  ): Promise<{ ok: boolean; sessionKey?: string; error?: string }>;
  
  /**
   * Notify Gateway that channel status changed.
   */
  channelStatusChanged?(
    channelId: string,
    accountId: string,
    status: ChannelAccountStatus,
  ): Promise<void>;
}

// ============================================================================
// Queue Message Types (for Channel → Gateway inbound messages)
// ============================================================================

/**
 * Messages sent from channels to Gateway's inbound queue.
 * 
 * Channels send to a queue instead of calling Gateway RPC directly.
 * This decouples the channel DO from the RPC call context, which avoids
 * issues with certain channel platforms (e.g., WhatsApp/Baileys).
 */
export type ChannelQueueMessage = 
  | { type: "inbound"; channelId: string; accountId: string; message: ChannelInboundMessage }
  | { type: "status"; channelId: string; accountId: string; status: ChannelAccountStatus };

// ============================================================================
// Type Helpers
// ============================================================================

/**
 * Service binding type for a channel worker.
 * Use this in Gateway's Env type.
 * 
 * Example:
 * ```typescript
 * interface Env {
 *   DISCORD: Service<ChannelWorkerInterface>;
 *   WHATSAPP: Service<ChannelWorkerInterface>;
 * }
 * ```
 */
export type ChannelService = ChannelWorkerInterface;
