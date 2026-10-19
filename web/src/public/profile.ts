import type { PublicProfile } from "@humansandmachines/gsv/protocol";

export function renderPublicProfile(profile: PublicProfile): string {
  const documentUrl = `${profile.origin}/_gsv/federation/v2/subjects/${encodeURIComponent(profile.actor.subjectId)}`;
  const policy = { requests: "Open to message requests", invitation: "Connect by invitation", closed: "Not receiving new message requests" }[profile.contactPolicy];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(profile.displayName)} · Ship</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico?v=ship"><link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=ship">
<link rel="stylesheet" href="/social/profile.css"><link rel="alternate" type="application/json" href="${escapeHtml(documentUrl)}">
${profile.contactPolicy === "requests" ? '<script type="module" src="/social/connect.js"></script>' : ""}</head>
<body><main class="public-profile"><header><span class="brand">Ship</span><span class="status">${policy}</span></header>
<p class="alias">${escapeHtml(new URL(profile.origin).host)}</p><h1>${escapeHtml(profile.displayName)}</h1>
${profile.about ? `<p class="about">${escapeHtml(profile.about)}</p>` : ""}
<p class="representation">${profile.representation === "human-and-ship" ? "You may hear from this person or their Ship. Each message shows who sent it." : "A personal profile."}</p>
${profile.contactPolicy === "requests" ? `<details class="connect"><summary>Message from your Ship <span aria-hidden="true">↗</span></summary>
<form data-profile="${escapeHtml(profile.url)}"><label for="your-space">Your Ship address</label><div class="connect-input"><input id="your-space" name="space" placeholder="Your Ship’s address" autocomplete="url" inputmode="url" required maxlength="2048"><button type="submit">open my Ship</button></div>
<p>You’ll write your message in your Ship.</p><p class="connect-error" role="alert" hidden></p></form>
<noscript>Copy this profile address and open People in your Ship to start a conversation.</noscript></details>` : ""}
<footer><a href="${escapeHtml(documentUrl)}">Profile identity</a><span>${escapeHtml(new URL(profile.origin).host)}</span></footer>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
