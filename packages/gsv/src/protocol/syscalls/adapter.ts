import type {
  AdapterAccountStatus,
  AdapterConnectConfig,
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterMedia,
  AdapterSurface,
} from "../adapters";
import {
  adapterConnectChallengeSchema,
  type AdapterConnectChallenge,
} from "../adapters";
import type { JsonValue } from "../json";
import * as z from "zod/mini";

const nonEmptyStringSchema = z.string().check(z.minLength(1));

export type AdapterConnectArgs = {
  adapter: string;
  accountId: string;
  config?: AdapterConnectConfig;
};

export const adapterConnectResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    adapter: nonEmptyStringSchema,
    accountId: nonEmptyStringSchema,
    connected: z.boolean(),
    authenticated: z.boolean(),
    message: z.optional(z.string()),
    challenge: z.optional(adapterConnectChallengeSchema),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: nonEmptyStringSchema,
    challenge: z.optional(adapterConnectChallengeSchema),
  }),
]);

export type AdapterConnectResult =
  | {
      ok: true;
      adapter: string;
      accountId: string;
      connected: boolean;
      authenticated: boolean;
      message?: string;
      challenge?: AdapterConnectChallenge;
    }
  | {
      ok: false;
      error: string;
      challenge?: AdapterConnectChallenge;
    };

/** Validate the complete public `adapter.connect` result at a client boundary. */
export function isAdapterConnectResult(value: JsonValue): value is AdapterConnectResult {
  return adapterConnectResultSchema.safeParse(value).success;
}

export type AdapterDisconnectArgs = {
  adapter: string;
  accountId: string;
};

export type AdapterDisconnectResult =
  | {
      ok: true;
      adapter: string;
      accountId: string;
      message?: string;
    }
  | {
      ok: false;
      error: string;
    };

export type AdapterSendArgs = {
  adapter: string;
  accountId: string;
  /** Stable idempotency key. Omitted for a new one-shot explicit send. */
  deliveryId?: string;
  surface: AdapterSurface;
  text: string;
  replyToId?: string;
  media?: AdapterMedia[];
  /** Acknowledge that this separate send intentionally duplicates the active run's directed endpoint. */
  also?: boolean;
};

export type AdapterSendResult =
  | {
      ok: true;
      adapter: string;
      accountId: string;
      surfaceId: string;
      deliveryId: string;
      messageId?: string;
      deliveryState?: "sent" | "deduplicated" | "ambiguous";
    }
  | {
      ok: false;
      error: string;
      /** Stable id to reuse when reconciling or retrying this delivery. */
      deliveryId?: string;
      /** True only when retrying the same deliveryId is safe. */
      retryable?: boolean;
    };

export type AdapterStatusArgs = {
  adapter: string;
  accountId?: string;
};

export type AdapterStatusResult = {
  adapter: string;
  accounts: AdapterAccountStatus[];
};

export type AdapterListArgs = Record<string, never>;

export type AdapterListEntry = {
  adapter: string;
  available: boolean;
  supportsConnect: boolean;
  supportsDisconnect: boolean;
  supportsSend: boolean;
  supportsStatus: boolean;
  supportsActivity: boolean;
  supportsPairing: boolean;
  accounts: AdapterAccountStatus[];
};

export type AdapterListResult = {
  adapters: AdapterListEntry[];
};

export type AdapterInboundArgs = {
  adapter: string;
  accountId: string;
  /** Stable account-scoped identity for the complete provider event. */
  deliveryId: string;
  message: AdapterInboundMessage;
};

export type AdapterInboundSyscallResult = AdapterInboundResult;

export type AdapterStateUpdateArgs = {
  adapter: string;
  accountId: string;
  status: AdapterAccountStatus;
};

export type AdapterStateUpdateResult = {
  ok: true;
};

export const adapterStateUpdateResultSchema = z.strictObject({
  ok: z.literal(true),
});

export type AdapterPairInfoArgs = {
  adapter: string;
};

export type AdapterPairInfoResult = {
  adapter: string;
  accountId: string;
  configured: boolean;
  botUsername?: string;
};

export type AdapterPairInspectArgs = {
  adapter: string;
  code: string;
};

export type AdapterPairInspectResult = {
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceId: string;
  actorName?: string;
  actorHandle?: string;
  expiresAt: number;
  linked: boolean;
};

export type AdapterPairConfirmArgs = AdapterPairInspectArgs;

export type AdapterPairConfirmResult = {
  paired: true;
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceId: string;
  uid: number;
};

export type AdapterPairDisconnectArgs = {
  adapter: string;
  accountId: string;
  actorId: string;
};

export type AdapterPairDisconnectResult = {
  disconnected: boolean;
  adapter: string;
  accountId: string;
  actorId: string;
};
