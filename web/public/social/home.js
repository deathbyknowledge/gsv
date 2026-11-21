// The Ship's address shows its public profile, so on `/` a browser signed in to this Ship goes
// straight to the app instead. It runs before the page draws, so the owner never sees it flash.
// Everyone else gets a sign-in link that keeps what the address carried, such as a browser handoff.
// The key and shape are the web app's stored session (sessionService.ts); `/profile` always shows
// the page, so owners can see it as visitors do.
(() => {
  if (location.pathname !== "/") return;
  const app = `/chat${location.search}${location.hash}`;
  let signedIn = false;
  try {
    const session = JSON.parse(localStorage.getItem("gsv.ui.session.token.v1") ?? "null");
    signedIn = Boolean(session?.token) && (session.expiresAt === null || session.expiresAt > Date.now());
  } catch {}
  if (signedIn) {
    location.replace(app);
    return;
  }
  document.addEventListener("DOMContentLoaded", () => {
    const link = document.querySelector(".sign-in a");
    if (link instanceof HTMLAnchorElement) link.href = app;
  });
})();
