const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export function signupDestination(origin: string, onboardingToken?: string | null, username?: string): string {
  const url = new URL(origin);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== origin || (url.protocol !== "https:" && !local)) throw new Error("Invalid space address.");
  if (onboardingToken) {
    if (!/^onboard_[A-Za-z0-9_-]{43}$/.test(onboardingToken)) throw new Error("Invalid setup authorization.");
    url.pathname = "/onboarding";
    url.hash = onboardingToken;
    if (username) {
      if (!USERNAME_PATTERN.test(username)) throw new Error("Invalid username.");
      url.searchParams.set("username", username);
    }
  }
  return url.href;
}
