import { LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID } from "../../shared/src/installation";

export type WhatsAppConnectionStatus =
  | "idle"
  | "connecting"
  | "awaiting_qr"
  | "connected"
  | "reconnecting"
  | "logged_out"
  | "error";

export type WhatsAppAccountState = {
  version: 2;
  installationId: string | null;
  accountId: string;
  desired: "connected" | "disconnected";
  status: WhatsAppConnectionStatus;
  connected: boolean;
  authenticated: boolean;
  sessionEpoch: number;
  selfJid?: string;
  selfLid?: string;
  selfE164?: string;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastActivity?: number;
  lastError?: string;
  disconnectReason?: string;
  leaseRefreshAt?: number;
  reconnectAt?: number;
  connectionDeadlineAt?: number;
  pairingExpiresAt?: number;
  reconnectAttempt: number;
};

export type WhatsAppConnectResult =
  | { ok: true; connected: true; message: string }
  | {
      ok: true;
      connected: false;
      qr: string;
      expiresAt: number;
      message: string;
    }
  | { ok: false; error: string };

export function defaultWhatsAppAccountState(): WhatsAppAccountState {
  return {
    version: 2,
    installationId: null,
    accountId: "",
    desired: "disconnected",
    status: "idle",
    connected: false,
    authenticated: false,
    sessionEpoch: 0,
    reconnectAttempt: 0,
  };
}

export function restoreWhatsAppAccountState(
  stored: WhatsAppAccountState | undefined,
  legacyAccountId: string | undefined,
  hasRegisteredLegacyAuth: boolean,
  now: number,
): WhatsAppAccountState {
  if (stored?.version === 2) {
    const {
      rotationAt: _obsoleteRotationAt,
      lastMessageAt: _obsoleteLastMessageAt,
      ...current
    } = stored as WhatsAppAccountState & {
      rotationAt?: number;
      lastMessageAt?: number;
    };
    return {
      ...defaultWhatsAppAccountState(),
      ...current,
      installationId:
        "installationId" in stored
          ? current.installationId ?? null
          : LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
    };
  }
  if (!hasRegisteredLegacyAuth) {
    return { ...defaultWhatsAppAccountState(), accountId: legacyAccountId ?? "" };
  }
  return {
    ...defaultWhatsAppAccountState(),
    installationId: LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
    accountId: legacyAccountId ?? "",
    desired: "connected",
    status: "reconnecting",
    authenticated: true,
    reconnectAt: now + 1_000,
  };
}
