export function signupDestination(origin: string, onboardingToken?: string | null): string {
  const url = new URL(origin);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== origin || (url.protocol !== "https:" && !local)) throw new Error("Invalid space address.");
  if (onboardingToken) {
    if (!/^onboard_[A-Za-z0-9_-]{43}$/.test(onboardingToken)) throw new Error("Invalid setup authorization.");
    url.pathname = "/onboarding";
    url.hash = onboardingToken;
  }
  return url.href;
}
