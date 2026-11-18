import { t } from "../app/i18n/locale";
import { publicDeployment } from "../app/services/deployment";

/** Marks a space opened straight from signup; it carries no authority, so setup may still require terms. */
export const SIGNUP_ARRIVAL_PARAM = "signup";

/** Best-effort space domain for the signup page: Accounts states the real one once the owner is signed in. */
export function presumedSpaceDomain(hostname: string): string | undefined {
  const labels = hostname.split(".");
  return labels.length >= 3 && !hostname.endsWith(".localhost") ? labels.slice(1).join(".") : undefined;
}

export function signupHomepage(accountsOrigin: string): string | undefined {
  const domain = publicDeployment().primaryDomain ?? presumedSpaceDomain(new URL(accountsOrigin).hostname);
  return domain ? `https://${domain}/` : undefined;
}

/** The messengers that send people without a Ship to signup; a signup from one opens its connection on the new Ship. */
const SIGNUP_MESSENGERS = ["whatsapp", "telegram"];

/** The messenger a signup came from: its link's `utm_source`, which a messenger sets to its own name. */
export function signupMessenger(utmSource: string | undefined): string | null {
  return utmSource && SIGNUP_MESSENGERS.includes(utmSource) ? utmSource : null;
}

/**
 * Where a signup continues: the new Ship's setup, with its authorization, the profile of whoever
 * invited the person and the messenger they came from in the fragment, so none of them reaches a
 * server log. An existing Ship opens a request to the inviter, as the inviter's public profile does.
 */
export function signupDestination(origin: string, onboardingToken?: string | null, carried: { invite?: string | null; messenger?: string | null } = {}): string {
  const url = new URL(origin);
  const local = url.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost"));
  if (url.origin !== origin || (url.protocol !== "https:" && !local)) throw new Error(t("signup.invalidAddress"));
  if (onboardingToken) {
    if (!/^onboard_[A-Za-z0-9_-]{43}$/.test(onboardingToken)) throw new Error(t("signup.invalidAuthorization"));
    url.pathname = "/onboarding";
    url.searchParams.set(SIGNUP_ARRIVAL_PARAM, "1");
    const fragment = new URLSearchParams({ onboarding: onboardingToken });
    if (carried.invite) fragment.set("invite", carried.invite);
    if (carried.messenger) fragment.set("messenger", carried.messenger);
    url.hash = carried.invite || carried.messenger ? fragment.toString() : onboardingToken;
  } else if (carried.invite) {
    url.pathname = "/people";
    url.searchParams.set("compose", carried.invite);
  }
  return url.href;
}
