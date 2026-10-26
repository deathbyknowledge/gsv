import type { ProfileContactPolicy } from "@humansandmachines/gsv/protocol";

/** What the public page shows: the Ship's published profile record, at its address. */
export type PublicProfilePage = {
  /** The profile's address, which the copy button and the request form carry. */
  url: string;
  /** The space's recorded handle, which names the profile; without one, its display name does. */
  handle?: string;
  displayName: string;
  about: string;
  contactPolicy: ProfileContactPolicy;
  /** Whether the page shows the record's picture, which the Ship serves at /profile/avatar. */
  avatar: boolean;
};

/** `homeOrigin` is the operator's own site (their primary domain); without one the wordmark stays plain. */
export function renderPublicProfile(profile: PublicProfilePage, homeOrigin?: string): string {
  // Handles in the request form resolve only on the operator's own domain.
  const handleDomain = homeOrigin ? new URL(homeOrigin).host : undefined;
  const handle = profile.handle ? `@${profile.handle}` : profile.displayName;
  // An open profile offers the request form; a restricted one says so in the same place.
  const restricted = profile.contactPolicy === "requests"
    ? `<details class="connect" id="connect"><summary>Message from your Ship <span aria-hidden="true">↗</span></summary>
<form data-profile="${escapeHtml(profile.url)}"${handleDomain ? ` data-handle-domain="${escapeHtml(handleDomain)}"` : ""}><label for="your-space">${handleDomain ? "Your handle" : "Your Ship address"}</label><div class="connect-input"><input id="your-space" name="space" placeholder="${handleDomain ? "@yourhandle" : "yourship.example"}" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="2048"><button type="submit">open my Ship</button></div>
<p>${handleDomain ? `Handles work for Ships on ${escapeHtml(handleDomain)}; for a Ship elsewhere, enter its full address. ` : ""}You’ll write your message in your Ship.</p><p class="connect-error" role="alert" hidden></p></form>
<noscript>Copy this profile address and open People in your Ship to start a conversation.</noscript></details>`
    : `<p class="restricted" data-info-row>Message requests restricted<span class="info" tabindex="0" role="button" aria-describedby="restricted-info" aria-label="About restricted message requests"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.2"/><text x="8" y="11.55" text-anchor="middle" font-size="9.5" font-weight="700" font-family="ui-sans-serif, system-ui, sans-serif" fill="currentColor" stroke="none">?</text></svg></span><span class="info-bubble" id="restricted-info" role="tooltip">${RESTRICTED}</span></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(handle)} · Ship</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico?v=cursor"><link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=cursor">
<link rel="stylesheet" href="/social/profile.css">
<script type="module" src="/social/profile.js"></script>
${profile.contactPolicy === "requests" ? '<script type="module" src="/social/connect.js"></script>' : ""}</head>
<body><main class="public-profile"><header>${homeOrigin ? `<a class="brand wordmark" href="${escapeHtml(homeOrigin)}">Ship</a>` : '<span class="brand wordmark">Ship</span>'}</header>
${profile.avatar ? '<img class="avatar" src="/profile/avatar" alt="" width="96" height="96" decoding="async">' : ""}
<div class="handle"><h1>${escapeHtml(handle)}</h1><button type="button" class="copy" data-copy="${escapeHtml(profile.url)}" aria-label="copy profile address" title="copy profile address" hidden>
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M10 3V2H2v9h1"/></svg></button>
<span class="copy-status" role="status"></span></div>
${profile.about ? `<p class="about">${escapeHtml(profile.about)}</p>` : '<p class="about is-empty">Space cowboy.</p>'}
${restricted}
</main></body></html>`;
}

const RESTRICTED = "This person only connects with people they invite. Ask them for an invitation link.";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
