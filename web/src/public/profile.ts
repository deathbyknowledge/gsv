import type { PublicProfile } from "@humansandmachines/gsv/protocol";

export function renderPublicProfile(profile: PublicProfile): string {
  const documentUrl = `${profile.origin}/_gsv/federation/v2/subjects/${encodeURIComponent(profile.actor.subjectId)}`;
  const policy = { requests: "Open to message requests", invitation: "Connect by invitation", closed: "Not receiving new message requests" }[profile.contactPolicy];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(profile.displayName)} · GSV</title>
<link rel="stylesheet" href="/social/profile.css"><link rel="alternate" type="application/json" href="${escapeHtml(documentUrl)}"></head>
<body><main class="public-profile"><header><span class="brand">GSV</span><span class="status">${policy}</span></header>
<p class="alias">@${escapeHtml(profile.alias)}</p><h1>${escapeHtml(profile.displayName)}</h1>
${profile.about ? `<p class="about">${escapeHtml(profile.about)}</p>` : ""}
<p class="representation">${profile.representation === "human-and-ship" ? "You may hear from this person or their Ship. Each message shows who sent it." : "A personal profile."}</p>
<footer><a href="${escapeHtml(documentUrl)}">Profile identity</a><span>${escapeHtml(new URL(profile.origin).host)}</span></footer>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
