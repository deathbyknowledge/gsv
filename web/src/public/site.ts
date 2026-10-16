import type { SiteManifest } from "@humansandmachines/gsv/protocol";

export function renderPublicSite(input: { manifest: SiteManifest; shareUrl: string; launchUrl: string; imageUrl: string }): string {
  const { manifest } = input;
  const title = escapeHtml(manifest.title);
  const description = escapeHtml(manifest.description);
  const launchUrl = escapeHtml(input.launchUrl);
  const shareUrl = escapeHtml(input.shareUrl);
  const imageUrl = escapeHtml(input.imageUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111320"><meta name="color-scheme" content="dark light">
<title>${title} · Ship</title><meta name="description" content="${description}"><link rel="canonical" href="${shareUrl}">
<meta property="og:type" content="website"><meta property="og:title" content="${title}">
<meta property="og:description" content="${description}"><meta property="og:url" content="${shareUrl}">
<meta property="og:image" content="${imageUrl}"><meta property="og:image:alt" content="${title}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${imageUrl}">
<style>*{box-sizing:border-box}html,body{margin:0;height:100%;background:#111320;color:#f2f3fa;font-family:system-ui,sans-serif}body{display:flex;flex-direction:column;height:100dvh}header{display:flex;align-items:center;gap:1rem;padding:12px max(16px,env(safe-area-inset-right)) 12px max(16px,env(safe-area-inset-left));border-bottom:1px solid #ffffff20;flex:none}h1{font-size:14px;line-height:1.4;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}a{font-size:13px;color:#d5d3ff;text-decoration:none;white-space:nowrap;border:1px solid #ffffff30;border-radius:8px;padding:8px 12px}a:focus-visible{outline:2px solid #bdacff;outline-offset:3px}iframe{border:0;display:block;width:100%;flex:1;min-height:0;background:#fff}.brand{font-size:12px;letter-spacing:.06em;color:#b4b8ce}@media(max-width:420px){.brand{display:none}header{gap:8px}}</style>
</head><body><header><span class="brand">SHIP</span><h1>${title}</h1><a href="${launchUrl}" target="_blank" rel="noopener noreferrer">Open full screen ↗</a></header>
<iframe src="${launchUrl}" title="${title}" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock allow-popups allow-popups-to-escape-sandbox" allow="fullscreen; gamepad" allowfullscreen referrerpolicy="no-referrer"></iframe>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
