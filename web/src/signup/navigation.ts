/** Marks a space opened straight from signup; it carries no authority, so setup may still require terms. */
export const SIGNUP_ARRIVAL_PARAM = "signup";

/** Best-effort space domain for the signup page: Accounts states the real one once the owner is signed in. */
export function presumedSpaceDomain(hostname: string): string | undefined {
  const labels = hostname.split(".");
  return labels.length >= 3 && !hostname.endsWith(".localhost") ? labels.slice(1).join(".") : undefined;
}

export function signupDestination(origin: string, onboardingToken?: string | null, contactInvitation?: string | null): string {
  const url = new URL(origin);
  const local = url.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost"));
  if (url.origin !== origin || (url.protocol !== "https:" && !local)) throw new Error("Invalid space address.");
  if (onboardingToken) {
    if (!/^onboard_[A-Za-z0-9_-]{43}$/.test(onboardingToken)) throw new Error("Invalid setup authorization.");
    url.pathname = "/onboarding";
    url.searchParams.set(SIGNUP_ARRIVAL_PARAM, "1");
    url.hash = contactInvitation ? new URLSearchParams({ onboarding: onboardingToken, contact: contactInvitation }).toString() : onboardingToken;
  }
  return url.href;
}
