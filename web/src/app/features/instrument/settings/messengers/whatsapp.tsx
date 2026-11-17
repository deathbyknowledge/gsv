import type { JSX } from "preact";
import type { Translate } from "../../../../i18n/locale";

/** The countries Meta blocks across, by calling code, as the region a language tag names. */
const WHATSAPP_CALLING_CODE_REGIONS = new Map([["55", "BR"], ["62", "ID"]]);
const WHATSAPP_CALLING_CODE_FLAGS = new Map([["55", "🇧🇷"], ["62", "🇮🇩"]]);

/**
 * The unreachable codes this device's languages place it in, such as pt-BR or Indonesian, so the warning reaches
 * only the people it concerns. A bare tag names its likeliest region: pt is Brazil, id is Indonesia.
 */
export function whatsAppReachForDevice(codes: readonly string[], languages: readonly string[]): string[] {
  const regions = new Set(languages.flatMap((tag) => {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      return region ? [region] : [];
    } catch {
      return [];
    }
  }));
  return codes.filter((code) => regions.has(WHATSAPP_CALLING_CODE_REGIONS.get(code) ?? ""));
}

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

/** The folded note's summary: the flags of the unreachable countries, then whom it concerns. */
export function whatsAppReachSummary(unreachable: readonly string[], t: Translate): string {
  return `${unreachable.map((callingCode) => WHATSAPP_CALLING_CODE_FLAGS.get(callingCode)).join(" ")} ${t(unreachable.length > 1
    ? "settings.pairing.whatsappReach.both"
    : unreachable[0] === "55" ? "settings.pairing.whatsappReach.brazil" : "settings.pairing.whatsappReach.indonesia")}`;
}

/** The unreachable countries this device's languages place it in, flagged and folded away; nothing for everyone else. */
export function whatsAppReachNotice(codes: readonly string[], t: Translate): JSX.Element | null {
  if (!codes.length) return null;
  return (
    <details class="gsv-cf-aside gsv-prose">
      <summary>{whatsAppReachSummary(codes, t)}</summary>
      <p>{t("settings.pairing.whatsappUnreachable", { countries: whatsAppCountryList(codes, t) })}</p>
    </details>
  );
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
