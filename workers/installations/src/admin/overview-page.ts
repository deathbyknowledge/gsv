import { adminPageResponse, escapeHtml, type AdminNavigationItem, type AdminPageLink } from "./page";

export function adminOverviewPage(
  head: boolean,
  navigation: readonly AdminNavigationItem[] = [],
  links: readonly AdminPageLink[] = [],
): Response {
  return adminPageResponse({
    title: "Overview", section: "overview", navigation, head,
    content: `<section class="stack">
      <div class="page-heading"><div><p class="eyebrow">OPERATOR</p><h1>Overview</h1></div></div>
      <section class="panel"><h2>Growth and activity</h2>
        <p>Open your dashboards to review signups, activity, onboarding and retention.</p>
        <div class="form-actions">${links.map((link) => `<a class="button secondary" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} ↗</a>`).join("")}</div>
      </section>
      <section class="panel"><h2>Manage Ships</h2><p>Find an account, inspect its recent requests and manage its settings.</p>
        <a class="button" href="/admin/installations">Open Ships →</a>
      </section>
    </section>`,
  });
}
