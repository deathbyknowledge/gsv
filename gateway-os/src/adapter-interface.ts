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

export interface GatewayAdapterInterface {
  serviceFrame(frame: Frame): Promise<Frame | null>;
}

export interface AdapterWorkerInterface {
  readonly adapterId: string;

  send(accountId: string, message: AdapterOutboundMessage): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  status(accountId?: string): Promise<AdapterAccountStatus[]>;
}
