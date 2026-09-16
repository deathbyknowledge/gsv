const E164_PATTERN = /^\+[1-9][0-9]{4,14}$/;
const GRAPH_ID_PATTERN = /^[0-9]{1,32}$/;
const VERIFY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
/** Meta template names are lowercase letters, digits and underscores. */
const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
/** Meta language codes such as `en`, `en_US` or `pt_BR`. */
const TEMPLATE_LANGUAGE_PATTERN = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;

export const DEFAULT_WHATSAPP_TEMPLATE_NAME = "gsv_message";
export const DEFAULT_WHATSAPP_TEMPLATE_LANGUAGE = "en";

export type ManagedWhatsAppTemplateEnv = {
  WHATSAPP_TEMPLATE_NAME?: string;
  WHATSAPP_TEMPLATE_LANGUAGE?: string;
};

export type ManagedWhatsAppConfigEnv = ManagedWhatsAppTemplateEnv & {
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_BUSINESS_ACCOUNT_ID?: string;
  WHATSAPP_WEBHOOK_BASE_URL?: string;
  WHATSAPP_DISPLAY_NUMBER?: string;
};

/** The Utility template Meta requires outside the customer service window. */
export type ManagedWhatsAppTemplate = {
  name: string;
  language: string;
};

/**
 * The template the adapter sends outside the window. Unset values take the
 * defaults; an empty name switches templates off, and an invalid value reads
 * as not configured so the send fails with a pointer to the docs.
 */
export function managedWhatsAppTemplate(env: ManagedWhatsAppTemplateEnv): ManagedWhatsAppTemplate | null {
  const name = env.WHATSAPP_TEMPLATE_NAME === undefined
    ? DEFAULT_WHATSAPP_TEMPLATE_NAME
    : env.WHATSAPP_TEMPLATE_NAME.trim();
  const language = env.WHATSAPP_TEMPLATE_LANGUAGE === undefined
    ? DEFAULT_WHATSAPP_TEMPLATE_LANGUAGE
    : env.WHATSAPP_TEMPLATE_LANGUAGE.trim();
  if (!TEMPLATE_NAME_PATTERN.test(name) || !TEMPLATE_LANGUAGE_PATTERN.test(language)) return null;
  return { name, language };
}

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
