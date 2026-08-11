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
    <header><strong>GSV</strong><span>installation registry</span><small>private operator surface</small></header>
    <main>
      <section class="heading">
        <div><p class="eyebrow">MANAGED CONTROL PLANE</p><h1>Installations</h1></div>
        <span>${installations.length} registered</span>
      </section>
      ${error ? errorNotice(error) : ""}
      ${issued ? onboardingNotice(issued) : ""}
      <section class="workspace">
        <form class="create" method="post" action="/admin/installations">
          <div><p class="eyebrow">NEW INSTALLATION</p><h2>Reserve a GSV</h2>
          <p>The owner chooses their local username and password from the one-time link.</p></div>
          <input type="hidden" name="operationId" value="operation_${crypto.randomUUID()}">
          <label><span>Handle</span><input name="handle" required minlength="1" maxlength="63" pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" autocomplete="off" placeholder="hank"></label>
          <button type="submit">Create installation</button>
        </form>
        <section class="registry"><p class="eyebrow">REGISTRY</p><h2>Current installations</h2>
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
  return `<section class="notice" aria-live="polite">
    <div><p class="eyebrow">ONBOARDING LINK ISSUED</p><h2>${escapeHtml(issued.installation.handle)} is ready to claim</h2>
    <p>This capability is shown only in this response. Reissuing it invalidates the previous link.</p></div>
    <a href="${url}" target="_blank" rel="noreferrer">Open onboarding</a>
    <code>${url}</code><small>Expires ${formatDate(issued.onboarding.expiresAt)}</small>
  </section>`;
}

function errorNotice(message: string): string {
  return `<section class="notice error" role="alert"><p class="eyebrow">REQUEST NOT COMPLETED</p><p>${escapeHtml(message)}</p></section>`;
}

function installationTable(installations: AdminInstallation[]): string {
  if (installations.length === 0) {
    return `<div class="empty">No installations registered.</div>`;
  }
  return `<div class="table-wrap"><table><thead><tr><th>Installation</th><th>State</th><th>Inference</th><th>Created</th><th></th></tr></thead>
    <tbody>${installations.map(installationRow).join("")}</tbody></table></div>`;
}

function installationRow(installation: AdminInstallation): string {
  const canReissue = installation.state === "reserved"
    || installation.state === "provisioning";
  return `<tr>
    <td><a href="${escapeHtml(installation.canonicalOrigin)}">${escapeHtml(installation.handle)}</a><small>${escapeHtml(installation.installationId)}</small></td>
    <td><span class="state">${escapeHtml(installation.state)}</span><small>operation: ${escapeHtml(installation.operationState)}</small></td>
    <td>${formatNanoUsd(installation.inference.costNanoUsd)}<small>${installation.inference.requests.toLocaleString("en-US")} requests · ${installation.inference.tokens.toLocaleString("en-US")} tokens${inferenceFailures(installation)}</small></td>
    <td>${formatDate(installation.createdAt)}</td>
    <td>${canReissue ? `<form method="post" action="/admin/installations/${encodeURIComponent(installation.installationId)}/onboarding"><button class="secondary" type="submit">Reissue link</button></form>` : ""}</td>
  </tr>`;
}

function inferenceFailures(installation: AdminInstallation): string {
  const failures = installation.inference.failed
    + installation.inference.aborted
    + installation.inference.abandoned;
  return failures > 0 ? ` · ${failures.toLocaleString("en-US")} incomplete` : "";
}

function formatNanoUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 9,
  }).format(value / 1_000_000_000);
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
:root { color: #e8e8ef; background: #09090d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color-scheme: dark; }
body { min-width: 320px; min-height: 100vh; margin: 0; }
header { min-height: 58px; display: flex; align-items: center; gap: 16px; padding: 0 28px; border-bottom: 1px solid #292932; }
header strong { letter-spacing: .12em; } header span, header small { color: #858593; } header small { margin-left: auto; text-transform: uppercase; }
main { width: min(1280px, 100%); margin: auto; padding: 48px 28px 80px; }
.heading { display: flex; align-items: end; justify-content: space-between; margin-bottom: 28px; }
h1 { margin: 7px 0 0; font: 500 34px system-ui, sans-serif; } h2 { margin: 7px 0 10px; font: 500 18px system-ui, sans-serif; }
.eyebrow { margin: 0; color: #8f8aff; font-size: 11px; letter-spacing: .08em; }
.workspace { display: grid; grid-template-columns: 320px minmax(0, 1fr); border: 1px solid #292932; }
.create, .registry { padding: 26px; } .create { display: flex; flex-direction: column; gap: 26px; border-right: 1px solid #292932; background: #0e0e15; }
.create p, .notice p { color: #a7a7b2; font: 13px/1.55 system-ui, sans-serif; }
label { display: grid; gap: 8px; font-size: 12px; } input { border: 1px solid #3a3a46; padding: 12px; color: #fff; background: #08080c; font: inherit; }
button, .notice a { border: 1px solid #716bea; padding: 10px 14px; color: #fff; background: #34306f; font: inherit; text-decoration: none; cursor: pointer; }
.notice { display: grid; grid-template-columns: 1fr auto; gap: 12px 24px; margin-bottom: 24px; border: 1px solid #315f4b; padding: 22px; background: #0d1713; }
.notice code, .notice small { grid-column: 1 / -1; } .notice code { overflow: auto; padding: 12px; background: #09110e; } .notice.error { display: block; border-color: #6c3439; background: #1a0e10; }
.table-wrap { overflow-x: auto; } table { width: 100%; border-collapse: collapse; text-align: left; } th, td { padding: 14px; border-bottom: 1px solid #292932; font-size: 12px; vertical-align: middle; }
td a { color: #ecebff; } td small { display: block; margin-top: 6px; color: #858593; } .state { color: #dfc86b; text-transform: uppercase; } button.secondary { padding: 7px 9px; border-color: #3d3d49; background: #17171e; white-space: nowrap; }
.empty { padding: 50px 0; color: #858593; text-align: center; }
@media (max-width: 760px) { header small { display: none; } main { padding: 32px 16px; } .workspace { grid-template-columns: 1fr; } .create { border-right: 0; border-bottom: 1px solid #292932; } .notice { grid-template-columns: 1fr; } }
`;
