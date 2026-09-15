const E164_PATTERN = /^\+[1-9][0-9]{4,14}$/;
const GRAPH_ID_PATTERN = /^[0-9]{1,32}$/;
const VERIFY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export type ManagedWhatsAppConfigEnv = {
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_BUSINESS_ACCOUNT_ID?: string;
  WHATSAPP_WEBHOOK_BASE_URL?: string;
  WHATSAPP_DISPLAY_NUMBER?: string;
};

/** The number people message, normalized to E.164 with a leading plus. */
export function normalizedManagedWhatsAppDisplayNumber(value: string | undefined): string {
  const compact = value?.replace(/[\s().-]+/g, "") ?? "";
  return compact.startsWith("+") ? compact : compact ? `+${compact}` : "";
}

export function validManagedWhatsAppDisplayNumber(value: string | undefined): boolean {
  return E164_PATTERN.test(normalizedManagedWhatsAppDisplayNumber(value));
}

/** The digits WhatsApp uses for its click-to-chat links and its actor ids. */
export function managedWhatsAppDisplayDigits(value: string | undefined): string {
  return normalizedManagedWhatsAppDisplayNumber(value).replace(/^\+/, "");
}

export function managedWhatsAppChatUrl(value: string | undefined): string | undefined {
  if (!validManagedWhatsAppDisplayNumber(value)) return undefined;
  return `https://wa.me/${managedWhatsAppDisplayDigits(value)}?text=${encodeURIComponent("/link")}`;
}

export function validManagedWhatsAppVerifyToken(value: string | undefined): boolean {
  return VERIFY_TOKEN_PATTERN.test(value?.trim() ?? "");
}

export function validManagedWhatsAppGraphId(value: string | undefined): boolean {
  return GRAPH_ID_PATTERN.test(value?.trim() ?? "");
}

export function validManagedWhatsAppWebhookBaseUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function managedWhatsAppConfigured(env: ManagedWhatsAppConfigEnv): boolean {
  return Boolean(
    env.WHATSAPP_ACCESS_TOKEN?.trim()
    && (env.WHATSAPP_APP_SECRET?.trim().length ?? 0) >= 16
    && validManagedWhatsAppVerifyToken(env.WHATSAPP_VERIFY_TOKEN)
    && validManagedWhatsAppGraphId(env.WHATSAPP_PHONE_NUMBER_ID)
    && validManagedWhatsAppGraphId(env.WHATSAPP_BUSINESS_ACCOUNT_ID)
    && validManagedWhatsAppWebhookBaseUrl(env.WHATSAPP_WEBHOOK_BASE_URL)
    && validManagedWhatsAppDisplayNumber(env.WHATSAPP_DISPLAY_NUMBER),
  );
}

/** Keeps the country prefix and the last two digits; everything between is hidden. */
export function maskWhatsAppNumber(digits: string): string {
  if (!/^[0-9]{5,15}$/.test(digits)) return "";
  const head = digits.slice(0, 2);
  const tail = digits.slice(-2);
  return `+${head}${"•".repeat(digits.length - 4)}${tail}`;
}
