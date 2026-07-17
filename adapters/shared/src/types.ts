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

export type BinaryBody = {
  stream: ReadableStream<Uint8Array>;
  length?: number;
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

export type AdapterConnectResult =
  | {
      ok: true;
      message?: string;
      connected?: boolean;
      authenticated?: boolean;
      challenge?: AdapterConnectChallenge;
    }
  | {
      ok: false;
      error: string;
      challenge?: AdapterConnectChallenge;
    };

export type AdapterDisconnectResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

export type AdapterSendResult =
  | { ok: true; messageId?: string; deduplicated?: boolean }
  | {
      ok: false;
      error: string;
      /** True only when retrying this deliveryId may safely call the provider again. */
      retryable?: boolean;
      /** The provider may have accepted the delivery; retrying could duplicate it. */
      ambiguous?: boolean;
    };

export type AdapterCapabilities = {
  chatTypes: AdapterSurfaceKind[];
  media: boolean;
  reactions: boolean;
  threads: boolean;
  typing: boolean;
  editing: boolean;
  deletion: boolean;
  qrLogin?: boolean;
};

export type GatewayRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args: unknown;
  body?: BinaryBody;
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  data?: unknown;
  body?: BinaryBody;
  error?: {
    code?: number | string;
    message: string;
    details?: unknown;
  };
};

export type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame;

export interface AdapterWorkerInterface {
  readonly adapterId: string;
  adapterConnect(
    accountId: string,
    config?: Record<string, unknown>,
  ): Promise<AdapterConnectResult>;
  adapterDisconnect(accountId: string): Promise<AdapterDisconnectResult>;
  adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
  adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]>;
}

export type ChannelPeer = AdapterSurface;
export type ChannelMedia = AdapterMedia;
export type ChannelOutboundMessage = Omit<AdapterOutboundMessage, "surface"> & {
  peer: ChannelPeer;
};
export type ChannelAccountStatus = AdapterAccountStatus;
