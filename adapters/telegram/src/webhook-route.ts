import { LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID } from "../../shared/src/installation";

export const TELEGRAM_APPROVAL_WEBHOOK_VERSION = 1;

export type TelegramWebhookRegistration = {
  url: string;
  secret_token: string;
  allowed_updates: string[];
};

export function telegramWebhookRegistration(
  webhookUrl: string,
  webhookSecret: string,
): TelegramWebhookRegistration {
  return {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "channel_post", "callback_query"],
  };
}

export async function reconcileTelegramApprovalWebhook(
  currentVersion: number,
  webhookUrl: string | null,
  webhookSecret: string | null,
  register: (registration: TelegramWebhookRegistration) => Promise<void>,
): Promise<number> {
  if (currentVersion >= TELEGRAM_APPROVAL_WEBHOOK_VERSION) return currentVersion;
  if (!webhookUrl || !webhookSecret) {
    throw new Error("Telegram approval webhook is not initialized");
  }
  await register(telegramWebhookRegistration(webhookUrl, webhookSecret));
  return TELEGRAM_APPROVAL_WEBHOOK_VERSION;
}

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
