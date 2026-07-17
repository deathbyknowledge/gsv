export type AdapterSurfaceKind = "dm" | "group" | "channel" | "thread";

export type AdapterSurface = {
  kind: AdapterSurfaceKind;
  id: string;
  name?: string;
  handle?: string;
  threadId?: string;
};

export type AdapterActor = {
  id: string;
  name?: string;
  handle?: string;
};

export type AdapterMediaBody = {
  /** Byte offset in the request's single top-level binary body. */
  offset: number;
  /** Exact byte length of this media item in the top-level body. */
  length: number;
};

export type AdapterMedia = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  body?: AdapterMediaBody;
  url?: string;
  filename?: string;
  size?: number;
  duration?: number;
  transcription?: string;
};

export type AdapterInboundMessage = {
  messageId: string;
  surface: AdapterSurface;
  actor?: AdapterActor;
  text: string;
  media?: AdapterMedia[];
  replyToId?: string;
  replyToText?: string;
  timestamp?: number;
  wasMentioned?: boolean;
};

export type AdapterOutboundMessage = {
  /** Stable idempotency key for one logical provider delivery. */
  deliveryId: string;
  surface: AdapterSurface;
  /** Stable adapter actor identity for provider-specific reply addressing. */
  actorId?: string;
  text: string;
  media?: AdapterMedia[];
  replyToId?: string;
};

export type AdapterActivity =
  | { kind: "typing"; active: boolean }
  | { kind: "recording"; active: boolean }
  | { kind: "uploading"; active: boolean };

export type AdapterAccountStatus = {
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode?: string;
  lastActivity?: number;
  error?: string;
  extra?: Record<string, unknown>;
};

export type AdapterInboundResult = {
  ok: boolean;
  delivered?: {
    uid: number;
    pid: string;
    runId: string;
    queued: boolean;
  };
  reply?: {
    /** Stable idempotency key for delivering this immediate reply. */
    deliveryId: string;
    text: string;
    replyToId?: string;
  };
  challenge?: {
    /** Stable idempotency key for delivering this link challenge. */
    deliveryId: string;
    code: string;
    prompt: string;
    expiresAt: number;
  };
  /** Set only when this provider ingress key was already claimed. */
  replayed?: "in_progress" | "completed";
  droppedReason?: string;
  error?: string;
};

export type AdapterConnectChallenge = {
  type: string;
  message?: string;
  data?: string;
  expiresAt?: number;
  extra?: Record<string, unknown>;
};
