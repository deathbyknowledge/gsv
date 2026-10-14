const STORAGE_ONBOARDING_TOKEN = "gsv.ui.installation-onboarding.v1";
const ONBOARDING_PATH = "/onboarding";
const ONBOARDING_TOKEN_PATTERN = /^onboard_[A-Za-z0-9_-]{32,128}$/;

export function readInstallationOnboardingToken(): string | null {
  if (window.location.pathname === ONBOARDING_PATH && window.location.hash.length > 1) {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("onboarding") ?? (fragment.has("contact") ? null : window.location.hash.slice(1));
    if (token && ONBOARDING_TOKEN_PATTERN.test(token)) {
      try {
        window.sessionStorage.setItem(STORAGE_ONBOARDING_TOKEN, token);
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

export function clearInstallationOnboardingToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_ONBOARDING_TOKEN);
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
