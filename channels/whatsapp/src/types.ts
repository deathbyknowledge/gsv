// Types shared between WhatsApp channel and GSV gateway
// These should match gateway/src/types.ts channel types

export type ChannelId = "whatsapp";

export type ChatType = "dm" | "group";

export type PeerInfo = {
  kind: ChatType;
  id: string;
  name?: string;
  handle?: string;
};

export type SenderInfo = {
  id: string;
  name?: string;
  handle?: string;
};

export type ChannelInboundParams = {
  channel: ChannelId;
  accountId: string;
  peer: PeerInfo;
  sender?: SenderInfo;
  message: {
    id: string;
    text: string;
    timestamp?: number;
    replyToId?: string;
    replyToText?: string;
    mediaUrl?: string;
    mediaType?: string;
    location?: { lat: number; lon: number; name?: string };
  };
  wasMentioned?: boolean;
  mentionedIds?: string[];
};

export type ChannelOutboundPayload = {
  channel: ChannelId;
  accountId: string;
  peer: PeerInfo;
  sessionKey: string;
  message: {
    text: string;
    replyToId?: string;
    mediaUrl?: string;
  };
};

// Protocol frame types (matching gateway)
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
  error?: { code: number; message: string };
};

export type EventFrame = {
  type: "evt";
  event: string;
  payload?: unknown;
};

export type Frame = RequestFrame | ResponseFrame | EventFrame;

// WhatsApp account state
export type WhatsAppAccountState = {
  accountId: string;
  selfJid?: string;
  selfE164?: string;
  connected: boolean;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastMessageAt?: number;
};

// Media attachment for inbound messages
export type MediaAttachment = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  data?: string; // base64 encoded
  url?: string;
  filename?: string;
  size?: number;
  duration?: number;
};
