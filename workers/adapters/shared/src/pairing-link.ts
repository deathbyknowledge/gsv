import type { AdapterPairingLinkOffer } from "./pairing-claim";
import type { AdapterPairingLinkInput } from "./types";

/**
 * Link codes the Kernel mints for a person to send from a messenger. The code comes in the
 * message a link prefills, grouped in fours, or as a Telegram /start parameter.
 */
const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{12}$/;
const GROUPED_CODE = /(?:^|[^A-Za-z0-9-])([A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})(?![A-Za-z0-9-])/;
const START_CODE = /^\/start\s+([A-Za-z0-9]{12})$/;
const LINK_MESSAGE = /^Connect my Ship [A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/i;
/** A prefilled message is short; a code inside a longer message is ordinary conversation. */
const LINK_MESSAGE_LIMIT = 120;

/** The code a message carries, normalized, or null. */
export function pairingLinkCode(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length > LINK_MESSAGE_LIMIT) return null;
  const found = START_CODE.exec(trimmed)?.[1] ?? GROUPED_CODE.exec(trimmed)?.[1];
  const code = found?.replaceAll("-", "").toUpperCase();
  return code && PAIRING_CODE.test(code) ? code : null;
}

/**
 * Whether the message is just what a link sends, so it meant to connect even when its code is
 * spent. A code inside other words may be anything, such as a licence key for the person's Ship.
 */
export function isPairingLinkMessage(text: string): boolean {
  const trimmed = text.trim();
  return START_CODE.test(trimmed) || LINK_MESSAGE.test(trimmed);
}

/** The text a link prefills: the code grouped in fours after a few words saying what it does. */
export function pairingLinkMessage(code: string): string {
  return `Connect my Ship ${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** How a reply names a Ship: the host of its address. */
export function shipHost(canonicalOrigin: string): string {
  try {
    return new URL(canonicalOrigin).host;
  } catch {
    return canonicalOrigin;
  }
}

/**
 * Where someone without a Ship creates one, as the operator configured it, tagged with the
 * messenger that sent them as its `utm_source`: signup counts where it came from, and the new
 * Ship opens that messenger's connection. Unset, or anything but an HTTPS URL, offers no signup.
 */
export function messengerSignupUrl(configured: string | undefined, adapter: string): string | undefined {
  if (!configured?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(configured.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  url.searchParams.set("utm_source", adapter);
  return url.href;
}

/** The longest a minted code may live; the Kernel mints them for ten minutes. */
const MAX_LINK_LIFETIME_MS = 60 * 60 * 1000;

/** A minted code this adapter agreed to hold, and who it connects its sender to. */
export type PairingLinkHold = { code: string; expiresAt: number; link: AdapterPairingLinkOffer };

/** Checks a code the Kernel asks this adapter to hold for one of its people. */
export function parsePairingLinkInput(installationId: string, input: AdapterPairingLinkInput): PairingLinkHold {
  const code = input.code.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!PAIRING_CODE.test(code)) throw new Error("Pairing code is invalid");
  const now = Date.now();
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + MAX_LINK_LIFETIME_MS) {
    throw new Error("Pairing link expiry is invalid");
  }
  if (!Number.isSafeInteger(input.localUid) || input.localUid < 0 || input.localUid > 2_147_483_647) {
    throw new Error("localUid is invalid");
  }
  const origin = new URL(input.canonicalOrigin);
  if (origin.protocol !== "https:" || origin.origin !== input.canonicalOrigin.replace(/\/$/, "")) {
    throw new Error("canonicalOrigin must be an HTTPS origin");
  }
  return { code, expiresAt: input.expiresAt, link: { installationId, localUid: input.localUid, canonicalOrigin: origin.origin } };
}
