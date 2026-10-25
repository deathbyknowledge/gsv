import type {
  AdminInstallation,
  AdminInstallationList,
  AdminInstallationSummary,
} from "../administration";
import { ADMIN_VISIBLE_INSTALLATION_STATES } from "../administration";
import { RESET_CONSEQUENCES, type IssuedAdminInstallation } from "./service";
import type { AdminNavigationItem } from "./page";
import type { OperatorRun, OperatorShipSnapshot } from "@humansandmachines/gsv/services/operator";
import type { OperatorAuditEvent, ShipContext, ShipHealth } from "./insight";
import { takedownSubjectKey, takedownSubjectKind, type ShipOpenNetwork, type TakedownSubjectKind } from "./takedowns";
import {
  adminPageResponse,
  auditTable,
  errorNotice,
  escapeHtml,
  formatDate,
  formatDuration,
  formatInteger,
  formatTime,
  onboardingNotice,
  stateBadge,
} from "./page";

/** What the Ship page shows beyond the installation record; absent when no insight is configured. */
export type ShipView = { context: ShipContext; health: ShipHealth; openNetwork?: ShipOpenNetwork };

const SLOW_STEP_MS = 60_000;

/** Slot HTML is trusted operator presentation; its renderer owns escaping all inserted data. */
export type InstallationAdminPresentation<
  Detail extends AdminInstallation = AdminInstallation,
  Summary extends AdminInstallationSummary = AdminInstallationSummary,
> = {
  navigation?: readonly AdminNavigationItem[];
  summaryColumn?: { label: string; render: (installation: Summary) => string };
  overview?: (installation: Detail) => string;
  panel?: (installation: Detail) => string;
};

export function adminInstallationsPage<Summary extends AdminInstallationSummary>(
  list: Omit<AdminInstallationList, "installations"> & { installations: Summary[] },
  error?: string,
  head = false,
  status = 200,
  presentation: Pick<InstallationAdminPresentation<AdminInstallation, Summary>, "navigation" | "summaryColumn"> = {},
): Response {
  return adminPageResponse({
    title: "Ships",
    section: "installations",
    navigation: presentation.navigation,
    head,
    status,
    content: `<section class="stack">
      <div class="page-heading">
        <div><p class="eyebrow">OPERATOR</p><h1>Ships</h1></div>
        <div class="actions"><span>${formatInteger(list.total)} ${list.total === 1 ? "result" : "results"}</span><a class="button secondary" href="/admin/installations/new">Create a Ship manually</a></div>
      </div>
      ${error ? errorNotice(error) : ""}
      ${installationFilters(list)}
      ${installationTable(list.installations, presentation.summaryColumn)}
      ${pagination(list)}
    </section>`,
  });
}

export function adminNewInstallationPage(
  error?: string,
  head = false,
  status = 200,
  values?: { operationId: string; handle: string },
  navigation: readonly AdminNavigationItem[] = [],
): Response {
  const operationId = values?.operationId ?? `operation_${crypto.randomUUID()}`;
  return adminPageResponse({
    title: "New Ship",
    section: "installations",
    navigation,
    head,
    status,
    content: `<section class="narrow stack">
      <div class="page-heading">
        <div><p class="eyebrow">NEW SHIP</p><h1>Create a Ship</h1></div>
        <a class="button secondary" href="/admin/installations">Cancel</a>
      </div>
      ${error ? errorNotice(error) : ""}
      <form class="panel stack" method="post" action="/admin/installations">
        <div><h2>Ship identity</h2><p>The handle becomes the Ship’s address. The owner sets a password using the one-time activation link.</p></div>
        <input type="hidden" name="operationId" value="${escapeHtml(operationId)}">
        <label><span>Handle</span><input name="handle" required minlength="1" maxlength="63" pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" autocomplete="off" placeholder="hank" value="${escapeHtml(values?.handle ?? "")}"></label>
        <div class="form-actions"><button type="submit">Create Ship</button></div>
      </form>
    </section>`,
  });
}

export function adminInstallationPage<Detail extends AdminInstallation>(
  installation: Detail,
  issued?: IssuedAdminInstallation,
  error?: string,
  head = false,
  status = 200,
  presentation: Pick<InstallationAdminPresentation<Detail>, "navigation" | "overview" | "panel"> = {},
  ship?: ShipView,
): Response {
  const installationPath = `/admin/installations/${encodeURIComponent(installation.installationId)}`;
  const host = hostOf(installation.canonicalOrigin);
  const aliases = ship?.context.hostnames.filter((entry) => entry.kind === "alias").map((entry) => entry.hostname) ?? [];
  const subtitle = [ship?.context.mailAddress, host, ...aliases.map((alias) => `+ ${alias}`)].filter((part): part is string => Boolean(part));
  return adminPageResponse({
    title: installation.handle,
    section: "installations",
    navigation: presentation.navigation,
    head,
    status,
    content: `<section class="stack">
      <div><a href="/admin/installations">← Ships</a></div>
      <div class="page-heading">
        <div><p class="eyebrow">SHIP</p><h1>${escapeHtml(installation.handle)}</h1><p class="subtitle">${subtitle.map(escapeHtml).join(" · ")}</p></div>
        <div class="actions">${stateBadge(installation.state)}<a class="button secondary" href="${escapeHtml(installation.canonicalOrigin)}" target="_blank" rel="noreferrer">Open Ship</a></div>
      </div>
      ${error ? errorNotice(error) : ""}
      ${issued ? onboardingNotice(issued) : ""}
      ${presentation.overview?.(installation) ?? ""}
      <div class="grid">
        ${identityPanel(installation, ship?.context)}
        ${ship ? healthPanel(ship.health) : ""}
      </div>
      ${ship?.health.kind === "ok" ? timelinePanel(ship.health.snapshot) : ""}
      <div class="grid">
        ${presentation.panel?.(installation) ?? ""}
        ${ship ? recentActionsPanel(ship.context.audit) : ""}
      </div>
      <div><p class="eyebrow">ACTIONS</p></div>
      <div class="grid">
        ${provisioningPanel(installation, installationPath)}
        ${lifecyclePanel(installation, installationPath)}
        ${resetPanel(installation, installationPath)}
        ${ship?.openNetwork ? takedownPanel(ship.openNetwork, installationPath) : ""}
      </div>
    </section>`,
  });
}

function identityPanel(installation: AdminInstallation, context?: ShipContext): string {
  const owner = context
    ? context.owner.operatorIssued
      ? "Not linked (issued by an operator)"
      : `${context.owner.email
        ? `<a class="select-all" href="mailto:${escapeHtml(context.owner.email)}">${escapeHtml(context.owner.email)}</a>`
        : "Unknown"}${context.owner.signIn.length ? ` <small>${context.owner.signIn.map(escapeHtml).join(", ")}</small>` : ""}`
    : "";
  return `<section class="panel"><p class="eyebrow">IDENTITY</p><h2>Ship details</h2>
    <dl class="definition-list">
      <dt>Ship ID</dt><dd>${escapeHtml(installation.installationId)}</dd>
      ${context ? `<dt>Owner</dt><dd>${owner}</dd>` : ""}
      ${context ? `<dt>Hostnames</dt><dd>${context.hostnames.map((entry) => `${escapeHtml(entry.hostname)} <small>${escapeHtml(entry.kind)}${entry.state === "active" ? "" : ` · ${escapeHtml(entry.state)}`}</small>`).join("<br>") || "None"}</dd>` : `<dt>Address</dt><dd><a href="${escapeHtml(installation.canonicalOrigin)}" target="_blank" rel="noreferrer">${escapeHtml(installation.canonicalOrigin)}</a></dd>`}
      <dt>Lifecycle</dt><dd>${stateBadge(installation.state)}</dd>
      <dt>Provisioning</dt><dd>${stateBadge(installation.operationState)}</dd>
      <dt>Created</dt><dd>${formatDate(installation.createdAt)}</dd>
      <dt>Activated</dt><dd>${formatDate(installation.activatedAt)}</dd>
      ${installation.reset ? `<dt>Reset from</dt><dd>${escapeHtml(installation.reset.previousInstallationId)}</dd><dt>Old data deletion</dt><dd>${stateBadge(installation.reset.dataDeletionState)}</dd>` : ""}
    </dl>
  </section>`;
}

function healthPanel(health: ShipHealth): string {
  if (health.kind === "unavailable") {
    return `<section class="panel"><p class="eyebrow">HEALTH</p><h2>Health unavailable</h2>
      <p>The Ship's health could not be read: <strong>${escapeHtml(health.reason)}</strong>. Everything else on this page comes from Accounts.</p>
    </section>`;
  }
  const { snapshot } = health;
  const ship = snapshot.ship;
  return `<section class="panel"><p class="eyebrow">HEALTH · ${formatTime(snapshot.capturedAt)}</p><h2>${ship ? `Ship ${escapeHtml(ship.state)}` : "No Ship process"}</h2>
    <dl class="definition-list">
      ${ship ? `<dt>Last active</dt><dd>${formatDate(ship.lastActiveAt)}</dd>
      <dt>Working on</dt><dd>${ship.activeRunId ? escapeHtml(ship.activeRunId) : "Nothing"}</dd>
      <dt>Queue · approvals</dt><dd>${formatInteger(ship.queuedCount)} queued · ${ship.pendingApprovals === null ? "approvals unavailable" : `${formatInteger(ship.pendingApprovals)} waiting for approval`}</dd>
      <dt>Last compaction</dt><dd>${snapshot.runs === null ? "Unavailable" : formatDate(ship.lastCompactionAt)}</dd>` : ""}
      <dt>Open work</dt><dd>${formatInteger(snapshot.openResponsibilities)} open responsibilities</dd>
      <dt>Ship events</dt><dd>${formatInteger(snapshot.shipEvents.queued)} queued${snapshot.shipEvents.oldestQueuedAt === null ? "" : ` · oldest ${formatDate(snapshot.shipEvents.oldestQueuedAt)}`}</dd>
      <dt>Processes</dt><dd>${formatInteger(snapshot.processes.total)} · ${formatInteger(snapshot.processes.running)} running</dd>
      <dt>Messengers</dt><dd>${snapshot.messengers.map((entry) => `${escapeHtml(entry.adapter)}${entry.linkedAt === null ? "" : ` <small>linked ${formatDate(entry.linkedAt)}</small>`}`).join("<br>") || "None linked"}</dd>
      <dt>Devices</dt><dd>${snapshot.targets.map((target) => `${escapeHtml(target.id)} ${stateBadge(target.online ? "online" : "offline")}${target.online || target.lastSeenAt === null ? "" : ` <small>seen ${formatDate(target.lastSeenAt)}</small>`}`).join("<br>") || "None"}</dd>
    </dl>
  </section>`;
}

function timelinePanel(snapshot: OperatorShipSnapshot): string {
  if (snapshot.runs === null) {
    return `<section class="panel"><p class="eyebrow">TIMELINE</p><h2>Run history unavailable</h2>
      <p>The Ship's own process could not be read; its health above still comes from the Ship.</p></section>`;
  }
  if (snapshot.runs.length === 0) {
    return `<section class="panel"><p class="eyebrow">TIMELINE</p><h2>No recent runs</h2></section>`;
  }
  return `<section class="panel"><p class="eyebrow">TIMELINE · METADATA ONLY</p><h2>Recent runs</h2>
    <div class="table-wrap"><table class="timeline"><thead><tr><th>Started</th><th>From</th><th>Input</th><th>Took</th><th>Outcome</th><th>Steps</th></tr></thead>
    <tbody>${snapshot.runs.map(timelineRow).join("")}</tbody></table></div>
  </section>`;
}

function timelineRow(run: OperatorRun): string {
  const slow = run.steps.filter((step) => (step.durationMs ?? 0) > SLOW_STEP_MS).length;
  const failed = run.steps.filter((step) => step.status === "error").length;
  const flags = [slow ? `${slow} slow` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
  const input = [run.inputChars === null ? "" : `${formatInteger(run.inputChars)} chars`, run.inputHasMedia ? "media" : ""]
    .filter(Boolean).join(" + ") || "—";
  return `<tr>
    <td>${formatTime(run.startedAt)}</td>
    <td>${escapeHtml(run.origin)}</td>
    <td>${escapeHtml(input)}</td>
    <td>${run.durationMs === null ? "running" : escapeHtml(formatDuration(run.durationMs))}</td>
    <td>${stateBadge(run.status)}</td>
    <td>${run.steps.length === 0 ? "—" : `<details><summary>${formatInteger(run.steps.length)} steps${flags ? ` · <span class="flag">${escapeHtml(flags)}</span>` : ""}</summary><ol class="steps">${run.steps.map((step) => {
      const slowStep = (step.durationMs ?? 0) > SLOW_STEP_MS;
      const classes = [step.status === "error" ? "step-error" : "", slowStep ? "step-slow" : ""].filter(Boolean).join(" ");
      return `<li${classes ? ` class="${classes}"` : ""}><span>+${escapeHtml(formatDuration(Math.max(0, step.startedAt - run.startedAt)))}</span> ${escapeHtml(step.kind)} <strong>${escapeHtml(step.name)}</strong>${step.target ? ` on ${escapeHtml(step.target)}` : ""} · ${step.durationMs === null ? "running" : escapeHtml(formatDuration(step.durationMs))} · ${escapeHtml(step.status)}${slowStep ? " · slow" : ""}</li>`;
    }).join("")}</ol></details>`}</td>
  </tr>`;
}

function recentActionsPanel(events: OperatorAuditEvent[]): string {
  return `<section class="panel"><p class="eyebrow">OPERATOR ACTIONS</p><h2>Recent actions</h2>
    ${events.length ? auditTable(events, false) : "<p>No operator has changed this Ship.</p>"}
    <p><a href="/admin/audit">Full audit log →</a></p>
  </section>`;
}

function hostOf(origin: string): string {
  try { return new URL(origin).host; }
  catch { return origin; }
}

function installationFilters(list: AdminInstallationList): string {
  return `<form class="panel filters" method="get" action="/admin/installations">
    <label><span>Search handle or Ship ID</span><input type="search" name="q" maxlength="100" value="${escapeHtml(list.query)}" placeholder="hank or inst_…"></label>
    <label><span>Lifecycle state</span><select name="state"><option value="">All states</option>${ADMIN_VISIBLE_INSTALLATION_STATES.map((state) => `<option value="${state}"${list.state === state ? " selected" : ""}>${escapeHtml(state.replaceAll("_", " "))}</option>`).join("")}</select></label>
    <button type="submit">Search</button>
    <a class="button secondary" href="/admin/installations">Reset</a>
  </form>`;
}

function installationTable<Summary extends AdminInstallationSummary>(
  installations: Summary[],
  column?: InstallationAdminPresentation<AdminInstallation, Summary>["summaryColumn"],
): string {
  if (installations.length === 0) {
    return `<div class="empty">No Ships match this view.</div>`;
  }
  return `<div class="table-wrap"><table><thead><tr><th>Ship</th><th>State</th>${column ? `<th>${escapeHtml(column.label)}</th>` : ""}<th>Created</th></tr></thead>
    <tbody>${installations.map((installation) => installationRow(installation, column)).join("")}</tbody></table></div>`;
}

function installationRow<Summary extends AdminInstallationSummary>(
  installation: Summary,
  column?: InstallationAdminPresentation<AdminInstallation, Summary>["summaryColumn"],
): string {
  const href = `/admin/installations/${encodeURIComponent(installation.installationId)}`;
  return `<tr>
    <td><strong><a href="${href}">${escapeHtml(installation.handle)}</a></strong><small>${escapeHtml(installation.installationId)}</small></td>
    <td>${stateBadge(installation.state)}<small>provisioning: ${escapeHtml(installation.operationState)}</small></td>
    ${column ? `<td>${column.render(installation)}</td>` : ""}
    <td>${formatDate(installation.createdAt)}</td>
  </tr>`;
}

function pagination(list: AdminInstallationList): string {
  if (list.totalPages <= 1 && list.page === 1) return "";
  const previous = list.page > 1
    ? `<a class="button secondary" href="${escapeHtml(registryHref(list, list.page - 1))}">Previous</a>`
    : "";
  const next = list.page < list.totalPages
    ? `<a class="button secondary" href="${escapeHtml(registryHref(list, list.page + 1))}">Next</a>`
    : "";
  return `<nav class="pagination" aria-label="Ship pages"><span>Page ${formatInteger(list.page)} of ${formatInteger(list.totalPages)}</span><div>${previous}${next}</div></nav>`;
}

function registryHref(list: AdminInstallationList, page: number): string {
  const params = new URLSearchParams();
  if (list.query) params.set("q", list.query);
  if (list.state) params.set("state", list.state);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/admin/installations${query ? `?${query}` : ""}`;
}

function provisioningPanel(
  installation: AdminInstallation,
  installationPath: string,
): string {
  const canReissue = installation.state === "reserved"
    || installation.state === "provisioning";
  return `<section class="panel"><p class="eyebrow">PROVISIONING</p><h2>Activation</h2>
    <dl class="definition-list">
      <dt>Operation</dt><dd>${stateBadge(installation.operationState)}</dd>
      <dt>Link expiry</dt><dd>${formatDate(installation.onboardingExpiresAt)}</dd>
    </dl>
    ${canReissue ? `<p>Reissuing invalidates any current link and shows its replacement once.</p><form class="form-actions" method="post" action="${installationPath}/onboarding"><button class="secondary" type="submit">Reissue activation link</button></form>` : "<p>Activation is complete; no active provisioning capability is needed.</p>"}
  </section>`;
}

function lifecyclePanel(
  installation: AdminInstallation,
  installationPath: string,
): string {
  if (installation.state === "active") {
    return `<section class="panel danger-zone"><p class="eyebrow">LIFECYCLE</p><h2>Suspend Ship</h2><p>Suspension retains the Ship ID and data while blocking work until reactivation.</p><form class="form-actions" method="post" action="${installationPath}/lifecycle">${reasonField()}<button class="danger" type="submit" name="state" value="restricted">Suspend ${escapeHtml(installation.handle)}</button></form></section>`;
  }
  if (installation.state === "restricted") {
    return `<section class="panel"><p class="eyebrow">LIFECYCLE</p><h2>Reactivate Ship</h2><p>Reactivation restores routing and resumes paused durable work.</p><form class="form-actions" method="post" action="${installationPath}/lifecycle">${reasonField()}<button type="submit" name="state" value="active">Reactivate ${escapeHtml(installation.handle)}</button></form></section>`;
  }
  return `<section class="panel"><p class="eyebrow">LIFECYCLE</p><h2>No operator transition</h2><p>Lifecycle controls are unavailable while this Ship is ${escapeHtml(installation.state.replaceAll("_", " "))}.</p></section>`;
}

function resetPanel(
  installation: AdminInstallation,
  installationPath: string,
): string {
  if (installation.state !== "active" && installation.state !== "restricted") {
    return "";
  }
  const operationId = `reset_${crypto.randomUUID()}`;
  return `<section class="panel danger-zone"><p class="eyebrow">FRESH SHIP</p><h2>Reset ${escapeHtml(installation.handle)}</h2>
    <p><strong>If the person only lost access, don't reset.</strong> Recovery keeps their Ship, contacts and DID: they sign in to My Ships with the owner email under Ship details and choose Recover your Ship, which resets the administrator password.</p>
    <p>Before you confirm, this is what a reset does:</p>
    <ul class="consequences">${RESET_CONSEQUENCES.map((consequence) => `<li>${escapeHtml(consequence)}</li>`).join("")}</ul>
    <form class="form-actions" method="post" action="${installationPath}/reset">
      <input type="hidden" name="operationId" value="${escapeHtml(operationId)}">
      ${reasonField(true)}
      <label><span>Type ${escapeHtml(installation.handle)} to confirm</span><input name="confirmHandle" required autocomplete="off" value=""></label>
      <button class="danger" type="submit">Reset and issue activation link</button>
    </form>
  </section>`;
}

const SUBJECT_LABELS = { account: "Whole account", record: "Record", blob: "File" } satisfies Record<TakedownSubjectKind, string>;

/** What the Ship publishes on the open network that its host has taken down, and the form that takes more down. */
function takedownPanel(network: ShipOpenNetwork, installationPath: string): string {
  const heading = `<p class="eyebrow">OPEN NETWORK</p><h2>Takedowns</h2>`;
  if (network.kind === "unavailable") {
    return `<section class="panel" id="takedowns">${heading}<p>The Ship's open-network host could not be read: <strong>${escapeHtml(network.reason)}</strong>.</p></section>`;
  }
  if (network.kind === "none") {
    return `<section class="panel" id="takedowns">${heading}<p>This Ship has no repository on the open network yet; it gets one with its first published profile or Ship-to-Ship call.</p></section>`;
  }
  const { did, handle, takedowns } = network.repository;
  const rows = takedowns.map(({ subject, reason, at, ref }) => `<tr>
      <td><strong>${SUBJECT_LABELS[takedownSubjectKind(subject)]}</strong><small class="select-all">${escapeHtml(takedownSubjectKey(subject))}</small></td>
      <td>${reason ? escapeHtml(reason) : "—"}</td>
      <td>${formatDate(at)}<small>${escapeHtml(ref)}</small></td>
      <td><form method="post" action="${installationPath}/takedowns/restore"><input type="hidden" name="subject" value="${escapeHtml(takedownSubjectKey(subject))}">
        ${reasonField()}
        <div class="form-actions"><button class="secondary" type="submit">Restore</button></div></form></td>
    </tr>`).join("");
  return `<section class="panel danger-zone" id="takedowns">${heading}
    <p>Readers on the open network stop seeing what you take down. While its account is down, the Ship can't publish or call other Ships. Its person sees each takedown in People, with your reason.</p>
    <dl class="definition-list"><dt>DID</dt><dd class="select-all">${escapeHtml(did)}</dd><dt>Handle</dt><dd>${escapeHtml(handle)}</dd></dl>
    ${takedowns.length
      ? `<div class="table-wrap"><table class="audit"><thead><tr><th>Taken down</th><th>Reason</th><th>Since</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : "<p>Nothing is taken down.</p>"}
    <form class="stack" method="post" action="${installationPath}/takedowns">
      <label><span>Take down</span><select name="subject">${Object.entries(SUBJECT_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
      <label><span>Record AT URI, for a record</span><input name="uri" maxlength="2048" autocomplete="off" placeholder="at://${escapeHtml(did)}/space.ship.profile/self" value=""></label>
      <label><span>File CID, for a file</span><input name="cid" maxlength="128" autocomplete="off" placeholder="bafkrei…" value=""></label>
      <label><span>Reason (required; the Ship's person reads it)</span><input name="reason" required maxlength="500" autocomplete="off" value=""></label>
      <div class="form-actions"><button class="danger" type="submit">Take down</button></div>
    </form>
  </section>`;
}

function reasonField(required = false): string {
  return `<label><span>Reason (${required ? "required" : "optional"}, kept in the audit log)</span><input name="reason"${required ? " required" : ""} maxlength="500" autocomplete="off" value=""></label>`;
}
