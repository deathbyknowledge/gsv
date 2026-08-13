import type {
  AdminInstallation,
  AdminInstallationList,
  AdminInstallationSummary,
  IssuedAdminInstallation,
} from "./service";
import { ADMIN_VISIBLE_INSTALLATION_STATES } from "./service";
import {
  adminPageResponse,
  errorNotice,
  escapeHtml,
  formatDate,
  formatInteger,
  formatNanoUsd,
  formatNanoUsdInput,
  metric,
  onboardingNotice,
  stateBadge,
} from "./page";

export function adminInstallationsPage(
  list: AdminInstallationList,
  error?: string,
  head = false,
  status = 200,
): Response {
  return adminPageResponse({
    title: "Installations",
    section: "installations",
    head,
    status,
    content: `<section class="stack">
      <div class="page-heading">
        <div><p class="eyebrow">MANAGED CONTROL PLANE</p><h1>Installations</h1></div>
        <div class="actions"><span>${formatInteger(list.total)} ${list.total === 1 ? "result" : "results"}</span><a class="button" href="/admin/installations/new">New installation</a></div>
      </div>
      ${error ? errorNotice(error) : ""}
      ${installationFilters(list)}
      ${installationTable(list.installations)}
      ${pagination(list)}
    </section>`,
  });
}

export function adminNewInstallationPage(
  error?: string,
  head = false,
  status = 200,
  values?: { operationId: string; handle: string },
): Response {
  const operationId = values?.operationId ?? `operation_${crypto.randomUUID()}`;
  return adminPageResponse({
    title: "New installation",
    section: "installations",
    head,
    status,
    content: `<section class="narrow stack">
      <div class="page-heading">
        <div><p class="eyebrow">NEW INSTALLATION</p><h1>Reserve a GSV</h1></div>
        <a class="button secondary" href="/admin/installations">Cancel</a>
      </div>
      ${error ? errorNotice(error) : ""}
      <form class="panel stack" method="post" action="/admin/installations">
        <div><h2>Installation identity</h2><p>The handle becomes the installation hostname. The owner chooses their local username and password from the one-time onboarding link.</p></div>
        <input type="hidden" name="operationId" value="${escapeHtml(operationId)}">
        <label><span>Handle</span><input name="handle" required minlength="1" maxlength="63" pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" autocomplete="off" placeholder="hank" value="${escapeHtml(values?.handle ?? "")}"></label>
        <div class="form-actions"><button type="submit">Create installation</button></div>
      </form>
    </section>`,
  });
}

export function adminInstallationPage(
  installation: AdminInstallation,
  issued?: IssuedAdminInstallation,
  error?: string,
  head = false,
  status = 200,
): Response {
  const installationPath = `/admin/installations/${encodeURIComponent(installation.installationId)}`;
  const incomplete = installation.inference.failed
    + installation.inference.aborted
    + installation.inference.abandoned;
  const remaining = Math.max(
    0,
    installation.inference.monthlyLimitNanoUsd
      - installation.inference.costNanoUsd,
  );
  return adminPageResponse({
    title: installation.handle,
    section: "installations",
    head,
    status,
    content: `<section class="stack">
      <div><a href="/admin/installations">← Installations</a></div>
      <div class="page-heading">
        <div><p class="eyebrow">INSTALLATION</p><h1>${escapeHtml(installation.handle)}</h1></div>
        <div class="actions">${stateBadge(installation.state)}<a class="button secondary" href="${escapeHtml(installation.canonicalOrigin)}" target="_blank" rel="noreferrer">Open GSV</a></div>
      </div>
      ${error ? errorNotice(error) : ""}
      ${issued ? onboardingNotice(issued) : ""}
      <section class="metrics" aria-label="Current inference period">
        ${metric("Spend", formatNanoUsd(installation.inference.costNanoUsd))}
        ${metric("Requests", formatInteger(installation.inference.requests))}
        ${metric("Tokens", formatInteger(installation.inference.tokens))}
        ${metric("Incomplete", formatInteger(incomplete))}
      </section>
      <div class="grid">
        <section class="panel"><p class="eyebrow">IDENTITY</p><h2>Installation details</h2>
          <dl class="definition-list">
            <dt>Installation ID</dt><dd>${escapeHtml(installation.installationId)}</dd>
            <dt>Canonical origin</dt><dd><a href="${escapeHtml(installation.canonicalOrigin)}" target="_blank" rel="noreferrer">${escapeHtml(installation.canonicalOrigin)}</a></dd>
            <dt>Lifecycle</dt><dd>${stateBadge(installation.state)}</dd>
            <dt>Provisioning</dt><dd>${stateBadge(installation.operationState)}</dd>
            <dt>Created</dt><dd>${formatDate(installation.createdAt)}</dd>
            <dt>Activated</dt><dd>${formatDate(installation.activatedAt)}</dd>
          </dl>
        </section>
        <section class="panel"><p class="eyebrow">MANAGED INFERENCE</p><h2>Installation policy</h2>
          <p>The platform switch is managed separately under <a href="/admin/inference">Inference</a>.</p>
          <dl class="definition-list">
            <dt>Period</dt><dd>${escapeHtml(installation.inference.period)}</dd>
            <dt>Policy</dt><dd>${stateBadge(installation.inference.enabled ? "enabled" : "disabled")}</dd>
            <dt>Allowance</dt><dd>${formatNanoUsd(installation.inference.monthlyLimitNanoUsd)}</dd>
            <dt>Remaining</dt><dd>${formatNanoUsd(remaining)}</dd>
            <dt>Mail intake</dt><dd>${formatInteger(installation.inference.mailIntake.requests)} requests · ${formatNanoUsd(installation.inference.mailIntake.costNanoUsd)}</dd>
          </dl>
          <form class="form-actions" method="post" action="${installationPath}/inference">
            <label><span>Monthly USD allowance</span><input name="monthlyLimitUsd" required inputmode="decimal" value="${formatNanoUsdInput(installation.inference.monthlyLimitNanoUsd)}"></label>
            <button type="submit" name="enabled" value="true">Save &amp; enable</button>
            <button class="secondary" type="submit" name="enabled" value="false" formnovalidate>Disable</button>
          </form>
        </section>
        ${provisioningPanel(installation, installationPath)}
        ${lifecyclePanel(installation, installationPath)}
      </div>
    </section>`,
  });
}

function installationFilters(list: AdminInstallationList): string {
  return `<form class="panel filters" method="get" action="/admin/installations">
    <label><span>Search handle or installation ID</span><input type="search" name="q" maxlength="100" value="${escapeHtml(list.query)}" placeholder="hank or inst_…"></label>
    <label><span>Lifecycle state</span><select name="state"><option value="">All states</option>${ADMIN_VISIBLE_INSTALLATION_STATES.map((state) => `<option value="${state}"${list.state === state ? " selected" : ""}>${escapeHtml(state.replaceAll("_", " "))}</option>`).join("")}</select></label>
    <button type="submit">Search</button>
    <a class="button secondary" href="/admin/installations">Reset</a>
  </form>`;
}

function installationTable(
  installations: AdminInstallationSummary[],
): string {
  if (installations.length === 0) {
    return `<div class="empty">No installations match this view.</div>`;
  }
  return `<div class="table-wrap"><table><thead><tr><th>Installation</th><th>State</th><th>Inference policy</th><th>Created</th></tr></thead>
    <tbody>${installations.map(installationRow).join("")}</tbody></table></div>`;
}

function installationRow(installation: AdminInstallationSummary): string {
  const href = `/admin/installations/${encodeURIComponent(installation.installationId)}`;
  return `<tr>
    <td><strong><a href="${href}">${escapeHtml(installation.handle)}</a></strong><small>${escapeHtml(installation.installationId)}</small></td>
    <td>${stateBadge(installation.state)}<small>provisioning: ${escapeHtml(installation.operationState)}</small></td>
    <td>${stateBadge(installation.inferenceEnabled ? "enabled" : "disabled")}</td>
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
  return `<nav class="pagination" aria-label="Installation pages"><span>Page ${formatInteger(list.page)} of ${formatInteger(list.totalPages)}</span><div>${previous}${next}</div></nav>`;
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
  return `<section class="panel"><p class="eyebrow">PROVISIONING</p><h2>Onboarding</h2>
    <dl class="definition-list">
      <dt>Operation</dt><dd>${stateBadge(installation.operationState)}</dd>
      <dt>Link expiry</dt><dd>${formatDate(installation.onboardingExpiresAt)}</dd>
    </dl>
    ${canReissue ? `<p>Reissuing invalidates any current link and shows its replacement once.</p><form class="form-actions" method="post" action="${installationPath}/onboarding"><button class="secondary" type="submit">Reissue onboarding link</button></form>` : "<p>Onboarding is complete; no active provisioning capability is needed.</p>"}
  </section>`;
}

function lifecyclePanel(
  installation: AdminInstallation,
  installationPath: string,
): string {
  if (installation.state === "active") {
    return `<section class="panel danger-zone"><p class="eyebrow">LIFECYCLE</p><h2>Suspend installation</h2><p>Suspension retains the installation identity and data while blocking managed work until reactivation.</p><form class="form-actions" method="post" action="${installationPath}/lifecycle"><button class="danger" type="submit" name="state" value="restricted">Suspend ${escapeHtml(installation.handle)}</button></form></section>`;
  }
  if (installation.state === "restricted") {
    return `<section class="panel"><p class="eyebrow">LIFECYCLE</p><h2>Reactivate installation</h2><p>Reactivation restores managed routing and resumes paused durable work.</p><form class="form-actions" method="post" action="${installationPath}/lifecycle"><button type="submit" name="state" value="active">Reactivate ${escapeHtml(installation.handle)}</button></form></section>`;
  }
  return `<section class="panel"><p class="eyebrow">LIFECYCLE</p><h2>No operator transition</h2><p>Lifecycle controls are unavailable while this installation is ${escapeHtml(installation.state.replaceAll("_", " "))}.</p></section>`;
}
