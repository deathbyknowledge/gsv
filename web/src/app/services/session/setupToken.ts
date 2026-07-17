const SETUP_TOKEN_FRAGMENT_KEY = "setupToken";

type SetupTokenLocation = Pick<Location, "hash" | "pathname" | "search">;
type SetupTokenHistory = Pick<History, "replaceState" | "state">;

export function consumeSetupTokenFromFragment(
  location: SetupTokenLocation,
  history: SetupTokenHistory,
): string | undefined {
  const fragment = location.hash.startsWith("#")
    ? location.hash.slice(1)
    : location.hash;
  if (!fragment) {
    return undefined;
  }

  const params = new URLSearchParams(fragment);
  if (!params.has(SETUP_TOKEN_FRAGMENT_KEY)) {
    return undefined;
  }

  const setupToken = params.get(SETUP_TOKEN_FRAGMENT_KEY) ?? "";
  params.delete(SETUP_TOKEN_FRAGMENT_KEY);
  const remainingFragment = params.toString();
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}${remainingFragment ? `#${remainingFragment}` : ""}`,
  );

  return setupToken || undefined;
}
