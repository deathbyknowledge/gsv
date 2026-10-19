import { parseContactInvitation } from "@humansandmachines/gsv/protocol";

const KEY = "gsv.contact-invitation";

/** Preserve a contact invitation across the recipient's normal sign-in in this tab. */
export function pendingContactInvitation(): string | null {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const supplied = fragment.get("contact");
  if (supplied) {
    // Invalid links remain visible to the connection form, which explains the error.
    try {
      sessionStorage.setItem(KEY, supplied);
      fragment.delete("contact");
      url.hash = fragment.toString();
      window.history.replaceState(window.history.state, "", url);
    } catch { /* With storage unavailable, keep the fragment through sign-in. */ }
    return supplied;
  }
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

export function clearContactInvitation(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* The URL is the fallback storage. */ }
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (!fragment.has("contact")) return;
  fragment.delete("contact"); url.hash = fragment.toString();
  window.history.replaceState(window.history.state, "", url);
}

export function contactInvitationPreview(value: string): { name: string; origin: string; expired: boolean } | { error: string } {
  try {
    const { invitation } = parseContactInvitation(value);
    return { name: invitation.subject.displayName, origin: new URL(invitation.origin).host, expired: invitation.expiresAtMs <= Date.now() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "This invitation is not valid." };
  }
}
