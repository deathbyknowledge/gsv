const STORAGE_ONBOARDING_TOKEN = "gsv.ui.installation-onboarding.v1";
const STORAGE_SIGNUP_ARRIVAL = "gsv.ui.installation-onboarding.signup.v1";
const STORAGE_FIRST_RUN_MESSENGER = "gsv.ui.first-run.messenger.v1";
const MESSENGER_PATTERN = /^[a-z0-9-]{1,32}$/;
const ONBOARDING_PATH = "/onboarding";
const SIGNUP_ARRIVAL_PARAM = "signup";
const ONBOARDING_TOKEN_PATTERN = /^onboard_[A-Za-z0-9_-]{32,128}$/;

export function readInstallationOnboardingToken(): string | null {
  if (window.location.pathname === ONBOARDING_PATH && window.location.hash.length > 1) {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("onboarding") ?? (fragment.has("contact") ? null : window.location.hash.slice(1));
    if (token && ONBOARDING_TOKEN_PATTERN.test(token)) {
      try {
        window.sessionStorage.setItem(STORAGE_ONBOARDING_TOKEN, token);
        // Signup names the messenger the person came from; it outlives setup, for the first run to open.
        const messenger = fragment.get("messenger");
        if (messenger && MESSENGER_PATTERN.test(messenger)) window.sessionStorage.setItem(STORAGE_FIRST_RUN_MESSENGER, messenger);
      } catch {}
      removeFragment();
      return token;
    }
    if (token !== null) { removeFragment(); return null; }
  }

  try {
    const token = window.sessionStorage.getItem(STORAGE_ONBOARDING_TOKEN);
    return token && ONBOARDING_TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** True when this onboarding token arrived straight from signup. A presentation hint bound to the
 *  token it came with, so a later setup opened in the same tab does not inherit it. */
export function readSignupArrival(token: string): boolean {
  if (window.location.pathname === ONBOARDING_PATH) {
    const params = new URLSearchParams(window.location.search);
    if (params.get(SIGNUP_ARRIVAL_PARAM) === "1") {
      params.delete(SIGNUP_ARRIVAL_PARAM);
      const search = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
      try {
        window.sessionStorage.setItem(STORAGE_SIGNUP_ARRIVAL, token);
      } catch {}
      return true;
    }
  }
  try {
    return window.sessionStorage.getItem(STORAGE_SIGNUP_ARRIVAL) === token;
  } catch {
    return false;
  }
}

/** The messenger a signup came from, which the first run opens once; only a setup link carries it. */
export function readFirstRunMessenger(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_FIRST_RUN_MESSENGER);
  } catch {
    return null;
  }
}

export function clearFirstRunMessenger(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_FIRST_RUN_MESSENGER);
  } catch {}
}

export function clearInstallationOnboardingToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_ONBOARDING_TOKEN);
    window.sessionStorage.removeItem(STORAGE_SIGNUP_ARRIVAL);
  } catch {}
  if (window.location.pathname === ONBOARDING_PATH) {
    removeFragment();
    window.history.replaceState(window.history.state, "", `/${window.location.hash}`);
  }
}

function removeFragment(): void {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const contact = fragment.get("contact");
  const remaining = contact ? `#${new URLSearchParams({ contact })}` : "";
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${remaining}`,
  );
}
