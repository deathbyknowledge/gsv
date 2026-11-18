import { replyLanguageFromCountry, replyLanguageFromPhoneNumber, type ReplyLanguage } from "../../shared/src/platform-replies";

/** A WhatsApp number as Meta reports it: the country code and digits, without a plus sign. */
const PHONE_NUMBER_PATTERN = /^[1-9][0-9]{4,14}$/;
/**
 * Meta's business-scoped user ID: a country code, a period and up to 128 letters and digits.
 * Meta sends it with every message, and instead of the number when a person with a
 * WhatsApp username has not shared their number with this business number.
 */
const USER_ID_PATTERN = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;

export function isWhatsAppPhoneNumber(value: string | undefined): value is string {
  return value !== undefined && PHONE_NUMBER_PATTERN.test(value);
}

export function isWhatsAppUserId(value: string | undefined): value is string {
  return value !== undefined && USER_ID_PATTERN.test(value);
}

/**
 * A person's address on the platform number: their user ID, or their number if this
 * adapter knew them by number before Meta began sending user IDs.
 */
export function isWhatsAppAddress(value: string): boolean {
  return isWhatsAppPhoneNumber(value) || isWhatsAppUserId(value);
}

/** The language of the platform's own replies: from the number's calling code, or the country a user ID carries. */
export function whatsAppReplyLanguage(address: string): ReplyLanguage {
  if (PHONE_NUMBER_PATTERN.test(address)) return replyLanguageFromPhoneNumber(address);
  return USER_ID_PATTERN.test(address) ? replyLanguageFromCountry(address.slice(0, 2)) : "en";
}
