import type {
  AdapterAccountStatus,
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterMedia,
  AdapterSurface,
} from "../adapters";
import {
  isAdapterConnectChallenge,
  type AdapterConnectChallenge,
} from "../adapters";

export type AdapterConnectArgs = {
  adapter: string;
  accountId: string;
  config?: Record<string, unknown>;
};

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
export function isAdapterConnectResult(value: unknown): value is AdapterConnectResult {
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
  return typeof result.adapter === "string"
    && result.adapter.trim().length > 0
    && typeof result.accountId === "string"
    && result.accountId.trim().length > 0
    && typeof result.connected === "boolean"
    && typeof result.authenticated === "boolean"
    && (result.message === undefined || typeof result.message === "string");
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
