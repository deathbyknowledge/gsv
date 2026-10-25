import type { RequestReportCategory } from "@humansandmachines/gsv/protocol/syscalls/approach";
import type { HostedRepositoryModeration } from "@humansandmachines/gsv/services/pds";
import type { RequestReport, RequestReportPage, RequestReportResolution } from "../request-reports";
import type { OperatorAuditEvent } from "./insight";
import { adminPageResponse, auditTable, errorNotice, escapeHtml, formatDate, stateBadge, type AdminNavigationItem } from "./page";
import type { HostView } from "./takedowns";

const CATEGORY_LABELS = {
  spam: "Spam", harassment: "Harassment", impersonation: "Impersonation", sexual: "Sexual content", other: "Other",
} satisfies Record<RequestReportCategory, string>;
const RESOLUTION_LABELS = { dismissed: "Dismissed", "taken-down": "Sender taken down" } satisfies Record<RequestReportResolution, string>;

/** The queue of message requests people reported, open or closed. */
export function reportsPage(page: RequestReportPage, head: boolean, navigation: readonly AdminNavigationItem[]): Response {
  const open = page.state === "open";
  const pageLink = (number: number) => `/admin/reports?${new URLSearchParams(open ? { page: String(number) } : { state: "closed", page: String(number) })}`;
  return adminPageResponse({
    title: "Reports",
    section: "reports",
    navigation,
    head,
    content: `<section class="stack">
      <div class="page-heading"><div><p class="eyebrow">MESSAGE REQUESTS</p><h1>Reports</h1>
        <p class="subtitle">Message requests people reported to you. A report names its sender, and carries their name and message only when the person chose to include them.</p></div></div>
      <nav class="tabs" aria-label="Report status">
        <a class="button secondary" href="/admin/reports"${open ? ' aria-current="page"' : ""}>Open (${page.counts.open})</a>
        <a class="button secondary" href="/admin/reports?state=closed"${open ? "" : ' aria-current="page"'}>Closed (${page.counts.closed})</a>
      </nav>
      ${page.reports.length === 0
        ? `<div class="empty">${open ? "No open reports." : "No closed reports yet."}</div>`
        : `<div class="table-wrap"><table><thead><tr><th>Sender</th><th>Category</th><th>Reported by</th><th>Reported</th><th>Message</th>${open ? "" : "<th>Closed</th>"}</tr></thead>
          <tbody>${page.reports.map((report) => `<tr>
            <td>${senderCell(report, `/admin/reports/${encodeURIComponent(report.id)}`)}</td>
            <td>${CATEGORY_LABELS[report.category]}</td>
            <td>${reporterLink(report)}</td>
            <td>${formatDate(report.reportedAt)}</td>
            <td>${report.message ? "Included" : "Not included"}</td>
            ${report.closed ? `<td><strong>${RESOLUTION_LABELS[report.closed.resolution]}</strong><small>${formatDate(report.closed.at)}</small></td>` : ""}
          </tr>`).join("")}</tbody></table></div>
      <div class="pagination"><span>Page ${page.page} of ${page.totalPages}</span><div>
        ${page.page > 1 ? `<a class="button secondary" href="${pageLink(page.page - 1)}">Newer</a>` : ""}
        ${page.page < page.totalPages ? `<a class="button secondary" href="${pageLink(page.page + 1)}">Older</a>` : ""}
      </div></div>`}
    </section>`,
  });
}

/** One report: what its person shared, where its sender is hosted, the operator's actions and the action that closed it. */
export function reportPage(input: {
  report: RequestReport;
  /** Null on a deployment without an open-network host. */
  hosting: HostView<HostedRepositoryModeration> | null;
  /** How many open reports name the same sender. */
  openReports: number;
  /** The audit event of the action that closed the report. */
  closing: OperatorAuditEvent | null;
  error?: string;
  status?: number;
  head: boolean;
  navigation: readonly AdminNavigationItem[];
}): Response {
  const { report, hosting } = input;
  const path = `/admin/reports/${encodeURIComponent(report.id)}`;
  const hosted = hosting?.kind === "ok" ? hosting.repository : null;
  const takenDown = hosted?.takedowns.some(({ subject }) => subject.$type === "com.atproto.admin.defs#repoRef") ?? false;
  return adminPageResponse({
    title: "Report",
    section: "reports",
    navigation: input.navigation,
    head: input.head,
    status: input.status,
    content: `<section class="stack">
      <div class="page-heading"><div><p class="eyebrow">REPORTED MESSAGE REQUEST</p><h1>${escapeHtml(report.sender.handle ?? report.sender.did)}</h1>
        <p class="subtitle select-all">${escapeHtml(report.sender.did)}</p></div>
        <div class="actions"><a class="button secondary" href="/admin/reports">Back to reports</a></div></div>
      ${input.error ? errorNotice(input.error) : ""}
      <section class="panel"><p class="eyebrow">REPORT</p><h2>${CATEGORY_LABELS[report.category]}</h2>
        <dl class="definition-list">
          <dt>Status</dt><dd>${report.closed
            ? `${stateBadge("closed")} ${RESOLUTION_LABELS[report.closed.resolution]}, ${formatDate(report.closed.at)}`
            : stateBadge("open")}</dd>
          <dt>Reported by</dt><dd>${reporterLink(report)}</dd>
          <dt>Reported</dt><dd>${formatDate(report.reportedAt)}</dd>
          <dt>Request arrived</dt><dd>${formatDate(report.receivedAt)}</dd>
        </dl>
      </section>
      <section class="panel"><p class="eyebrow">WHAT THEY SENT</p>
        ${report.message
          ? `<details><summary>Their name and message, as the person saw them</summary>
            <p><strong>${escapeHtml(report.message.displayName)}</strong></p><p class="reported-message">${escapeHtml(report.message.text)}</p></details>`
          : "<p>The person didn't include the sender's name or message.</p>"}
      </section>
      ${hostingPanel(hosting, takenDown)}
      ${report.closed ? "" : `${hosted && !takenDown ? takedownForm(path, input.openReports) : ""}
      <section class="panel"><p class="eyebrow">DISMISS</p><h2>Dismiss the report</h2><p>Closes the report without acting on the sender.</p>
        <form class="form-actions" method="post" action="${path}/dismiss">
          <label><span>Reason (optional, kept in the audit log)</span><input name="reason" maxlength="500" autocomplete="off" value=""></label>
          <button class="secondary" type="submit">Dismiss</button>
        </form>
      </section>`}
      <section class="stack"><p class="eyebrow">AUDIT TRAIL</p>
        ${input.closing ? auditTable([input.closing], true) : `<div class="empty">${report.closed ? "The action that closed this report is not in the audit log." : "No operator action yet."}</div>`}
      </section>
    </section>`,
  });
}

function hostingPanel(hosting: HostView<HostedRepositoryModeration> | null, takenDown: boolean): string {
  const heading = `<p class="eyebrow">OPEN NETWORK</p><h2>The sender's account</h2>`;
  if (!hosting) return `<section class="panel">${heading}<p>This deployment runs no open-network host, so no account can be taken down from here.</p></section>`;
  if (hosting.kind === "unavailable") {
    return `<section class="panel">${heading}<p>The deployment's open-network host could not be read: <strong>${escapeHtml(hosting.reason)}</strong>.</p></section>`;
  }
  if (hosting.kind === "none") {
    return `<section class="panel">${heading}<p>The sender's account is hosted elsewhere, so it can't be taken down from here.</p></section>`;
  }
  const { installationId, handle } = hosting.repository;
  return `<section class="panel">${heading}
    <dl class="definition-list">
      <dt>Ship</dt><dd><a href="/admin/installations/${encodeURIComponent(installationId)}">${escapeHtml(handle)}</a><small> ${escapeHtml(installationId)}</small></dd>
      <dt>Account</dt><dd>${takenDown ? "Taken down" : "Active on this deployment's host"}</dd>
    </dl>
  </section>`;
}

function takedownForm(path: string, openReports: number): string {
  return `<section class="panel danger-zone"><p class="eyebrow">TAKE DOWN</p><h2>Take the sender's account down</h2>
    <p>Readers on the open network stop seeing the account, and it can't publish or call other Ships. Its person sees the takedown in People, with your reason. ${openReports > 1
      ? `It closes all ${openReports} open reports of this sender.`
      : "It closes this report."}</p>
    <form class="stack" method="post" action="${path}/takedown">
      <label><span>Reason (required; the sender's person reads it)</span><input name="reason" required maxlength="500" autocomplete="off" value=""></label>
      <div class="form-actions"><button class="danger" type="submit">Take down</button></div>
    </form>
  </section>`;
}

function senderCell(report: RequestReport, href: string): string {
  return report.sender.handle
    ? `<a href="${href}"><strong>${escapeHtml(report.sender.handle)}</strong></a><small class="select-all">${escapeHtml(report.sender.did)}</small>`
    : `<a href="${href}"><strong class="select-all">${escapeHtml(report.sender.did)}</strong></a>`;
}

function reporterLink(report: RequestReport): string {
  return `<a href="/admin/installations/${encodeURIComponent(report.installationId)}">${escapeHtml(report.handle ?? report.installationId)}</a>`;
}
