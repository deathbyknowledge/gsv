import type { OperatorAuditPage } from "./insight";
import { adminPageResponse, auditTable, type AdminNavigationItem } from "./page";

export function adminAuditPage(
  page: OperatorAuditPage | null,
  head = false,
  navigation: readonly AdminNavigationItem[] = [],
): Response {
  return adminPageResponse({
    title: "Audit",
    section: "audit",
    navigation,
    head,
    content: `<section class="stack">
      <div class="page-heading"><div><p class="eyebrow">OPERATOR ACTIONS</p><h1>Audit log</h1></div></div>
      ${!page
        ? `<div class="empty">The audit log is not configured for this deployment.</div>`
        : page.events.length === 0
          ? `<div class="empty">No operator actions yet.</div>`
          : `${auditTable(page.events, true)}
      <div class="pagination"><span>Page ${page.page} of ${page.totalPages}</span><div>
        ${page.page > 1 ? `<a class="button secondary" href="/admin/audit?page=${page.page - 1}">Newer</a>` : ""}
        ${page.page < page.totalPages ? `<a class="button secondary" href="/admin/audit?page=${page.page + 1}">Older</a>` : ""}
      </div></div>`}
    </section>`,
  });
}
