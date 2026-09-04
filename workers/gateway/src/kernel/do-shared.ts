// Helpers shared by the Kernel Durable Object and its runtime modules.
import {
  z,
} from "zod";
import type {
  FrameBody,
  ResponseFrame,
} from "../protocol/frames";
import type {
  AdapterActivity,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  resourceBlockSchema,
} from "@humansandmachines/gsv/protocol";
import {
  type RouteOrigin,
} from "./routing";
import {
  type AdapterRunRoute,
} from "./run-routes";
import {
  USER_PROCESS_SIGNALS,
} from "./user-signals";

// --- shared declarations ---

export type PendingManagedOnboardingCompletion = {
  claimId: string;
  installationId: string;
};


export const MANAGED_ONBOARDING_COMPLETION_KEY = "managed_onboarding_completion";

export type IpcCallTimeout = {
  callId: string;
  mode?: "supervise";
  intervalMs?: number;
  checkInCount?: number;
  lifecycleRecheckFor?: string;
  /** Legacy payload emitted by older gateways for delegated work. */
  terminateTargetOnTimeout?: boolean;
};


export const ipcCallTimeoutPayloadSchema = z.union([
  z.string().transform((callId): IpcCallTimeout => ({ callId })),
  z.object({
    callId: z.string(),
    mode: z.literal("supervise").optional(),
    intervalMs: z.number().positive().optional(),
    checkInCount: z.number().int().nonnegative().optional(),
    lifecycleRecheckFor: z.string().min(1).optional(),
    terminateTargetOnTimeout: z.boolean().optional(),
  }),
]);

export const procMediaInputSchema = z.object({
  type: z.enum(["image", "audio", "video", "document"]),
  mimeType: z.string(),
  key: z.string().optional(),
  conversationId: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  filename: z.string().optional(),
  size: z.number().optional(),
  duration: z.number().optional(),
  transcription: z.string().optional(),
});

export const userProcessSignalPayloadSchema = z.object({
  pid: z.string().optional(),
  runId: z.string().optional(),
  conversationId: z.string().optional(),
  queuedCount: z.number().finite().optional(),
  timestamp: z.number().finite().optional(),
  changes: z.array(z.string()).optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  text: z.string().nullable().optional(),
  result: z.object({
    text: z.string().nullable(),
    media: z.array(z.union([resourceBlockSchema, procMediaInputSchema])).optional(),
  }).optional(),
  delivery: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("message"),
      conversationId: z.string().optional(),
      messageId: z.string().optional(),
    }),
    z.object({ kind: z.literal("silence"), reason: z.string().optional() }),
  ]).optional(),
  error: z.string().optional(),
  usage: z.json().optional(),
  media: z.array(z.union([resourceBlockSchema, procMediaInputSchema])).optional(),
}).catchall(z.json());

export const userProcessSignalFrameSchema = z.object({
  type: z.literal("sig"),
  signal: z.enum(USER_PROCESS_SIGNALS),
  payload: userProcessSignalPayloadSchema.optional(),
  seq: z.number().optional(),
});

export type UserProcessSignalFrame = z.infer<typeof userProcessSignalFrameSchema>;

export type AdapterDeliveryRoute = Omit<AdapterRunRoute, "createdAt" | "expiresAt">;


export function adapterTypingActivity(route: AdapterDeliveryRoute, active: boolean): AdapterActivity {
  return {
    kind: "typing",
    active,
    ...(route.routeGeneration === undefined
      ? undefined
      : { routeGeneration: route.routeGeneration }),
  };
}

export type AdapterRouteDeliveryRetry = {
  runId: string;
  processId: string;
  /** Owned destination snapshot; absent only on tasks created before this field shipped. */
  route?: AdapterDeliveryRoute;
  event: string;
  payload?: JsonValue;
  attempt: number;
};


export type ProcessDeliveryNoticeRetry = {
  noticeId: string;
  runId: string;
  processId: string;
  /** `final` is accepted only for durable tasks created by older gateways. */
  deliveryKind: "hil" | "message" | "final";
  deliveryId?: string;
  requestId?: string;
  state: "permanent" | "ambiguous" | "exhausted";
  message: string;
  /** Owned destination snapshot; absent only on tasks created before this field shipped. */
  route?: AdapterDeliveryRoute;
  /** Legacy field ignored because terminal run handling owns route cleanup. */
  cleanupRunRoute?: boolean;
};

export function sameRouteOrigin(left: RouteOrigin, right: RouteOrigin): boolean {
  return left.type === right.type && left.id === right.id;
}

export class RequestCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestCancelledError";
  }
}


export type TargetRequestOptions = {
  ttlMs?: number;
  body?: FrameBody;
  id?: string;
  signal?: AbortSignal;
};


export type FrameCancellationReason = string | Error;

export async function cancelUnlockedBody(body: FrameBody | undefined, reason: string): Promise<void> {
  if (body && !body.stream.locked) {
    await body.stream.cancel(reason).catch(() => {});
  }
}


export function errFrame(id: string, code: number, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}


export function requestAbortError(reason: FrameCancellationReason | undefined): Error {
  return reason instanceof Error ? reason : new Error("Device request cancelled");
}

