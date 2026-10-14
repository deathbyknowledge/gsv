const CREATION_INVITE = /^invite_[A-Za-z0-9_-]{43}$/;

/** Accept the original code or a link carrying it outside HTTP requests and referrers. */
export function parseCreationInvitation(input: string): string {
  const value = input.trim();
  if (CREATION_INVITE.test(value)) return value;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    const code = new URLSearchParams(url.hash.slice(1)).get("invite");
    if (code && CREATION_INVITE.test(code)) return code;
  } catch { /* Return one actionable error without including the supplied credential. */ }
  throw new Error("Paste the complete invitation link or code.");
}

export function creationInvitationUrl(code: string, destination: string): string {
  const url = new URL(destination);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set("invite", parseCreationInvitation(code));
  url.hash = fragment.toString();
  return url.href;
}
