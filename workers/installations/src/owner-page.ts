import { noStoreFormHeaders } from "./http";

/** The signup app's tokens and type, for pages Accounts renders on the server with no framework or bundle. */
const STYLE = `:root{color-scheme:dark;--void:#07061a;--panel:#0a0822;--border:#322e74;--border-raised:#4a449e;--hover:#171441;--text-hi:#f4f2ff;--text:#efeefe;--text-dim:#a29dd6;--accent:#b3aeff;--accent-bright:#cbc7ff;--primary:#5a52a8;--primary-edge:#6b62c4;--primary-hover:#6b62c4;--primary-text:#f4f2ff;--error:#ff6f8c}
@media (prefers-color-scheme: light){:root{color-scheme:light;--void:#f4f3fb;--panel:#fff;--border:#d8d4ec;--border-raised:#c4bee3;--hover:#edeaf8;--text-hi:#14112b;--text:#1b1836;--text-dim:#5f5a8c;--accent:#5a52a8;--accent-bright:#4a43a0;--primary:#5a52a8;--primary-edge:#6b62c4;--primary-hover:#4a43a0;--primary-text:#fff;--error:#c0364f}}
@font-face{font-family:"Martian Mono";src:url("/owner/signup/fonts/MartianMono-Variable.woff2") format("woff2");font-weight:400 700;font-display:swap}
@font-face{font-family:"Host Grotesk";src:url("/owner/signup/fonts/HostGrotesk-Variable.woff2") format("woff2");font-weight:300 800;font-display:swap}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100dvh;background:var(--void);color:var(--text);font:13px/1.6 "Martian Mono","IBM Plex Mono","JetBrains Mono",ui-monospace,monospace;-webkit-font-smoothing:antialiased}
header{display:flex;align-items:center;height:44px;padding:0 clamp(16px,5vw,64px)}
header a{color:var(--text-hi);font-weight:600;letter-spacing:.08em;text-decoration:none}
main{width:min(420px,100%);margin:0 auto;padding:clamp(32px,12vh,120px) 16px 48px;display:flex;flex-direction:column;gap:24px;overflow-wrap:anywhere}
h1{margin:0;color:var(--text-hi);font-size:22px;font-weight:400;line-height:1.5}
p{margin:0;font-family:"Host Grotesk","Avenir Next","Segoe UI",sans-serif;font-size:15px;line-height:1.55}
.quiet{color:var(--text-dim);font-size:14px}
a{color:var(--accent);text-underline-offset:3px}
a:hover{color:var(--accent-bright)}
form{margin:0;display:flex;flex-direction:column;gap:18px}
label{display:flex;flex-direction:column;gap:8px;color:var(--text-dim);font-size:12px}
input:not([type=hidden]){width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--border-raised);border-radius:0;background:var(--panel);color:var(--text-hi);font:inherit;font-size:16px;letter-spacing:.02em}
input:hover{border-color:var(--primary-edge)}
input:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 1px var(--accent)}
button{width:100%;min-height:44px;padding:11px 30px;border:1px solid var(--primary-edge);background:var(--primary);color:var(--primary-text);font:inherit;font-size:12px;letter-spacing:.16em;cursor:pointer}
button:hover{background:var(--primary-hover)}
a:focus-visible,button:focus-visible{outline:1px solid var(--accent);outline-offset:3px}
button.text{width:auto;min-height:32px;padding:0;border:0;background:none;color:var(--accent);font-size:12px;letter-spacing:0;text-decoration:underline;text-underline-offset:3px}
button.text:hover{background:none;color:var(--accent-bright)}
nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px;font-size:12px}
.notice{color:var(--error)}
.ships{list-style:none;margin:0;padding:0;border-top:1px solid var(--border)}
.ships li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 20px;padding:16px 0;border-bottom:1px solid var(--border)}
.ships li>div{min-width:0}
.ships strong{font-size:15px;font-weight:500}
.ships small{display:block;color:var(--text-dim);font-size:12px}
.ships .help{font-size:12px}
::selection{background:var(--accent);color:var(--void)}`;

export function randomOwnerPageSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One page shell for every owner route: no third-party assets, no-store, and a nonce for anything inline. */
export function ownerPage(content: string, options: { status?: number; cookies?: string[]; nonce?: string; noReferrer?: boolean } = {}): Response {
  const nonce = options.nonce ?? randomOwnerPageSecret();
  const headers = noStoreFormHeaders({ "content-type": "text/html; charset=utf-8", "content-security-policy":
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'` });
  // Forms need same-origin so their POST keeps an Origin header. A page at a provider callback URL must not leak it.
  if (options.noReferrer) headers.set("referrer-policy", "no-referrer");
  for (const value of options.cookies ?? []) headers.append("set-cookie", value);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>Ship</title><link rel="icon" href="/owner/signup/favicon.svg"><style nonce="${nonce}">${STYLE}</style></head><body><header><a href="/owner/spaces">Ship</a></header><main>${content}</main></body></html>`,
    { status: options.status ?? 200, headers });
}
