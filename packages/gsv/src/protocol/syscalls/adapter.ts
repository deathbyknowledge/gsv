import type {
  AdapterAccountStatus,
  AdapterConnectChallenge,
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterMedia,
  AdapterSurface,
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
  /** Acknowledge that this explicit send intentionally duplicates the active run's automatic reply destination. */
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
