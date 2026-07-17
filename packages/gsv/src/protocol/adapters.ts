export const MAX_ADAPTER_ACCOUNT_ID_LENGTH = 256;

const ADAPTER_ACCOUNT_ID_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Canonical account identity accepted at the gateway/adapter boundary.
 *
 * Provider identifiers are intentionally not restricted to hostname-like
 * characters: phone-number JIDs, bot identities, paths, and Unicode labels
 * are all legitimate account IDs. Only empty, unbounded, or control-character
 * values are rejected.
 */
export function normalizeAdapterAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > MAX_ADAPTER_ACCOUNT_ID_LENGTH
    || ADAPTER_ACCOUNT_ID_CONTROL_CHARACTERS.test(normalized)
  ) {
    return null;
  }
  return normalized;
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

export type AdapterMedia = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  data?: string;
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
  surface: AdapterSurface;
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
    text: string;
    replyToId?: string;
  };
  challenge?: {
    code: string;
    prompt: string;
    expiresAt: number;
  };
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
