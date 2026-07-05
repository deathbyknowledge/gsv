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

export type ShellExecArgs = {
  input: string;
};

export type ShellExecResult =
  | {
      status: "completed";
      output: string;
      exitCode: number;
      ok: true;
      pid: number;
      stdout: string;
      stderr: string;
    }
  | {
      status: "failed";
      output: string;
      error: string;
      exitCode: number;
      ok: false;
      pid: number;
      stdout: string;
      stderr: string;
    };

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
    code?: number | string;
    message: string;
    details?: unknown;
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
  adapterShellExec?(
    accountId: string,
    args: ShellExecArgs,
  ): Promise<ShellExecResult>;
  adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]>;
}

export type ChannelPeer = AdapterSurface;
export type ChannelSender = AdapterActor;
export type ChannelMedia = AdapterMedia;
export type ChannelInboundMessage = Omit<AdapterInboundMessage, "surface" | "actor"> & {
  peer: ChannelPeer;
  sender?: ChannelSender;
};
export type ChannelOutboundMessage = Omit<AdapterOutboundMessage, "surface"> & {
  peer: ChannelPeer;
};
export type ChannelAccountStatus = AdapterAccountStatus;
export type ChannelCapabilities = AdapterCapabilities;

export type StartResult = { ok: true } | { ok: false; error: string };
export type StopResult = { ok: true } | { ok: false; error: string };
export type SendResult = AdapterSendResult;
export type LoginResult = { ok: true; qrDataUrl?: string; message: string } | { ok: false; error: string };
export type LogoutResult = { ok: true } | { ok: false; error: string };

export interface ChannelWorkerInterface {
  readonly channelId: string;
  readonly capabilities: ChannelCapabilities;

  start(accountId: string, config: Record<string, unknown>): Promise<StartResult>;
  stop(accountId: string): Promise<StopResult>;
  status(accountId?: string): Promise<ChannelAccountStatus[]>;
  send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult>;
  setTyping?(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void>;
  login?(accountId: string, options?: { force?: boolean }): Promise<LoginResult>;
  logout?(accountId: string): Promise<LogoutResult>;
}
