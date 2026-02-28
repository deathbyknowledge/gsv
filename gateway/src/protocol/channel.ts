export type ChannelId =
  | "whatsapp"
  | "discord"
  | (string & {});

export type ChatType = "dm" | "group" | "channel" | "thread";

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

export type MediaAttachment = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  data?: string; // base64
  r2Key?: string;
  url?: string;
  filename?: string;
  size?: number;
  duration?: number;
  transcription?: string;
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
    media?: MediaAttachment[];
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

export type ChannelTypingPayload = {
  channel: ChannelId;
  accountId: string;
  peer: PeerInfo;
  sessionKey: string;
  typing: boolean;
};

export type ChannelRegistryEntry = {
  channel: ChannelId;
  accountId: string;
  connectedAt: number;
  lastMessageAt?: number;
};

export type SessionChannelContext = {
  channel: ChannelId;
  accountId: string;
  peer: {
    kind: ChatType;
    id: string;
    name?: string;
  };
};

export type SessionOutputContext = SessionChannelContext & {
  inboundMessageId: string;
  agentId?: string;
};
