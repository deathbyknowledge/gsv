import type { BinaryBody } from "./body";

export type AdapterInstallationContext = {
  installationId: string;
};

const ADAPTER_INSTALLATION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;

export function isAdapterInstallationContext(
  value: unknown,
): value is AdapterInstallationContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const installationId = (value as { installationId?: unknown }).installationId;
  return typeof installationId === "string"
    && ADAPTER_INSTALLATION_ID_PATTERN.test(installationId);
}

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

export type AdapterConnectChallengeFormat = "raw" | "data-url";

export type AdapterConnectChallenge = {
  type: string;
  message?: string;
  /**
   * Authentication payload interpreted according to `type` and `format`.
   * QR challenges use `raw` for provider QR text or `data-url` for an already
   * rendered image. Callers must not print or log this value.
   */
  data?: string;
  format?: AdapterConnectChallengeFormat;
  /** Absolute Unix time in milliseconds after which this challenge is stale. */
  expiresAt?: number;
  extra?: Record<string, unknown>;
};

/** Validate an adapter authentication challenge at an RPC boundary. */
export function isAdapterConnectChallenge(value: unknown): value is AdapterConnectChallenge {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const challenge = value as Partial<AdapterConnectChallenge>;
  if (typeof challenge.type !== "string" || !challenge.type.trim()) {
    return false;
  }
  if (challenge.message !== undefined && typeof challenge.message !== "string") {
    return false;
  }
  if (challenge.data !== undefined && typeof challenge.data !== "string") {
    return false;
  }
  if (
    challenge.format !== undefined
    && challenge.format !== "raw"
    && challenge.format !== "data-url"
  ) {
    return false;
  }
  if (challenge.expiresAt !== undefined && !Number.isFinite(challenge.expiresAt)) {
    return false;
  }
  if (
    challenge.extra !== undefined
    && (!challenge.extra || typeof challenge.extra !== "object" || Array.isArray(challenge.extra))
  ) {
    return false;
  }
  if (challenge.type === "qr" && (typeof challenge.data !== "string" || !challenge.data)) {
    return false;
  }
  return true;
}

/** Result returned by an adapter worker's `adapterConnect` RPC method. */
export type AdapterWorkerConnectResult =
  | {
      ok: true;
      message?: string;
      connected: boolean;
      authenticated: boolean;
      challenge?: AdapterConnectChallenge;
    }
  | {
      ok: false;
      error: string;
      challenge?: AdapterConnectChallenge;
    };

/** Validate an adapter Worker's private connect RPC result before the gateway
 * turns it into the stricter public `adapter.connect` result. */
export function isAdapterWorkerConnectResult(
  value: unknown,
): value is AdapterWorkerConnectResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean") {
    return false;
  }
  if (
    result.challenge !== undefined
    && !isAdapterConnectChallenge(result.challenge)
  ) {
    return false;
  }
  if (!result.ok) {
    return typeof result.error === "string" && result.error.trim().length > 0;
  }
  return (result.message === undefined || typeof result.message === "string")
    && typeof result.connected === "boolean"
    && typeof result.authenticated === "boolean";
}

/** Result returned by an adapter worker's `adapterDisconnect` RPC method. */
export type AdapterWorkerDisconnectResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

/** Validate an adapter Worker's private disconnect RPC result. */
export function isAdapterWorkerDisconnectResult(
  value: unknown,
): value is AdapterWorkerDisconnectResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean") return false;
  if (!result.ok) {
    return typeof result.error === "string" && result.error.trim().length > 0;
  }
  return result.message === undefined || typeof result.message === "string";
}

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

/** Validate an adapter Worker's private send RPC result. */
export function isAdapterWorkerSendResult(value: unknown): value is AdapterWorkerSendResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean") return false;
  if (result.ok) {
    return (result.messageId === undefined || typeof result.messageId === "string")
      && (result.deduplicated === undefined || typeof result.deduplicated === "boolean");
  }
  return typeof result.error === "string"
    && result.error.trim().length > 0
    && (result.retryable === undefined || typeof result.retryable === "boolean")
    && (result.ambiguous === undefined || typeof result.ambiguous === "boolean")
    && !(result.retryable === true && result.ambiguous === true);
}

export type AdapterWorkerActivityResult =
  | { ok: true }
  | { ok: false; error: string };

/** Validate an adapter Worker's private activity RPC result. */
export function isAdapterWorkerActivityResult(
  value: unknown,
): value is AdapterWorkerActivityResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean") return false;
  return result.ok
    || (typeof result.error === "string" && result.error.trim().length > 0);
}

/** Validate one live account status returned by an adapter worker. */
export function isAdapterAccountStatus(value: unknown): value is AdapterAccountStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const status = value as Record<string, unknown>;
  return typeof status.accountId === "string"
    && status.accountId.trim().length > 0
    && status.accountId === status.accountId.trim()
    && typeof status.connected === "boolean"
    && typeof status.authenticated === "boolean"
    && (status.mode === undefined || typeof status.mode === "string")
    && (
      status.lastActivity === undefined
      || (typeof status.lastActivity === "number" && Number.isFinite(status.lastActivity))
    )
    && (status.error === undefined || typeof status.error === "string")
    && (
      status.extra === undefined
      || (Boolean(status.extra) && typeof status.extra === "object" && !Array.isArray(status.extra))
    );
}

/** Validate the complete private status RPC result before persisting it. */
export function isAdapterWorkerStatusResult(
  value: unknown,
): value is AdapterAccountStatus[] {
  return Array.isArray(value) && value.every(isAdapterAccountStatus);
}

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
  serviceFrame(
    installation: AdapterInstallationContext,
    frame: Frame,
  ): Promise<Frame | null>;
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
  adapterConnect(
    installation: AdapterInstallationContext,
    accountId: string,
    config?: Record<string, unknown>,
  ): Promise<AdapterWorkerConnectResult>;
  adapterDisconnect(
    accountId: string,
  ): Promise<AdapterWorkerDisconnectResult>;
  adapterDisconnect(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<AdapterWorkerDisconnectResult>;
  adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterWorkerSendResult>;
  adapterSend(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterWorkerSendResult>;
  adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<AdapterWorkerActivityResult>;
  adapterSetActivity(
    installation: AdapterInstallationContext,
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<AdapterWorkerActivityResult>;
  adapterStatus(
    accountId?: string,
  ): Promise<AdapterAccountStatus[]>;
  adapterStatus(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]>;
}
