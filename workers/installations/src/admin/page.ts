import { noStoreFormHeaders } from "../http";
import type { IssuedAdminInstallation } from "./service";
import type { OperatorAuditEvent } from "./insight";

export type AdminNavigationItem = { section: string; href: string; label: string };

export function adminPageResponse(input: {
  title: string;
  section: string;
  navigation?: readonly AdminNavigationItem[];
  content: string;
  head?: boolean;
  status?: number;
}): Response {
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.title)} · GSV registry</title>
    <link rel="stylesheet" href="/admin/styles.css">
    <script src="/admin/time.js" defer></script>
  </head>
  <body>
    <header class="topbar">
      <a class="brand" href="/admin/installations"><strong>Ship</strong><span>administration</span></a>
      <nav aria-label="Operator navigation">
        ${navLink("/admin/installations", "Ships", input.section === "installations")}
        ${navLink("/admin/reports", "Reports", input.section === "reports")}
        ${(input.navigation ?? []).map((item) => navLink(item.href, item.label, input.section === item.section)).join("")}
        ${navLink("/admin/signup", "Signup", input.section === "signup")}
        ${navLink("/admin/audit", "Audit", input.section === "audit")}
      </nav>
      <small>private operator surface</small>
    </header>
    <main>${input.content}</main>
  </body>
</html>`;
  return new Response(input.head ? null : body, {
    status: input.status ?? 200,
    headers: adminHeaders("text/html; charset=utf-8"),
  });
}

export function adminErrorPage(
  message: string,
  status: number,
  head = false,
  navigation: readonly AdminNavigationItem[] = [],
): Response {
  return adminPageResponse({
    title: status === 404 ? "Not found" : "Request not completed",
    section: "installations",
    navigation,
    head,
    status,
    content: `<section class="narrow stack">
      <div class="page-heading"><div><p class="eyebrow">OPERATOR REQUEST</p><h1>${status === 404 ? "Not found" : "Request not completed"}</h1></div></div>
      ${errorNotice(message)}
      <p><a class="button secondary" href="/admin/installations">Back to Ships</a></p>
    </section>`,
  });
}

export function adminStylesheet(head: boolean): Response {
  return new Response(head ? null : ADMIN_STYLES, {
    headers: adminHeaders("text/css; charset=utf-8"),
  });
}

export function adminTimeScript(head: boolean): Response {
  return new Response(head ? null : ADMIN_TIME_SCRIPT, {
    headers: adminHeaders("text/javascript; charset=utf-8"),
  });
}

export function onboardingNotice(issued: IssuedAdminInstallation): string {
  const url = escapeHtml(issued.onboarding.onboardingUrl);
  const resetCopy = issued.reset
    ? `<p>The previous Ship <strong>${escapeHtml(issued.reset.previousInstallationId)}</strong> is offline. Its stored data is recorded as ${escapeHtml(issued.reset.dataDeletionState)} deletion; reset itself did not erase it.</p>`
    : "";
  return `<section class="notice success" aria-live="polite">
    <div><p class="eyebrow">ACTIVATION LINK ISSUED</p><h2>${escapeHtml(issued.installation.handle)} is ready to claim</h2>
    <p>This capability is shown only in this response. Reissuing it invalidates the previous link.</p>${resetCopy}</div>
    <a class="button" href="${url}" target="_blank" rel="noreferrer">Open activation link</a>
    <code>${url}</code><small>Expires ${formatDate(issued.onboarding.expiresAt)}</small>
  </section>`;
}

export function errorNotice(message: string): string {
  return `<section class="notice error" role="alert"><p class="eyebrow">REQUEST NOT COMPLETED</p><p>${escapeHtml(message)}</p></section>`;
}

export function stateBadge(value: string): string {
  return `<span class="badge badge-${escapeHtml(value.replaceAll("_", "-"))}">${escapeHtml(value.replaceAll("_", " "))}</span>`;
}

export function formatDate(timestamp: number | null): string {
  if (timestamp === null) return "Not yet";
  const date = new Date(timestamp);
  const fallback = escapeHtml(new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)) + " UTC";
  return `<time datetime="${date.toISOString()}" data-local-time="date">${fallback}</time>`;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const fallback = escapeHtml(new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date)) + " UTC";
  return `<time datetime="${date.toISOString()}" data-local-time="time">${fallback}</time>`;
}

/** Durations as an operator reads them: 200ms, 3s, 6m 15s, 2h 4m. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const AUDIT_OUTCOME_NOTES = {
  completed: "",
  error: "<small>Returned an error</small>",
  pending: "<small>Outcome not recorded</small>",
} satisfies Record<OperatorAuditEvent["outcome"], string>;

export function auditTable(events: readonly OperatorAuditEvent[], showShip: boolean): string {
  return `<div class="table-wrap"><table class="audit"><thead><tr><th>When</th><th>Operator</th><th>Action</th>${showShip ? "<th>Ship</th>" : ""}<th>Reason</th></tr></thead>
    <tbody>${events.map((event) => `<tr>
      <td>${formatTime(event.at)}</td>
      <td>${escapeHtml(event.actor)}</td>
      <td><strong>${escapeHtml(event.action)}</strong>${AUDIT_OUTCOME_NOTES[event.outcome]}${event.detail ? `<small>${Object.entries(event.detail).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`).join(" · ")}</small>` : ""}</td>
      ${showShip ? `<td>${event.installationId ? `<a href="/admin/installations/${encodeURIComponent(event.installationId)}">${escapeHtml(event.handle ?? event.installationId)}</a>${event.handle ? `<small>${escapeHtml(event.installationId)}</small>` : ""}` : "—"}</td>` : ""}
      <td>${event.reason ? escapeHtml(event.reason) : "—"}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

export function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}

export function metric(label: string, value: string): string {
  return `<div class="metric"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function navLink(href: string, label: string, active: boolean): string {
  return `<a href="${escapeHtml(href)}"${active ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
}

function adminHeaders(contentType: string): Headers {
  const headers = noStoreFormHeaders({ "content-type": contentType });
  headers.set("content-security-policy", [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "style-src 'self'",
    "script-src 'self'",
  ].join("; "));
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set(
    "permissions-policy",
    "camera=(), geolocation=(), microphone=(), payment=()",
  );
  return headers;
}

const ADMIN_TIME_SCRIPT = `
(() => {
  const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const timezone = dateFormatter.resolvedOptions().timeZone;
  for (const time of document.querySelectorAll('time[data-local-time]')) {
    const formatter = time.dataset.localTime === 'time' ? timeFormatter : dateFormatter;
    time.textContent = formatter.format(new Date(time.dateTime)) + ' ' + timezone;
  }
})();
`;

const ADMIN_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
:root { color: #e8e8ef; background: #09090d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color-scheme: dark; }
body { min-width: 320px; min-height: 100vh; margin: 0; }
a { color: #b9b6ff; }
.select-all { user-select: all; }
.topbar { min-height: 62px; display: flex; align-items: center; gap: 30px; padding: 0 28px; border-bottom: 1px solid #292932; }
.brand { display: flex; align-items: center; gap: 14px; color: inherit; text-decoration: none; }
.brand strong { letter-spacing: .12em; } .brand span, .topbar small { color: #858593; }
.topbar nav { display: flex; align-self: stretch; gap: 4px; }
.topbar nav a { display: flex; align-items: center; padding: 0 14px; color: #9d9daa; text-decoration: none; border-bottom: 2px solid transparent; }
.topbar nav a[aria-current="page"] { color: #fff; border-bottom-color: #8f8aff; }
.topbar small { margin-left: auto; text-transform: uppercase; }
main { width: min(1180px, 100%); margin: auto; padding: 48px 28px 80px; }
.narrow { width: min(760px, 100%); margin-inline: auto; }
.stack { display: grid; gap: 24px; }
.page-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; }
.page-heading .actions { display: flex; align-items: center; gap: 10px; }
h1 { margin: 7px 0 0; font: 500 34px system-ui, sans-serif; } h2 { margin: 7px 0 10px; font: 500 18px system-ui, sans-serif; }
p { color: #a7a7b2; font: 13px/1.55 system-ui, sans-serif; }
.eyebrow { margin: 0; color: #8f8aff; font: 11px/1.3 ui-monospace, monospace; letter-spacing: .08em; }
.panel { border: 1px solid #292932; padding: 24px; background: #0e0e15; }
.panel > :first-child { margin-top: 0; } .panel > :last-child { margin-bottom: 0; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
.filters { display: grid; grid-template-columns: minmax(220px, 1fr) 190px auto auto; align-items: end; gap: 10px; }
label { display: grid; gap: 8px; color: #c4c4ce; font-size: 12px; }
input, select, textarea { width: 100%; border: 1px solid #3a3a46; padding: 11px 12px; color: #fff; background: #08080c; font: inherit; }
button, .button { display: inline-block; border: 1px solid #716bea; padding: 10px 14px; color: #fff; background: #34306f; font: inherit; line-height: normal; text-align: center; text-decoration: none; cursor: pointer; }
button.secondary, .button.secondary { border-color: #3d3d49; background: #17171e; } button.danger, .button.danger { border-color: #743b42; background: #481f25; }
.table-wrap { overflow-x: auto; border: 1px solid #292932; }
table { width: 100%; border-collapse: collapse; text-align: left; } th, td { padding: 15px 16px; border-bottom: 1px solid #292932; font-size: 12px; vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; } th { color: #858593; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; }
td strong, td small { display: block; } td small { margin-top: 6px; color: #858593; } td a { color: #ecebff; }
.badge { display: inline-block; border: 1px solid #4b485e; padding: 4px 7px; color: #d8d6ef; background: #181720; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
.badge-active, .badge-enabled { border-color: #315f4b; color: #9de0be; background: #0d1713; } .badge-restricted, .badge-failed, .badge-past-due, .badge-disabled, .badge-paused { border-color: #743b42; color: #efafb5; background: #1a0e10; }
.empty { border: 1px solid #292932; padding: 50px 20px; color: #858593; text-align: center; }
.pagination { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.pagination div { display: flex; gap: 8px; } .pagination span { color: #858593; font-size: 12px; }
.notice { display: grid; grid-template-columns: 1fr auto; gap: 12px 24px; border: 1px solid #315f4b; padding: 22px; background: #0d1713; }
.notice h2 { margin-bottom: 0; } .notice p { margin-bottom: 0; } .notice code, .notice small { grid-column: 1 / -1; } .notice code { overflow: auto; padding: 12px; background: #09110e; } .notice small { color: #8ba998; }
.notice.error { display: block; border-color: #6c3439; background: #1a0e10; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid #292932; }
.metric { min-width: 0; padding: 20px; border-right: 1px solid #292932; background: #0e0e15; } .metric:last-child { border-right: 0; }
.metric small { display: block; margin-bottom: 8px; color: #858593; text-transform: uppercase; } .metric strong { font: 500 22px system-ui, sans-serif; overflow-wrap: anywhere; }
.definition-list { display: grid; grid-template-columns: 150px minmax(0, 1fr); margin: 0; }
.definition-list dt, .definition-list dd { margin: 0; padding: 11px 0; border-bottom: 1px solid #292932; font-size: 12px; } .definition-list dt { color: #858593; } .definition-list dd { overflow-wrap: anywhere; }
.definition-list dt:last-of-type, .definition-list dd:last-of-type { border-bottom: 0; }
.form-actions { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
.form-actions label { min-width: 180px; flex: 1; }
.danger-zone { border-color: #513137; background: #130d10; }
.consequences { margin: 0; padding-left: 18px; color: #c4c4ce; font: 13px/1.55 system-ui, sans-serif; } .consequences li + li { margin-top: 6px; }
.subtitle { margin: 8px 0 0; font-family: ui-monospace, monospace; font-size: 12px; overflow-wrap: anywhere; }
.definition-list small { color: #858593; }
.badge-ok, .badge-online { border-color: #315f4b; color: #9de0be; background: #0d1713; } .badge-error, .badge-aborted, .badge-offline { border-color: #743b42; color: #efafb5; background: #1a0e10; }
.timeline td, .audit td { padding: 10px 14px; vertical-align: top; }
details summary { cursor: pointer; color: #c4c4ce; } .flag { color: #f1c48a; }
.tabs { display: flex; flex-wrap: wrap; gap: 8px; } .tabs a[aria-current="page"] { border-color: #716bea; background: #34306f; }
.reported-message { white-space: pre-wrap; overflow-wrap: anywhere; color: #e8e8ef; }
.steps { margin: 10px 0 0; padding-left: 18px; font: 11px/1.7 ui-monospace, monospace; color: #a7a7b2; }
.steps span { color: #6f6f7c; } .steps .step-slow { color: #f1c48a; } .steps .step-error { color: #efafb5; }
@media (max-width: 760px) { .topbar { flex-wrap: wrap; gap: 8px 18px; padding: 12px 18px 0; } .topbar nav { order: 3; width: 100%; height: 44px; } .topbar nav a { padding: 0 10px; } .topbar small { display: none; } main { padding: 32px 16px 60px; } .page-heading { align-items: start; flex-direction: column; } .filters { grid-template-columns: 1fr; } .grid, .metrics { grid-template-columns: 1fr; } .metric { border-right: 0; border-bottom: 1px solid #292932; } .metric:last-child { border-bottom: 0; } .notice { grid-template-columns: 1fr; } .notice .button, .notice code, .notice small { grid-column: 1; } .definition-list { grid-template-columns: 1fr; } .definition-list dt { padding-bottom: 3px; border-bottom: 0; } .definition-list dd { padding-top: 3px; } }
`;
