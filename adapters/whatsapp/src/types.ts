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
  lastMessageAt?: number;
  lastActivity?: number;
  lastError?: string;
  disconnectReason?: string;
  rotationAt?: number;
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
  if (stored?.version === 2) return { ...defaultWhatsAppAccountState(), ...stored };
  if (!hasRegisteredLegacyAuth) {
    return { ...defaultWhatsAppAccountState(), accountId: legacyAccountId ?? "" };
  }
  return {
    ...defaultWhatsAppAccountState(),
    accountId: legacyAccountId ?? "",
    desired: "connected",
    status: "reconnecting",
    authenticated: true,
    reconnectAt: now + 1_000,
  };
}
