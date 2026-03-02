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
  | { ok: true; message?: string }
  | { ok: false; error: string };

export type AdapterSendResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: string };

export type AdapterCapabilities = {
  chatTypes: AdapterSurfaceKind[];
  media: boolean;
  reactions: boolean;
  threads: boolean;
  typing: boolean;
  editing: boolean;
  deletion: boolean;
  qrLogin?: boolean;
};

export type GatewayRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args: unknown;
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: {
    message: string;
    code?: string;
  };
};

export type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame;

export interface AdapterWorkerInterface {
  readonly adapterId: string;
  adapterConnect(
    accountId: string,
    config?: Record<string, unknown>,
  ): Promise<AdapterConnectResult>;
  adapterDisconnect(accountId: string): Promise<AdapterDisconnectResult>;
  adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
  ): Promise<AdapterSendResult>;
  adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]>;
}
