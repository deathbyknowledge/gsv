import type { AdapterConnectChallenge } from "@humansandmachines/gsv/protocol";

export const DEFAULT_WHATSAPP_QR_TTL_MS = 45_000;

export function initialWhatsAppAccountId(
  initialAccountId: string | null | undefined,
  existingAccountIds: readonly string[],
): string {
  return initialAccountId?.trim() || nextWhatsAppAccountId(existingAccountIds);
}

export function nextWhatsAppAccountId(existingAccountIds: readonly string[]): string {
  const existing = new Set(existingAccountIds.map((value) => value.trim()).filter(Boolean));
  if (!existing.has("default")) {
    return "default";
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `account-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `account-${Date.now()}`;
}

export function whatsappAccountIdError(
  value: string,
  existingAccountIds: readonly string[] = [],
): string {
  const accountId = value.trim();
  if (!accountId) {
    return "Enter a local account ID.";
  }
  if (accountId.length > 64) {
    return "Use 64 characters or fewer.";
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(accountId)) {
    return "Use letters, numbers, hyphens, or underscores.";
  }
  if (existingAccountIds.some((existing) => existing.trim() === accountId)) {
    return "That account ID already exists. Open it to reconnect or relink.";
  }
  return "";
}

export type WhatsAppQrSource =
  | { kind: "raw"; value: string }
  | { kind: "data-url"; value: string };

export function isWhatsAppQrImageDataUrl(value: string): boolean {
  const match = value.match(
    /^data:image\/(?:png|jpeg|webp|gif);base64,([a-z0-9+/]+={0,2})$/i,
  );
  return Boolean(match && match[1].length % 4 === 0);
}

export function whatsappQrSource(challenge: AdapterConnectChallenge | null): WhatsAppQrSource | null {
  if (challenge?.type !== "qr" || !challenge.data) {
    return null;
  }
  if (challenge.format === "data-url") {
    return isWhatsAppQrImageDataUrl(challenge.data)
      ? { kind: "data-url", value: challenge.data }
      : null;
  }
  if (challenge.format === "raw") {
    return { kind: "raw", value: challenge.data };
  }
  if (isWhatsAppQrImageDataUrl(challenge.data)) {
    return { kind: "data-url", value: challenge.data };
  }
  if (/^data:/i.test(challenge.data)) {
    return null;
  }
  return { kind: "raw", value: challenge.data };
}

export function whatsappQrExpiresAt(
  challenge: AdapterConnectChallenge,
  issuedAt: number,
): number {
  return typeof challenge.expiresAt === "number"
    && Number.isFinite(challenge.expiresAt)
    ? challenge.expiresAt
    : issuedAt + DEFAULT_WHATSAPP_QR_TTL_MS;
}

export function qrSecondsRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

export function whatsappPairingStatusStartedAt({
  challengeIssuedAt,
  connectAttemptStartedAt,
  reconnectExisting,
}: {
  challengeIssuedAt: number;
  connectAttemptStartedAt: number;
  reconnectExisting: boolean;
}): number {
  return challengeIssuedAt > 0
    ? challengeIssuedAt
    : reconnectExisting
      ? connectAttemptStartedAt
      : 0;
}

export function isFreshWhatsAppPairingStatus({
  authenticated,
  connected,
  pairingStatusStartedAt,
  statusUpdatedAt,
}: {
  authenticated: boolean;
  connected: boolean;
  pairingStatusStartedAt: number;
  statusUpdatedAt: number;
}): boolean {
  return pairingStatusStartedAt > 0
    && statusUpdatedAt >= pairingStatusStartedAt
    && connected
    && authenticated;
}
