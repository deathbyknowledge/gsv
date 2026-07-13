import type { ExtensionConfig } from "./config";

export type ActivityKind = "shell" | "fs" | "connection" | "network" | "sensitive" | "error";
export type ActivityStatus = "active" | "ok" | "error" | "info";

export type ActivityEntry = {
  id: string;
  kind: ActivityKind;
  label: string;
  detail: string;
  status: ActivityStatus;
  at: string;
  durationMs?: number;
};

export type SensitiveState = {
  connected: boolean;
  networkCaptures: number;
  mediaRecordings: number;
  debuggerTabs: number[];
  lastSensitiveAt: string | null;
};

export type NetworkCaptureUiState = {
  tabId: number;
  active: boolean;
  startedAt: string;
  bodies: boolean;
  persist: boolean;
  bodyLimit: number;
  eventCount: number;
  requestCount: number;
  sessionPath?: string;
};

export type MediaCaptureGrantUiState = {
  tabId: number;
  title: string | null;
  url: string | null;
  grantedAt: string;
  expiresAt: string;
};

export type ExtensionUiState = {
  config: ExtensionConfig;
  connection: {
    state: "disconnected" | "connecting" | "connected";
    connectionId: string | null;
    message: string | null;
    reconnectSuppressed: boolean;
  };
  targetId: string;
  gatewayHost: string;
  activity: ActivityEntry[];
  sensitive: SensitiveState;
  network: {
    captures: NetworkCaptureUiState[];
  };
  media: {
    captureGrant: MediaCaptureGrantUiState | null;
  };
  artifact: {
    screenshots: number;
    networkSessions: number;
    files: number;
  };
  diagnostics: {
    lastConnectAttemptAt: string | null;
    lastConnectedAt: string | null;
    lastDisconnectedAt: string | null;
    lastSuccessfulConnectionId: string | null;
    lastConnectionErrorAt: string | null;
    lastConnectionError: string | null;
    lastErrorAt: string | null;
    lastError: string | null;
    activityCount: number;
    artifactPathCount: number;
    updatedAt: string | null;
  };
  updatedAt: string;
};

export type RuntimeMessage =
  | { type: "status" }
  | { type: "refresh" }
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "stop-all" }
  | { type: "grant-media-capture"; tabId?: number }
  | { type: "clear-diagnostics" }
  | { type: "save-config"; config: ExtensionConfig }
  | { type: "open-side-panel"; windowId?: number };

export type RuntimeResponse =
  | { ok: true; state: ExtensionUiState }
  | { ok: false; error: string; state?: ExtensionUiState };
