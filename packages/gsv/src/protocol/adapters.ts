import type { BinaryBody } from "./body";

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

export function isAdapterInboundResult(value: unknown): value is AdapterInboundResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AdapterInboundResult>;
  if (typeof result.ok !== "boolean") return false;
  if (
    result.replayed !== undefined
    && result.replayed !== "in_progress"
    && result.replayed !== "completed"
  ) {
    return false;
  }
  if (result.delivered !== undefined && (
    !result.delivered
    || typeof result.delivered !== "object"
    || !Number.isSafeInteger(result.delivered.uid)
    || typeof result.delivered.pid !== "string"
    || typeof result.delivered.runId !== "string"
    || typeof result.delivered.queued !== "boolean"
  )) {
    return false;
  }
  if (result.reply !== undefined && (
    !result.reply
    || typeof result.reply !== "object"
    || typeof result.reply.deliveryId !== "string"
    || !result.reply.deliveryId
    || typeof result.reply.text !== "string"
    || (
      result.reply.replyToId !== undefined
      && typeof result.reply.replyToId !== "string"
    )
  )) {
    return false;
  }
  if (result.challenge !== undefined && (
    !result.challenge
    || typeof result.challenge !== "object"
    || typeof result.challenge.deliveryId !== "string"
    || !result.challenge.deliveryId
    || typeof result.challenge.code !== "string"
    || typeof result.challenge.prompt !== "string"
    || !Number.isFinite(result.challenge.expiresAt)
  )) {
    return false;
  }
  return (result.droppedReason === undefined || typeof result.droppedReason === "string")
    && (result.error === undefined || typeof result.error === "string");
}

export type AdapterConnectChallenge = {
  type: string;
  message?: string;
  data?: string;
  expiresAt?: number;
  extra?: Record<string, unknown>;
};

/** Result returned by an adapter worker's `adapterConnect` RPC method. */
export type AdapterWorkerConnectResult =
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

/** Result returned by an adapter worker's `adapterDisconnect` RPC method. */
export type AdapterWorkerDisconnectResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

/** Result returned by an adapter worker's `adapterSend` RPC method. */
export type AdapterWorkerSendResult =
  | { ok: true; messageId?: string; deduplicated?: boolean }
  | {
      ok: false;
      error: string;
      /** True only when retrying this deliveryId may safely call the provider again. */
      retryable?: boolean;
      /** The provider may have accepted the delivery; retrying could duplicate it. */
      ambiguous?: boolean;
    };

/** Request frame sent from an adapter worker to the Gateway service binding. */
export type AdapterGatewayRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args: unknown;
  body?: BinaryBody;
};

/** Response frame returned by the Gateway service binding to an adapter worker. */
export type AdapterGatewayResponseFrame = {
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

export type AdapterGatewayFrame =
  | AdapterGatewayRequestFrame
  | AdapterGatewayResponseFrame;

/** Gateway RPC surface consumed by adapter workers through a service binding. */
export interface AdapterGatewayInterface<Frame = AdapterGatewayFrame> {
  serviceFrame(frame: Frame): Promise<Frame | null>;
}

/** Canonical service-binding RPC surface implemented by every adapter worker. */
export interface AdapterWorkerInterface {
  readonly adapterId: string;
  /**
   * Kept distinct from `connect`: Cloudflare service bindings reserve that
   * method name for socket connections and would bypass the adapter RPC.
   */
  adapterConnect(
    accountId: string,
    config?: Record<string, unknown>,
  ): Promise<AdapterWorkerConnectResult>;
  adapterDisconnect(accountId: string): Promise<AdapterWorkerDisconnectResult>;
  adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterWorkerSendResult>;
  adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]>;
}
