import type { Frame } from "./protocol/frames";

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
  | {
      ok: true;
      message?: string;
    }
  | {
      ok: false;
      error: string;
    };

export interface GatewayAdapterInterface {
  serviceFrame(frame: Frame): Promise<Frame | null>;
}

export interface AdapterWorkerInterface {
  readonly adapterId: string;

  connect?(accountId: string, config?: Record<string, unknown>): Promise<AdapterConnectResult>;
  disconnect?(accountId: string): Promise<AdapterDisconnectResult>;
  // TODO(gateway-os): Remove login/logout/start/stop compatibility methods
  // after all adapters implement connect/disconnect directly.
  login?(accountId: string, options?: Record<string, unknown>): Promise<
    | { ok: true; qrDataUrl?: string; message: string }
    | { ok: false; error: string }
  >;
  logout?(accountId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  start?(accountId: string, config: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>;
  stop?(accountId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  send(accountId: string, message: AdapterOutboundMessage): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  status(accountId?: string): Promise<AdapterAccountStatus[]>;
}
