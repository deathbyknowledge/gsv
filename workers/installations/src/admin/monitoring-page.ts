import { adminPageResponse, escapeHtml, formatCalendarDate, formatDate, formatInteger, formatRelativeDate, stateBadge, type AdminNavigationItem } from "./page";
import { outreachLabels, segmentLabels, OUTREACH_STATUSES, type ActivitySummary, type GrowthOverview, type Outreach, type OutreachEvent, type UserSegment } from "./monitoring";
import type { OperatorUsage } from "@humansandmachines/gsv/services/operator";

export function adminOverviewPage(value: GrowthOverview | null, head: boolean, navigation: readonly AdminNavigationItem[] = []): Response {
  const percent = (count: number, eligible: number) => eligible ? `${Math.round(count / eligible * 100)}%` : "—";
  const metrics = value ? [
    ["Total users", formatInteger(value.totalUsers)], ["New today / 7d", `${value.newToday} / ${value.newWeek}`],
    ["DAU / WAU", `${value.dau} / ${value.wau}`], ["Activation", percent(value.activated, value.activationEligible)],
    ["Day-7 retention", percent(value.retained, value.retentionEligible)],
  ] : [];
  return adminPageResponse({ title: "Overview", section: "overview", navigation, head, content: `<section class="stack">
    <div class="page-heading"><div><p class="eyebrow">GROWTH & ACTIVITY</p><h1>Overview</h1></div>
      <form method="post" action="/admin/monitoring/refresh"><button class="secondary" type="submit">Refresh activity</button></form></div>
    ${value ? `<div class="metrics growth-metrics">${metrics.map(([label, count]) => `<div class="metric"><small>${label}</small><strong>${count}</strong></div>`).join("")}</div>
    <p class="muted">${value.monitored} of ${value.totalUsers} users measured · ${value.latestSync ? `latest sync ${formatRelativeDate(value.latestSync)}` : "awaiting activity sync"}.
      Unknown history is excluded from activation and retention rates. Counts describe owner messages and their Ship runs.</p>
    <section class="panel stack"><div class="page-heading"><div><p class="eyebrow">LAST 30 DAYS · UTC</p><h2>Signups and active users</h2></div>
      <div class="chart-legend"><span class="series-signups">● Signups</span><span class="series-active">● Active users</span></div></div>
      ${growthChart(value.days)}
      <details><summary>Daily counts</summary><div class="table-wrap"><table><thead><tr><th>Date</th><th>Signups</th><th>Active users</th></tr></thead>
      <tbody>${value.days.map((day) => `<tr><td>${escapeHtml(day.day)}</td><td>${day.signups}</td><td>${day.activeUsers}</td></tr>`).join("")}</tbody></table></div></details>
    </section>
    <section class="panel"><h2>What these numbers mean</h2><p>DAU: owners who sent Ship a message in the last 24 hours. WAU: the last 7 days.
      Activation: at least one owner message after signup. Retention: another message on the seventh UTC calendar day after signup, among mature, measurable signups from the last 90 days.
      Counts include verified self-service signups and activated operator-issued Ships. Retired reset copies are excluded; replacements keep their original signup date.</p>
      <p><a href="/admin/installations?sort=last_active">Manage users →</a></p></section>` : `<div class="empty">Activity monitoring is not connected.</div>`}
  </section>` });
}

function growthChart(days: GrowthOverview["days"]): string {
  const max = Math.max(1, ...days.flatMap((day) => [day.signups, day.activeUsers]));
  const points = (field: "signups" | "activeUsers") => days.map((day, index) => `${40 + index * 900 / Math.max(1, days.length - 1)},${200 - day[field] * 170 / max}`).join(" ");
  return `<svg class="growth-chart" viewBox="0 0 970 235" role="img" aria-label="Daily signups and active users over the last 30 days">
    <line x1="40" y1="200" x2="940" y2="200" class="chart-grid"/><line x1="40" y1="30" x2="940" y2="30" class="chart-grid"/>
    <text x="5" y="35">${max}</text><text x="15" y="205">0</text>
    <polyline points="${points("signups")}" class="chart-signups"/><polyline points="${points("activeUsers")}" class="chart-active"/>
    <text x="40" y="228">${escapeHtml(days[0]?.day.slice(5) ?? "")}</text><text x="892" y="228">${escapeHtml(days.at(-1)?.day.slice(5) ?? "")}</text>
  </svg>`;
}

export function usagePanel(activity?: ActivitySummary, live?: OperatorUsage, segment?: UserSegment): string {
  const usage = live ?? activity;
  const count = (value?: number | null) => value === null || value === undefined ? "—" : formatInteger(value);
  return `<section class="panel"><div class="page-heading"><div><p class="eyebrow">USER ACTIVITY</p><h2>Usage and outcomes</h2></div>${segment ? stateBadge(segment, segmentLabels[segment]) : ""}</div>
    <div class="metrics usage-metrics">${[
      ["Last active", usage?.lastActiveAt ? formatRelativeDate(usage.lastActiveAt) : "Not recorded"],
      ["User messages", count(usage?.messages)], ["Finished tasks", count(usage?.tasks)], ["Successful", count(usage?.successfulTasks)], ["Failed", count(usage?.failedTasks)],
    ].map(([label, value]) => `<div class="metric"><small>${label}</small><strong>${value}</strong></div>`).join("")}</div>
    <p class="muted">${usage?.trackedFrom === 0 ? "Measured since this Ship was created." : usage?.trackedFrom ? `Measured since ${formatDate(usage.trackedFrom)}.` : "Awaiting a Gateway with activity tracking."}
      A task is an owner-requested Ship run; scheduled and background work is excluded. Success means the run completed normally.</p>
    ${activity?.capturedAt ? `<small class="muted">Snapshot ${formatRelativeDate(activity.capturedAt)}${activity.availability !== "ok" ? " · latest refresh unavailable" : ""}</small>` : ""}
  </section>`;
}

export function outreachPanel(path: string, current?: Outreach, history: OutreachEvent[] = []): string {
  if (!current) return "";
  return `<section class="panel stack" id="outreach"><div><p class="eyebrow">EARLY USER SUPPORT</p><h2>Outreach and notes</h2></div>
    <form class="stack" method="post" action="${path}/outreach"><input type="hidden" name="revision" value="${current.revision}">
      <div class="grid"><label><span>Outreach status</span><select name="status">${OUTREACH_STATUSES.map((status) => `<option value="${status}"${current.status === status ? " selected" : ""}>${outreachLabels[status]}</option>`).join("")}</select></label>
      <label><span>Last contacted</span><input name="lastContactedDate" type="date" value="${current.lastContactedAt === null ? "" : new Date(current.lastContactedAt).toISOString().slice(0, 10)}"></label></div>
      <label><span>Internal notes</span><textarea name="notes" maxlength="4000" rows="4" placeholder="Context, feedback, next step…">${escapeHtml(current.notes)}</textarea></label>
      <div><button type="submit">Save outreach</button><small class="muted"> Records status only; sending email is a separate action.</small></div>
    </form>
    <details><summary>Outreach history (${history.length}${history.length === 50 ? "+" : ""})</summary>
      ${history.length ? `<ol class="outreach-history">${history.map((entry) => `<li><div>${formatDate(entry.at)} · ${escapeHtml(entry.actor)} · ${escapeHtml(outreachLabels[entry.status])}</div>
        ${entry.lastContactedAt ? `<small>Last contacted ${formatCalendarDate(entry.lastContactedAt)}</small>` : ""}<p class="internal-note">${escapeHtml(entry.notes) || "No notes"}</p></li>`).join("")}</ol>` : "<p>No outreach recorded.</p>"}</details>
  </section>`;
}
