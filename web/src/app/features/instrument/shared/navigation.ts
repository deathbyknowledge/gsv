/** A Memory page uses the same collection-scoped path as the library. */
export type MemoryPageRef = { db: string; path: string };

/** Keep browser handoff links intact while replacing legacy Chat paths. */
export function replaceLegacyChatPath() {
  const url = new URL(window.location.href);
  if (url.pathname === "/zen") url.pathname = "/chat";
  else if (url.pathname === "/zen/settings") url.pathname = "/chat/settings";
  else return;
  window.history.replaceState(window.history.state, "", url);
}
