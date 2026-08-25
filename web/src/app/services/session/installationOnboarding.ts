const STORAGE_ONBOARDING_TOKEN = "gsv.ui.installation-onboarding.v1";
const ONBOARDING_PATH = "/onboarding";
const ONBOARDING_TOKEN_PATTERN = /^onboard_[A-Za-z0-9_-]{32,128}$/;

export function readInstallationOnboardingToken(): string | null {
  if (window.location.pathname === ONBOARDING_PATH && window.location.hash.length > 1) {
    const token = window.location.hash.slice(1);
    if (ONBOARDING_TOKEN_PATTERN.test(token)) {
      try {
        window.sessionStorage.setItem(STORAGE_ONBOARDING_TOKEN, token);
      } catch {
        return null;
      } finally {
        removeFragment();
      }
      return token;
    }
    removeFragment();
    return null;
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
  } catch {
    // Ignore storage failures.
  }
  if (window.location.pathname === ONBOARDING_PATH) {
    window.history.replaceState(window.history.state, "", "/");
  }
}

function removeFragment(): void {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}
