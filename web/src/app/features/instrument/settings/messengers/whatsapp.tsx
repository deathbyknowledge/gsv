import type { JSX } from "preact";
import type { Translate } from "../../../../i18n/locale";

/** The countries Meta blocks across, by calling code. */
const WHATSAPP_CALLING_CODE_FLAGS = new Map([["55", "🇧🇷"], ["62", "🇮🇩"]]);

/** Names the countries the operator's WhatsApp number cannot reach, as the adapter reports them. */
export function whatsAppCountryList(codes: readonly string[], t: Translate): string {
  const sorted = [...codes].sort();
  if (sorted.join(",") === "55,62") return t("settings.pairing.whatsappCountries.both");
  return sorted
    .map((code) => code === "55"
      ? t("settings.pairing.whatsappCountries.brazil")
      : code === "62" ? t("settings.pairing.whatsappCountries.indonesia") : `+${code}`)
    .join(", ");
}

/**
 * The countries the operator's number cannot reach, folded behind their flags so it stays out of
 * the way of everyone else; a plain line when no flag names them, nothing when it reaches everyone.
 */
export function whatsAppReachNotice(codes: readonly string[], t: Translate): JSX.Element | null {
  if (!codes.length) return null;
  const flags = [...codes].sort().flatMap((code) => WHATSAPP_CALLING_CODE_FLAGS.get(code) ?? []).join(" ");
  const note = t("settings.pairing.whatsappUnreachable", { countries: whatsAppCountryList(codes, t) });
  if (!flags) return <p class="gsv-cf-note gsv-prose">{note}</p>;
  const label = t("settings.pairing.whatsappUnreachableLabel");
  return <details class="gsv-cf-aside gsv-prose gsv-cf-reach">
    <summary aria-label={label} title={label}>{flags}</summary>
    <p>{note}</p>
  </details>;
}

/**
 * How Ship names a WhatsApp account: by its masked number, or by its username when the person keeps
 * their number private and WhatsApp identifies them only by a user ID.
 */
export function whatsAppAccountLabel(account: { actorId: string; actorHandle?: string }, t: Translate): string {
  const handle = account.actorHandle;
  if (handle?.startsWith("@")) return t("settings.pairing.whatsappUsername", { id: handle });
  if (handle) return t("settings.pairing.whatsappNumber", { id: handle });
  return /^[0-9]+$/.test(account.actorId)
    ? t("settings.pairing.whatsappNumber", { id: account.actorId })
    : t("settings.pairing.whatsappIdentity");
}

/** The operator's WhatsApp number travels as a wa.me chat link; show it as a number. */
export function whatsAppNumberFromChatUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    const digits = url.hostname === "wa.me" ? url.pathname.replace(/^\//, "") : "";
    return /^[1-9][0-9]{4,14}$/.test(digits) ? `+${digits}` : "";
  } catch {
    return "";
  }
}
