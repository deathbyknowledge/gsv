import { LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID } from "../../shared/src/installation";

export type TelegramWebhookRoute =
  | { kind: "opaque"; durableObjectId: string }
  | { kind: "legacy"; accountId: string };

export function buildTelegramWebhookPath(
  installationId: string,
  route: string,
): string {
  const encodedRoute = encodeURIComponent(route);
  return installationId === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID
    ? `/webhook/${encodedRoute}`
    : `/webhook/managed/${encodedRoute}`;
}

export function parseTelegramWebhookPath(
  pathname: string,
): TelegramWebhookRoute | null {
  const managedMatch = pathname.match(
    /^\/webhook\/managed\/([0-9a-f]{64})$/i,
  );
  if (managedMatch) {
    return { kind: "opaque", durableObjectId: managedMatch[1] };
  }

  const legacyMatch = pathname.match(/^\/webhook\/([^/]+)$/);
  if (!legacyMatch) return null;
  try {
    return {
      kind: "legacy",
      accountId: decodeURIComponent(legacyMatch[1]),
    };
  } catch {
    return null;
  }
}
