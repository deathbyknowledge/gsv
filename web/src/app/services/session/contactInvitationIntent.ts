import { OutdatedContactInvitationError, parseContactInvitation } from "@humansandmachines/gsv/protocol";
import { t } from "../../i18n/locale";

const KEY = "gsv.contact-invitation";

/** Preserve a contact invitation across the recipient's normal sign-in in this tab. */
export function pendingContactInvitation(): string | null {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  let supplied = fragment.get("contact");
  if (supplied) {
    try { supplied = parseContactInvitation(supplied).code; } catch { /* Keep invalid input for the error UI. */ }
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

export function contactInvitationPreview(value: string): { name: string; handle: string; expired: boolean } | { error: string } {
  try {
    const { invitation } = parseContactInvitation(value);
    return { name: invitation.name, handle: invitation.handle, expired: invitation.expiresAtMs <= Date.now() };
  } catch (cause) {
    // Any failure here means the pasted link or code is not a usable invitation.
    return { error: t(cause instanceof OutdatedContactInvitationError ? "session.contact.outdated" : "session.contact.invalid") };
  }
}
