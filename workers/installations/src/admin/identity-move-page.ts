import type { IdentityMoveStatus } from "../identity-moves";
import { adminPageResponse, errorNotice, escapeHtml, formatDate, formatInteger, metric, stateBadge, type AdminNavigationItem } from "./page";

export const IDENTITY_MOVE_NAVIGATION: AdminNavigationItem = { section: "identity-move", href: "/admin/identity-move", label: "Contacts move" };

const PHASE_LINE = {
  "not-started": "No Ship has been surveyed yet. The survey changes no contacts.",
  surveying: "The job is surveying the Ships, a few each minute.",
  ready: "Every Ship has answered. Review the totals, then apply the move.",
  moving: "The job is moving each Ship's contacts, a few each minute.",
  moved: "Every Ship's contacts are named by DID.",
} satisfies Record<IdentityMoveStatus["phase"], string>;

/** The operator's move of every Ship's contacts to DIDs: survey, review, apply. */
export function identityMovePage(
  status: IdentityMoveStatus,
  error: string | undefined,
  head: boolean,
  httpStatus: number,
  navigation: readonly AdminNavigationItem[],
): Response {
  const applied = status.phase === "moving" || status.phase === "moved";
  return adminPageResponse({
    title: "Contacts move",
    section: "identity-move",
    navigation,
    head,
    status: httpStatus,
    content: `<section class="stack">
      <div class="page-heading"><div><p class="eyebrow">OPEN NETWORK</p><h1>Move contacts to DIDs</h1>
        <p class="subtitle">${escapeHtml(PHASE_LINE[status.phase])}</p></div></div>
      ${error ? errorNotice(error) : ""}
      <div class="metrics">
        ${metric("Ships", formatInteger(status.ships.total))}${metric("Surveyed", formatInteger(status.ships.surveyed))}${metric("Moved", formatInteger(status.ships.moved))}${metric("Retrying", formatInteger(status.retrying.length))}
      </div>
      <section class="panel"><p class="eyebrow">SURVEY</p><h2>Who the Ships' rows name</h2>
        <dl class="definition-list">
          <dt>People named</dt><dd>${formatInteger(status.people.named)}</dd>
          <dt>With a DID here</dt><dd>${formatInteger(status.people.withDid)}</dd>
          <dt>Without one</dt><dd>${formatInteger(status.people.withoutDid)} <small>on another deployment, or their Ship is gone: their contacts end, and they must connect again</small></dd>
          <dt>Waiting rows</dt><dd>${counts(status.waiting)}</dd>
          <dt>Other accounts</dt><dd>${formatInteger(status.otherAccounts)} <small>contacts of an account other than a Ship's person, which end</small></dd>
        </dl>
      </section>
      ${applied ? `<section class="panel"><p class="eyebrow">MOVE</p><h2>What the move did</h2>
        <dl class="definition-list">
          <dt>Named by DID</dt><dd>${counts(status.moved)}</dd>
          <dt>Ended</dt><dd>${counts(status.ended)}</dd>
        </dl>
      </section>` : ""}
      ${status.retrying.length ? retryingTable(status.retrying) : ""}
      ${applied ? "" : actions(status)}
    </section>`,
  });
}

function actions(status: IdentityMoveStatus): string {
  const survey = `<section class="panel"><p class="eyebrow">SURVEY</p><h2>${status.phase === "not-started" ? "Survey every Ship" : "Survey again"}</h2>
    <p>Each Ship reports how other Ships knew its person and whom its own rows name. A Ship with contacts gets its DID; nothing else changes.</p>
    <form class="form-actions" method="post" action="/admin/identity-move/survey">${reasonField()}<button type="submit">Survey every Ship</button></form>
  </section>`;
  if (status.phase !== "ready") return survey;
  return `${survey}<section class="panel danger-zone"><p class="eyebrow">APPLY</p><h2>Move every Ship's contacts</h2>
    <p>Each Ship names the people in its contacts, blocks, message requests and deliveries by DID. Rows naming anyone without a DID here end, and a message request its recipient never received expires. This can't be undone.</p>
    <form class="form-actions" method="post" action="/admin/identity-move/apply">
      ${reasonField()}
      <label><span>Type move to confirm</span><input name="confirm" required autocomplete="off" value=""></label>
      <button class="danger" type="submit">Apply the move</button>
    </form>
  </section>`;
}

function retryingTable(retrying: IdentityMoveStatus["retrying"]): string {
  return `<section class="stack"><p class="eyebrow">RETRYING</p><div class="table-wrap"><table><thead><tr><th>Ship</th><th>Step</th><th>Attempts</th><th>Last error</th><th>Next try</th></tr></thead><tbody>
    ${retrying.map((ship) => `<tr><td><a href="/admin/installations/${encodeURIComponent(ship.installationId)}">${escapeHtml(ship.handle ?? ship.installationId)}</a></td>
      <td>${stateBadge(ship.state)}</td><td>${formatInteger(ship.attempts)}</td><td>${escapeHtml(ship.error)}</td><td>${formatDate(ship.nextAttemptAt)}</td></tr>`).join("")}
  </tbody></table></div></section>`;
}

function counts(value: Record<string, number>): string {
  return Object.entries(value).map(([name, count]) => `${formatInteger(count)} ${escapeHtml(name)}`).join(" · ");
}

function reasonField(): string {
  return `<label><span>Reason (optional, kept in the audit log)</span><input name="reason" maxlength="500" autocomplete="off" value=""></label>`;
}
