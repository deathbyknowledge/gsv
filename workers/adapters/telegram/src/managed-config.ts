export function normalizedManagedTelegramBotUsername(value: string | undefined): string {
  return value?.trim().replace(/^@/, "") ?? "";
}

export function validManagedTelegramBotUsername(value: string | undefined): boolean {
  const username = normalizedManagedTelegramBotUsername(value);
  return username.length >= 5
    && username.length <= 32
    && /^[A-Za-z][A-Za-z0-9_]*bot$/i.test(username);
}

export function validManagedTelegramWebhookSecret(value: string | undefined): boolean {
  const secret = value?.trim() ?? "";
  return /^[A-Za-z0-9_-]{16,256}$/.test(secret);
}

export function managedTelegramConfigured(env: {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}): boolean {
  return Boolean(
    env.TELEGRAM_BOT_TOKEN?.trim()
    && validManagedTelegramBotUsername(env.TELEGRAM_BOT_USERNAME)
    && validManagedTelegramWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET),
  );
}
