import { binaryBodySchema, type BinaryBody } from "./body";
import type { JsonPrimitive, JsonValue } from "./json";
import { jsonPrimitiveSchema, jsonValueSchema } from "./json";
import * as z from "zod/mini";

const ADAPTER_INSTALLATION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const nonEmptyStringSchema = z.string().check(z.minLength(1));
const trimmedNonEmptyStringSchema = nonEmptyStringSchema.check(
  z.refine((value) => value === value.trim()),
);
export const adapterMetadataSchema = z.record(
  z.string(),
  jsonPrimitiveSchema,
);
export const adapterConnectConfigSchema = adapterMetadataSchema;
export const adapterInstallationContextSchema = z.strictObject({
  installationId: z.string().check(z.regex(ADAPTER_INSTALLATION_ID_PATTERN)),
});

export type AdapterInstallationContext = z.infer<typeof adapterInstallationContextSchema>;
export type AdapterMetadata = Record<string, JsonPrimitive>;
export type AdapterConnectConfig = Record<string, JsonPrimitive>;

export function isAdapterInstallationContext(
  value: JsonValue,
): value is AdapterInstallationContext {
  return adapterInstallationContextSchema.safeParse(value).success;
}

export type AdapterSurfaceKind = "dm" | "group" | "channel" | "thread";

export const adapterSurfaceKindSchema = z.enum(["dm", "group", "channel", "thread"]);
export const adapterSurfaceSchema = z.strictObject({
  kind: adapterSurfaceKindSchema,
  id: z.string(),
  name: z.optional(z.string()),
  handle: z.optional(z.string()),
  threadId: z.optional(z.string()),
});

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

export const adapterActorSchema = z.strictObject({
  id: z.string(),
  name: z.optional(z.string()),
  handle: z.optional(z.string()),
});

export type AdapterMediaBody = {
  /** Byte offset in the request's single top-level binary body. */
  offset: number;
  /** Exact byte length of this media item in the top-level body. */
  length: number;
};

export const adapterMediaBodySchema = z.strictObject({
  offset: z.number(),
  length: z.number(),
});

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

export const adapterMediaSchema = z.strictObject({
  type: z.enum(["image", "audio", "video", "document"]),
  mimeType: z.string(),
  body: z.optional(adapterMediaBodySchema),
  url: z.optional(z.string()),
  filename: z.optional(z.string()),
  size: z.optional(z.number()),
  duration: z.optional(z.number()),
  transcription: z.optional(z.string()),
});

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

export const adapterInboundMessageSchema = z.strictObject({
  messageId: z.string(),
  surface: adapterSurfaceSchema,
  actor: z.optional(adapterActorSchema),
  text: z.string(),
  media: z.optional(z.array(adapterMediaSchema)),
  replyToId: z.optional(z.string()),
  replyToText: z.optional(z.string()),
  timestamp: z.optional(z.number()),
  wasMentioned: z.optional(z.boolean()),
});

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

export const adapterOutboundMessageSchema = z.strictObject({
  deliveryId: z.string(),
  surface: adapterSurfaceSchema,
  actorId: z.optional(z.string()),
  text: z.string(),
  media: z.optional(z.array(adapterMediaSchema)),
  replyToId: z.optional(z.string()),
});

export type AdapterActivity =
  | { kind: "typing"; active: boolean }
  | { kind: "recording"; active: boolean }
  | { kind: "uploading"; active: boolean };

export const adapterActivitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("typing"), active: z.boolean() }),
  z.strictObject({ kind: z.literal("recording"), active: z.boolean() }),
  z.strictObject({ kind: z.literal("uploading"), active: z.boolean() }),
]);

export const adapterAccountStatusSchema = z.strictObject({
  accountId: trimmedNonEmptyStringSchema,
  connected: z.boolean(),
  authenticated: z.boolean(),
  mode: z.optional(z.string()),
  lastActivity: z.optional(z.number()),
  error: z.optional(z.string()),
  extra: z.optional(adapterMetadataSchema),
});

export type AdapterAccountStatus = {
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode?: string;
  lastActivity?: number;
  error?: string;
  extra?: AdapterMetadata;
};

export const adapterInboundResultSchema = z.strictObject({
  ok: z.boolean(),
  delivered: z.optional(z.strictObject({
    uid: z.int(),
    pid: z.string(),
    runId: z.string(),
    queued: z.boolean(),
  })),
  reply: z.optional(z.strictObject({
    deliveryId: nonEmptyStringSchema,
    text: z.string(),
    replyToId: z.optional(z.string()),
  })),
  challenge: z.optional(z.strictObject({
    deliveryId: nonEmptyStringSchema,
    code: z.string(),
    prompt: z.string(),
    expiresAt: z.number(),
  })),
  replayed: z.optional(z.enum(["in_progress", "completed"])),
  droppedReason: z.optional(z.string()),
  error: z.optional(z.string()),
});

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

export function isAdapterInboundResult(value: JsonValue): value is AdapterInboundResult {
  return adapterInboundResultSchema.safeParse(value).success;
}

export type AdapterConnectChallengeFormat = "raw" | "data-url";

export const adapterConnectChallengeSchema = z.strictObject({
  type: nonEmptyStringSchema,
  message: z.optional(z.string()),
  data: z.optional(z.string()),
  format: z.optional(z.enum(["raw", "data-url"])),
  expiresAt: z.optional(z.number()),
  extra: z.optional(adapterMetadataSchema),
}).check(z.refine((challenge) => challenge.type !== "qr" || Boolean(challenge.data)));

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
  extra?: AdapterMetadata;
};

/** Validate an adapter authentication challenge at an RPC boundary. */
export function isAdapterConnectChallenge(value: JsonValue): value is AdapterConnectChallenge {
  return adapterConnectChallengeSchema.safeParse(value).success;
}

/** Result returned by an adapter worker's `adapterConnect` RPC method. */
export const adapterWorkerConnectResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    message: z.optional(z.string()),
    connected: z.boolean(),
    authenticated: z.boolean(),
    challenge: z.optional(adapterConnectChallengeSchema),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: nonEmptyStringSchema,
    challenge: z.optional(adapterConnectChallengeSchema),
  }),
]);

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
  value: JsonValue,
): value is AdapterWorkerConnectResult {
  return adapterWorkerConnectResultSchema.safeParse(value).success;
}

/** Result returned by an adapter worker's `adapterDisconnect` RPC method. */
export const adapterWorkerDisconnectResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    message: z.optional(z.string()),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: nonEmptyStringSchema,
  }),
]);

export type AdapterWorkerDisconnectResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

/** Validate an adapter Worker's private disconnect RPC result. */
export function isAdapterWorkerDisconnectResult(
  value: JsonValue,
): value is AdapterWorkerDisconnectResult {
  return adapterWorkerDisconnectResultSchema.safeParse(value).success;
}

/** Result returned by an adapter worker's `adapterSend` RPC method. */
export const adapterWorkerSendResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    messageId: z.optional(z.string()),
    deduplicated: z.optional(z.boolean()),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: nonEmptyStringSchema,
    retryable: z.optional(z.boolean()),
    ambiguous: z.optional(z.boolean()),
  }).check(z.refine((result) => !(result.retryable === true && result.ambiguous === true))),
]);

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
export function isAdapterWorkerSendResult(value: JsonValue): value is AdapterWorkerSendResult {
  return adapterWorkerSendResultSchema.safeParse(value).success;
}

export const adapterWorkerActivityResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: nonEmptyStringSchema }),
]);

export type AdapterWorkerActivityResult =
  | { ok: true }
  | { ok: false; error: string };

/** Validate an adapter Worker's private activity RPC result. */
export function isAdapterWorkerActivityResult(
  value: JsonValue,
): value is AdapterWorkerActivityResult {
  return adapterWorkerActivityResultSchema.safeParse(value).success;
}

export const MANAGED_TELEGRAM_ACCOUNT_ID = "managed";

export type AdapterPairingInfo = {
  accountId: string;
  configured: boolean;
  botUsername?: string;
};

export type AdapterPairingCandidate = {
  accountId: string;
  actorId: string;
  surfaceId: string;
  actorName?: string;
  actorHandle?: string;
  expiresAt: number;
  linked: boolean;
};

export type AdapterPairingRoute = {
  installationId: string;
  localUid: number;
  generation: string;
};

export type AdapterPairingPrepareInput = {
  code: string;
  installationId: string;
  localUid: number;
  operationId: string;
  canonicalOrigin: string;
};

export type AdapterPairingPreparation = {
  candidate: AdapterPairingCandidate;
  route: AdapterPairingRoute;
  previousRoute?: AdapterPairingRoute;
};

export type AdapterPairingActivateInput = {
  code: string;
  operationId: string;
  route: AdapterPairingRoute;
  canonicalOrigin: string;
};

export type AdapterPairingFinalizeInput = AdapterPairingActivateInput;

export type AdapterPairingDisconnectInput = {
  operationId: string;
  installationId: string;
  actorId: string;
  surfaceId: string;
  localUid: number;
  generation: string;
};

export type AdapterPairingDisconnectResult = {
  disconnected: boolean;
};

/** Optional private RPC surface for platform-owned shared adapter accounts. */
export interface AdapterPairingWorkerInterface {
  adapterPairingInfo(
    installation: AdapterInstallationContext,
  ): Promise<AdapterPairingInfo>;
  adapterPairingInspect(
    installation: AdapterInstallationContext,
    code: string,
  ): Promise<AdapterPairingCandidate>;
  adapterPairingPrepare(
    installation: AdapterInstallationContext,
    input: AdapterPairingPrepareInput,
  ): Promise<AdapterPairingPreparation>;
  adapterPairingActivate(
    installation: AdapterInstallationContext,
    input: AdapterPairingActivateInput,
  ): Promise<AdapterPairingPreparation>;
  adapterPairingFinalize(
    installation: AdapterInstallationContext,
    input: AdapterPairingFinalizeInput,
  ): Promise<AdapterPairingPreparation>;
  adapterPairingDisconnect(
    installation: AdapterInstallationContext,
    input: AdapterPairingDisconnectInput,
  ): Promise<AdapterPairingDisconnectResult>;
}

/** Validate one live account status returned by an adapter worker. */
export function isAdapterAccountStatus(value: JsonValue): value is AdapterAccountStatus {
  return adapterAccountStatusSchema.safeParse(value).success;
}

/** Validate the complete private status RPC result before persisting it. */
export function isAdapterWorkerStatusResult(
  value: JsonValue,
): value is AdapterAccountStatus[] {
  return z.array(adapterAccountStatusSchema).safeParse(value).success;
}

/** Request frame sent from an adapter worker to the Gateway service binding. */
export const adapterGatewayRequestFrameSchema = z.strictObject({
  type: z.literal("req"),
  id: z.string(),
  call: z.string(),
  args: jsonValueSchema,
  body: z.optional(binaryBodySchema),
});

export type AdapterGatewayRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args: JsonValue;
  body?: BinaryBody;
};

/** Response frame returned by the Gateway service binding to an adapter worker. */
export const adapterGatewayResponseFrameSchema = z.strictObject({
  type: z.literal("res"),
  id: z.string(),
  ok: z.boolean(),
  data: z.optional(jsonValueSchema),
  body: z.optional(binaryBodySchema),
  error: z.optional(z.strictObject({
    code: z.optional(z.union([z.number(), z.string()])),
    message: z.string(),
    details: z.optional(jsonValueSchema),
  })),
});

export type AdapterGatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  data?: JsonValue;
  body?: BinaryBody;
  error?: {
    code?: number | string;
    message: string;
    details?: JsonValue;
  };
};

export type AdapterGatewayFrame =
  | AdapterGatewayRequestFrame
  | AdapterGatewayResponseFrame;

export const adapterGatewayFrameSchema = z.union([
  adapterGatewayRequestFrameSchema,
  adapterGatewayResponseFrameSchema,
]);

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
    config?: AdapterConnectConfig,
  ): Promise<AdapterWorkerConnectResult>;
  adapterConnect(
    installation: AdapterInstallationContext,
    accountId: string,
    config?: AdapterConnectConfig,
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
