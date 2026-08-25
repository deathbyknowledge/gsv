import { noStoreHeaders } from "../http";
import type {
  AdminInstallation,
  IssuedAdminInstallation,
} from "./service";

export function adminPage(
  installations: AdminInstallation[],
  issued?: IssuedAdminInstallation,
  error?: string,
  head = false,
  status = 200,
): Response {
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>GSV installation registry</title>
    <link rel="stylesheet" href="/admin/styles.css">
  </head>
  <body>
    <header class="topbar">
      <div>
        <span class="wordmark">GSV</span>
        <span class="product">installation registry</span>
      </div>
      <span class="private">private operator surface</span>
    </header>
    <main>
      <section class="heading">
        <div>
          <p class="eyebrow">MANAGED CONTROL PLANE</p>
          <h1>Installations</h1>
          <p>Reserve a hostname, assign its managed entitlement, and issue the first-boot link.</p>
        </div>
        <span class="count">${installations.length} registered</span>
      </section>
      ${error ? errorNotice(error) : ""}
      ${issued ? onboardingNotice(issued) : ""}
      <section class="workspace">
        <form class="create" method="post" action="/admin/installations">
          <div>
            <p class="section-label">NEW INSTALLATION</p>
            <h2>Reserve a GSV</h2>
            <p>The owner chooses their local username and password after opening the one-time link.</p>
          </div>
          <input type="hidden" name="operationId" value="operation_${crypto.randomUUID()}">
          <label>
            <span>Handle</span>
            <span class="handle-input">
              <input name="handle" required minlength="1" maxlength="63" pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" autocomplete="off" placeholder="hank">
            </span>
          </label>
          <button type="submit">Create installation</button>
        </form>
        <section class="registry" aria-labelledby="registry-heading">
          <div class="registry-heading">
            <div>
              <p class="section-label">REGISTRY</p>
              <h2 id="registry-heading">Current installations</h2>
            </div>
          </div>
          ${installationTable(installations)}
        </section>
      </section>
    </main>
  </body>
</html>`;
  return new Response(head ? null : body, {
    status,
    headers: adminHeaders("text/html; charset=utf-8"),
  });
}

export function adminStylesheet(head: boolean): Response {
  return new Response(head ? null : ADMIN_STYLES, {
    headers: adminHeaders("text/css; charset=utf-8"),
  });
}

function onboardingNotice(issued: IssuedAdminInstallation): string {
  const url = escapeHtml(issued.onboarding.onboardingUrl);
  return `<section class="notice success" aria-live="polite">
    <div>
      <p class="section-label">ONBOARDING LINK ISSUED</p>
      <h2>${escapeHtml(issued.installation.handle)} is ready to claim</h2>
      <p>This capability is shown only in this response. Reissuing it invalidates the previous link.</p>
    </div>
    <a class="onboarding-link" href="${url}" target="_blank" rel="noreferrer">Open onboarding</a>
    <code>${url}</code>
    <p class="expiry">Expires ${formatDate(issued.onboarding.expiresAt)}</p>
  </section>`;
}

function errorNotice(message: string): string {
  return `<section class="notice error" role="alert">
    <p class="section-label">REQUEST NOT COMPLETED</p>
    <p>${escapeHtml(message)}</p>
  </section>`;
}

function installationTable(installations: AdminInstallation[]): string {
  if (installations.length === 0) {
    return `<div class="empty">
      <p>No installations registered.</p>
      <span>Create the first one from the operator form.</span>
    </div>`;
  }
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Installation</th>
      <th>State</th>
      <th>Entitlement</th>
      <th>Created</th>
      <th><span class="sr-only">Actions</span></th>
    </tr></thead>
    <tbody>${installations.map(installationRow).join("")}</tbody>
  </table></div>`;
}

function installationRow(installation: AdminInstallation): string {
  const canReissue = installation.state === "reserved"
    || installation.state === "provisioning";
  return `<tr>
    <td>
      <a class="installation" href="${escapeHtml(installation.canonicalOrigin)}" target="_blank" rel="noreferrer">${escapeHtml(installation.handle)}</a>
      <span class="identifier">${escapeHtml(installation.installationId)}</span>
    </td>
    <td>
      <span class="state state-${escapeHtml(installation.state)}">${escapeHtml(installation.state)}</span>
      <span class="secondary">operation: ${escapeHtml(installation.operationState)}</span>
    </td>
    <td>
      <span>${escapeHtml(installation.entitlementState ?? "unassigned")}</span>
      <span class="secondary">${escapeHtml(installation.planKey ?? "—")}</span>
    </td>
    <td><time datetime="${new Date(installation.createdAt).toISOString()}">${formatDate(installation.createdAt)}</time></td>
    <td>${canReissue ? `<form method="post" action="/admin/installations/${encodeURIComponent(installation.installationId)}/onboarding"><button class="secondary-button" type="submit">Reissue link</button></form>` : ""}</td>
  </tr>`;
}

function formatDate(timestamp: number): string {
  return escapeHtml(new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(timestamp))) + " UTC";
}

function adminHeaders(contentType: string): Headers {
  const headers = noStoreHeaders({ "content-type": contentType });
  headers.set("referrer-policy", "same-origin");
  headers.set("content-security-policy", [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "style-src 'self'",
  ].join("; "));
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=()");
  return headers;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const ADMIN_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  color: #e8e8ef;
  background: #09090d;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color-scheme: dark;
}
body { min-width: 320px; min-height: 100vh; margin: 0; background: #09090d; }
button, input { font: inherit; }
.topbar {
  min-height: 58px; display: flex; align-items: center; justify-content: space-between;
  gap: 24px; padding: 0 28px; border-bottom: 1px solid #292932; background: #0d0d13;
}
.wordmark { color: #fff; font-size: 17px; font-weight: 700; letter-spacing: .12em; }
.product, .private, .section-label, .count, th, .identifier, .secondary, .expiry {
  color: #858593; font-size: 11px; letter-spacing: .08em;
}
.product { margin-left: 14px; }
.private { text-transform: uppercase; }
main { width: min(1440px, 100%); margin: 0 auto; padding: 48px 28px 80px; }
.heading { display: flex; align-items: end; justify-content: space-between; gap: 32px; margin-bottom: 34px; }
.heading h1 { margin: 7px 0 8px; color: #fff; font: 500 34px/1.1 system-ui, sans-serif; letter-spacing: -.03em; }
.heading p, .create p, .notice p { max-width: 720px; margin: 0; color: #a7a7b2; line-height: 1.55; }
.eyebrow, .section-label { margin: 0 !important; color: #8f8aff !important; }
.count { padding-bottom: 4px; white-space: nowrap; }
.workspace { display: grid; grid-template-columns: minmax(270px, 340px) minmax(0, 1fr); border: 1px solid #292932; }
.create { display: flex; flex-direction: column; gap: 28px; padding: 28px; border-right: 1px solid #292932; background: #0e0e15; }
h2 { margin: 7px 0 9px; color: #f8f8fb; font: 500 18px/1.25 system-ui, sans-serif; }
.create p { font: 13px/1.55 system-ui, sans-serif; }
label { display: grid; gap: 9px; color: #c8c8d0; font-size: 12px; }
.handle-input { display: flex; align-items: center; border: 1px solid #3a3a46; background: #08080c; }
.handle-input:focus-within { border-color: #8f8aff; box-shadow: 0 0 0 2px #8f8aff26; }
.handle-input input { min-width: 0; flex: 1; border: 0; outline: 0; padding: 12px; color: #fff; background: transparent; }
button, .onboarding-link {
  min-height: 40px; border: 1px solid #716bea; padding: 10px 14px; color: #fff;
  background: #34306f; text-decoration: none; cursor: pointer;
}
button:hover, button:focus-visible, .onboarding-link:hover, .onboarding-link:focus-visible { border-color: #aaa6ff; background: #46408d; outline: none; }
.registry { min-width: 0; background: #0b0b10; }
.registry-heading { min-height: 84px; display: flex; align-items: center; padding: 20px 24px; border-bottom: 1px solid #292932; }
.registry-heading h2 { margin-bottom: 0; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; text-align: left; }
th { padding: 12px 18px; border-bottom: 1px solid #292932; font-weight: 500; text-transform: uppercase; }
td { padding: 17px 18px; border-bottom: 1px solid #1f1f27; color: #c9c9d2; font-size: 12px; vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
.installation { color: #ecebff; font-size: 13px; text-decoration: none; }
.installation:hover { text-decoration: underline; }
.identifier, .secondary { display: block; max-width: 260px; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: 0; }
.state { display: inline-block; border: 1px solid #4a475f; padding: 4px 7px; color: #b9b6e9; font-size: 10px; text-transform: uppercase; }
.state-active, .state-trialing { border-color: #315f4b; color: #72d6aa; }
.state-provisioning { border-color: #58502e; color: #dfc86b; }
.secondary-button { min-height: 32px; border-color: #3d3d49; padding: 6px 9px; background: #17171e; font-size: 10px; white-space: nowrap; }
.empty { padding: 64px 24px; color: #aaaab5; text-align: center; }
.empty p { margin: 0 0 7px; color: #e5e5ec; }
.empty span { color: #73737f; font: 12px/1.5 system-ui, sans-serif; }
.notice { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px 24px; margin-bottom: 24px; border: 1px solid #315f4b; padding: 22px 24px; background: #0d1713; }
.notice code { grid-column: 1 / -1; overflow: auto; border: 1px solid #294638; padding: 12px; color: #bcefd5; background: #09110e; white-space: nowrap; }
.notice .expiry { grid-column: 1 / -1; }
.notice.error { display: block; border-color: #6c3439; background: #1a0e10; }
.notice.error .section-label { margin-bottom: 8px !important; color: #ff8f98 !important; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
@media (max-width: 820px) {
  .topbar { padding: 0 18px; }
  .private { display: none; }
  main { padding: 32px 16px 56px; }
  .heading { align-items: start; flex-direction: column; gap: 12px; }
  .workspace { grid-template-columns: 1fr; }
  .create { border-right: 0; border-bottom: 1px solid #292932; }
  .notice { grid-template-columns: 1fr; }
  .notice code, .notice .expiry { grid-column: 1; }
}`;
