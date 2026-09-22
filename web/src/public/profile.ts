import type { PublicProfile } from "@humansandmachines/gsv/protocol";

export function renderPublicProfile(profile: PublicProfile): string {
  const documentUrl = `${profile.origin}/_gsv/federation/v2/subjects/${encodeURIComponent(profile.actor.subjectId)}`;
  const policy = { requests: "Open to message requests", invitation: "Connect by invitation", closed: "Not receiving new message requests" }[profile.contactPolicy];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(profile.displayName)} · GSV</title>
<link rel="stylesheet" href="/social/profile.css"><link rel="alternate" type="application/json" href="${escapeHtml(documentUrl)}">
${profile.contactPolicy === "requests" ? '<script type="module" src="/social/connect.js"></script>' : ""}</head>
<body><main class="public-profile"><header><span class="brand">GSV</span><span class="status">${policy}</span></header>
${profile.avatar ? `<img class="avatar" src="${escapeHtml(profile.avatar.url)}" alt="" width="128" height="128">` : ""}
<p class="alias">@${escapeHtml(profile.alias)}</p><h1>${escapeHtml(profile.displayName)}</h1>
${profile.about ? `<p class="about">${escapeHtml(profile.about)}</p>` : ""}
<p class="representation">${profile.representation === "human-and-ship" ? "You may hear from this person or their Ship. Each message shows who sent it." : "A personal profile."}</p>
${profile.contactPolicy === "requests" ? `<details class="connect"><summary>Message from your GSV <span aria-hidden="true">↗</span></summary>
<form data-profile="${escapeHtml(profile.url)}"><label for="your-space">Your GSV address</label><div class="connect-input"><input id="your-space" name="space" placeholder="you.gsv.space" autocomplete="url" inputmode="url" required maxlength="2048"><button type="submit">open my GSV</button></div>
<p>You’ll review this profile and write your message in your own space.</p><p class="connect-error" role="alert" hidden></p></form>
<noscript>Copy this profile address and open People in your GSV to start a conversation.</noscript></details>` : ""}
<footer><a href="${escapeHtml(documentUrl)}">Profile identity</a><span>${escapeHtml(new URL(profile.origin).host)}</span></footer>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
