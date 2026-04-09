const COMMIT_PAGE_SIZE = 30;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildUrl(routeBase, params) {
  const url = new URL(routeBase, "https://gsv.local");
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function normalizePath(path) {
  return String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeCatalogSelection(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "local";
}

function clampOffset(raw) {
  const parsed = Number.parseInt(String(raw ?? "0"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function shortHash(hash) {
  return String(hash ?? "").slice(0, 7);
}

function firstLine(message) {
  return String(message ?? "").split("\n")[0] || "No commit message";
}

function formatTimestamp(unixSeconds) {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) {
    return "unknown";
  }
  return new Date(unixSeconds * 1000).toLocaleString();
}

function formatReviewTime(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "unknown";
  }
  return new Date(timestamp).toLocaleString();
}

function parseImportSource(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { remoteUrl: "", repo: "" };
  }
  if (trimmed.includes("://") || trimmed.startsWith("git@")) {
    return { remoteUrl: trimmed, repo: "" };
  }
  return { remoteUrl: "", repo: trimmed.replace(/^\/+|\/+$/g, "") };
}

function isThirdPartyPackage(pkg) {
  const repo = String(pkg?.source?.repo ?? "").trim();
  return repo !== "" && repo !== "system/gsv";
}

function needsReviewApproval(pkg) {
  return Boolean(pkg?.review?.required) && !pkg?.review?.approvedAt;
}

function scopeLabel(scope) {
  switch (scope?.kind) {
    case "user":
      return "Mine";
    case "workspace":
      return `Workspace:${scope.workspaceId ?? "?"}`;
    default:
      return "System";
  }
}

function scopeBadgeClass(scope) {
  switch (scope?.kind) {
    case "user":
      return "is-mine";
    case "workspace":
      return "is-workspace";
    default:
      return "is-system";
  }
}

function packageStateLabel(pkg) {
  if (pkg?.enabled) return "Enabled";
  if (needsReviewApproval(pkg)) return "Review required";
  if (pkg?.review?.approvedAt) return "Reviewed";
  return "Disabled";
}

function packageStateClass(pkg) {
  if (pkg?.enabled) return "is-enabled";
  if (needsReviewApproval(pkg)) return "is-review";
  if (pkg?.review?.approvedAt) return "is-reviewed";
  return "is-disabled";
}

function buildReviewPrompt(pkg) {
  const name = String(pkg?.name ?? "unknown-package").trim();
  const repo = String(pkg?.source?.repo ?? "unknown").trim();
  const ref = String(pkg?.source?.ref ?? "main").trim();
  const subdir = String(pkg?.source?.subdir ?? ".").trim();
  const bindings = Array.isArray(pkg?.bindingNames) && pkg.bindingNames.length > 0
    ? pkg.bindingNames.join(", ")
    : "none declared";
  const entrypoints = Array.isArray(pkg?.entrypoints) && pkg.entrypoints.length > 0
    ? pkg.entrypoints.map((entry) => `${entry.name}:${entry.kind}`).join(", ")
    : "none";

  return [
    `Review the imported package "${name}".`,
    "",
    "Current directory is already /src/package.",
    "The package source is mounted read-only at /src/package.",
    "The full repository is mounted read-only at /src/repo.",
    "",
    `Source repo: ${repo}`,
    `Source ref: ${ref}`,
    `Subdir: ${subdir}`,
    `Declared bindings: ${bindings}`,
    `Entrypoints: ${entrypoints}`,
    "",
    "Review workflow:",
    "1. Start with pkg manifest, pkg capabilities, pkg refs, and pkg log.",
    "2. Inspect /src/package, prioritizing manifest, entrypoints, and system integration points.",
    "3. Search for network access, parent-window messaging, host bridge use, process spawning, filesystem writes, shell execution, eval, and destructive actions.",
    "4. If a command fails, note it briefly and continue with other evidence. Do not guess.",
    "5. Keep tool use tight. Do not narrate trivial navigation or run placeholder commands.",
    "",
    "Use normal filesystem and shell exploration plus the pkg CLI.",
    "Helpful commands: ls, find, grep, cat, pkg manifest, pkg capabilities, pkg refs, pkg log.",
    "Focus on requested capabilities, suspicious behavior, hidden network or shell access, destructive actions, and whether it should be enabled.",
    "Call out privileged integrations explicitly, including host bridge access, parent-window messaging, and process spawning if present.",
    "Conclude with a short verdict: approve or do not approve, followed by a concise evidence-based summary.",
  ].join("\n");
}

function catalogImportSource(catalog, entry) {
  if (catalog?.source?.kind === "remote" && catalog?.source?.baseUrl) {
    const [owner, repo] = String(entry?.source?.repo ?? "").split("/");
    if (owner && repo) {
      return `${String(catalog.source.baseUrl).replace(/\/+$/, "")}/git/${owner}/${repo}.git`;
    }
  }
  return String(entry?.source?.repo ?? "");
}

function packageMatchesScope(pkg, scopeFilter) {
  if (scopeFilter === "mine") return pkg?.scope?.kind === "user";
  if (scopeFilter === "system") return pkg?.scope?.kind === "global";
  return true;
}

function pickSelectedPackage(packages, selectedPackageId) {
  if (!Array.isArray(packages) || packages.length === 0) return null;
  if (selectedPackageId) {
    const exact = packages.find((pkg) => pkg.packageId === selectedPackageId);
    if (exact) return exact;
  }
  return packages[0] ?? null;
}

function collectRepos(packages) {
  const byRepo = new Map();
  for (const pkg of Array.isArray(packages) ? packages : []) {
    const repo = String(pkg?.source?.repo ?? "").trim();
    if (!repo) continue;
    const existing = byRepo.get(repo) ?? {
      repo,
      public: Boolean(pkg?.source?.public),
      packages: [],
    };
    existing.public = existing.public || Boolean(pkg?.source?.public);
    existing.packages.push(pkg);
    byRepo.set(repo, existing);
  }
  const repos = [...byRepo.values()].map((entry) => ({
    ...entry,
    primary: entry.packages[0],
  }));
  repos.sort((left, right) => left.repo.localeCompare(right.repo));
  return repos;
}

function pickSelectedRepo(repos, repoSlug, fallbackPackage) {
  if (!Array.isArray(repos) || repos.length === 0) return null;
  if (repoSlug) {
    const exact = repos.find((repo) => repo.repo === repoSlug);
    if (exact) return exact;
  }
  if (fallbackPackage?.source?.repo) {
    const matched = repos.find((repo) => repo.repo === fallbackPackage.source.repo);
    if (matched) return matched;
  }
  return repos[0] ?? null;
}

function screenHref(routeBase, screen, extras = {}) {
  return buildUrl(routeBase, {
    screen,
    ...extras,
  });
}

function repoHref(routeBase, repo, repoView, extras = {}) {
  return buildUrl(routeBase, {
    screen: "repos",
    repo,
    repoView,
    ...extras,
  });
}

function packageHref(routeBase, screen, packageId, extras = {}) {
  return buildUrl(routeBase, {
    screen,
    packageId,
    ...extras,
  });
}

function renderAppNav(routeBase, screen, reviewCount) {
  const items = [
    ["installed", "Installed", null],
    ["review", "Review", reviewCount > 0 ? String(reviewCount) : null],
    ["discover", "Discover", null],
    ["repos", "Repos", null],
  ];
  return items.map(([id, label, badge]) => `
    <a class="packages-app-nav-item ${screen === id ? "is-selected" : ""}" href="${escapeHtml(screenHref(routeBase, id))}">
      <span>${escapeHtml(label)}</span>
      ${badge ? `<span class="packages-app-nav-badge">${escapeHtml(badge)}</span>` : ""}
    </a>`).join("");
}

function renderScopeFilters(routeBase, screen, scopeFilter, packageId) {
  const filters = [
    ["all", "All"],
    ["mine", "Mine"],
    ["system", "System"],
  ];
  return `
    <nav class="packages-subfilters">
      ${filters.map(([value, label]) => `<a class="${scopeFilter === value ? "is-active" : ""}" href="${escapeHtml(buildUrl(routeBase, { screen, scope: value, packageId }))}">${escapeHtml(label)}</a>`).join("")}
    </nav>`;
}

function renderPackageListPane(routeBase, screen, packages, selectedPackageId, scopeFilter) {
  const filtered = packages.filter((pkg) => packageMatchesScope(pkg, scopeFilter));
  return `
    <section class="packages-list-pane">
      <header class="packages-pane-header">
        <div>
          <strong>${screen === "review" ? "Pending review" : "Packages"}</strong>
          <span>${filtered.length} visible</span>
        </div>
        ${screen === "installed" ? renderScopeFilters(routeBase, screen, scopeFilter, selectedPackageId) : ""}
      </header>
      <div class="packages-list-scroll">
        ${filtered.length === 0
          ? '<div class="packages-empty">No packages in this view.</div>'
          : filtered.map((pkg) => `
            <a class="packages-list-item ${pkg.packageId === selectedPackageId ? "is-selected" : ""}" href="${escapeHtml(packageHref(routeBase, screen, pkg.packageId, { scope: scopeFilter }))}">
              <div class="packages-list-copy">
                <strong>${escapeHtml(pkg.name)}</strong>
                <span>${escapeHtml(pkg.source?.repo ?? "unknown")}</span>
              </div>
              <div class="packages-list-meta">
                <span class="packages-badge ${scopeBadgeClass(pkg.scope)}">${escapeHtml(scopeLabel(pkg.scope))}</span>
                <span class="packages-badge ${packageStateClass(pkg)}">${escapeHtml(packageStateLabel(pkg))}</span>
              </div>
            </a>`).join("")}
      </div>
    </section>`;
}

function renderRepoListPane(routeBase, repos, selectedRepo, repoView) {
  return `
    <section class="packages-list-pane">
      <header class="packages-pane-header">
        <div>
          <strong>Repositories</strong>
          <span>${repos.length} available</span>
        </div>
      </header>
      <div class="packages-list-scroll">
        ${repos.length === 0
          ? '<div class="packages-empty">No imported repositories yet.</div>'
          : repos.map((repo) => `
            <a class="packages-list-item ${selectedRepo?.repo === repo.repo ? "is-selected" : ""}" href="${escapeHtml(repoHref(routeBase, repo.repo, repoView || "files"))}">
              <div class="packages-list-copy">
                <strong>${escapeHtml(repo.repo)}</strong>
                <span>${escapeHtml(`${repo.packages.length} package${repo.packages.length === 1 ? "" : "s"}`)}</span>
              </div>
              <div class="packages-list-meta">
                <span class="packages-badge ${repo.public ? "is-public" : "is-private"}">${repo.public ? "Public" : "Private"}</span>
              </div>
            </a>`).join("")}
      </div>
    </section>`;
}

function renderDiscoverListPane(routeBase, catalog, importSource, importRef, importSubdir, catalogName) {
  const entries = Array.isArray(catalog?.packages) ? catalog.packages : [];
  return `
    <section class="packages-list-pane">
      <header class="packages-pane-header">
        <div>
          <strong>Catalog</strong>
          <span>${entries.length} public package${entries.length === 1 ? "" : "s"}</span>
        </div>
      </header>
      <div class="packages-list-scroll">
        ${entries.length === 0
          ? '<div class="packages-empty">No public packages exposed here yet.</div>'
          : entries.map((entry) => `
            <a class="packages-list-item" href="${escapeHtml(buildUrl(routeBase, {
              screen: "discover",
              catalog: catalogName,
              source: catalogImportSource(catalog, entry),
              ref: entry?.source?.ref ?? importRef ?? "main",
              subdir: entry?.source?.subdir ?? importSubdir ?? ".",
            }))}">
              <div class="packages-list-copy">
                <strong>${escapeHtml(entry.name)}</strong>
                <span>${escapeHtml(entry.description || entry.source?.repo || "No description")}</span>
              </div>
              <div class="packages-list-meta">
                <span class="packages-badge is-catalog">${escapeHtml(entry.source?.ref ?? "main")}</span>
              </div>
            </a>`).join("")}
      </div>
    </section>`;
}

function renderActionButton(action, payload, label, title, kind = "") {
  return `
    <form method="post">
      <input type="hidden" name="action" value="${escapeHtml(action)}" />
      ${Object.entries(payload).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`).join("")}
      <button type="submit" class="packages-tool-btn ${kind}" title="${escapeHtml(title || label)}">${escapeHtml(label)}</button>
    </form>`;
}

function renderPackageStage(routeBase, screen, pkg, refs, browseRef, scopeFilter) {
  if (!pkg) {
    return '<section class="packages-stage"><div class="packages-empty">Select a package.</div></section>';
  }

  const branches = Object.keys(refs?.heads ?? {}).sort();
  const currentRef = browseRef || pkg.source?.ref || "main";
  const reviewPending = needsReviewApproval(pkg);
  const reviewed = Boolean(pkg?.review?.approvedAt);
  const actions = [
    renderActionButton("review", { packageId: pkg.packageId }, "Review", "Open reviewer"),
    reviewPending
      ? renderActionButton("review-approve", { packageId: pkg.packageId }, "Approve", "Approve review")
      : "",
    !pkg.enabled && !reviewPending
      ? renderActionButton("install", { packageId: pkg.packageId }, "Enable", "Enable package", "is-primary")
      : "",
    pkg.enabled && pkg.name !== "packages"
      ? renderActionButton("remove", { packageId: pkg.packageId }, "Disable", "Disable package")
      : "",
    isThirdPartyPackage(pkg)
      ? renderActionButton(
        "public-set",
        { packageId: pkg.packageId, public: pkg.source?.public ? "false" : "true" },
        pkg.source?.public ? "Hide" : "Publish",
        pkg.source?.public ? "Hide from public catalog" : "Expose in public catalog",
      )
      : "",
    renderActionButton("checkout", { packageId: pkg.packageId, ref: currentRef }, "Use ref", "Use this ref"),
  ].filter(Boolean).join("");

  return `
    <section class="packages-stage">
      <header class="packages-stage-header">
        <div class="packages-stage-copy">
          <div class="packages-title-row">
            <h1>${escapeHtml(pkg.name)}</h1>
            <span class="packages-badge ${scopeBadgeClass(pkg.scope)}">${escapeHtml(scopeLabel(pkg.scope))}</span>
            <span class="packages-badge ${packageStateClass(pkg)}">${escapeHtml(packageStateLabel(pkg))}</span>
            ${pkg.source?.public ? '<span class="packages-badge is-public">Public</span>' : '<span class="packages-badge is-private">Private</span>'}
          </div>
          <p>${escapeHtml(pkg.description || "No description provided.")}</p>
        </div>
        <div class="packages-toolbar">${actions}</div>
      </header>
      <div class="packages-stage-subbar">
        <form method="get" class="packages-inline-form">
          <input type="hidden" name="screen" value="${escapeHtml(screen)}" />
          <input type="hidden" name="packageId" value="${escapeHtml(pkg.packageId)}" />
          <input type="hidden" name="scope" value="${escapeHtml(scopeFilter)}" />
          <label>
            <span>Browse ref</span>
            <select name="ref">
              ${(branches.length > 0 ? branches : [currentRef]).map((branch) => `<option value="${escapeHtml(branch)}"${branch === currentRef ? " selected" : ""}>${escapeHtml(branch)}</option>`).join("")}
            </select>
          </label>
          <button type="submit" class="packages-tool-btn">Browse</button>
        </form>
        <a class="packages-link-btn" href="${escapeHtml(repoHref(routeBase, pkg.source?.repo ?? "", "files", { ref: currentRef, packageId: pkg.packageId }))}">Open repo</a>
      </div>
      <section class="packages-stage-body">
        ${isThirdPartyPackage(pkg) && reviewPending ? `
          <section class="packages-notice is-review">
            <strong>Review required</strong>
            <p>This package stays disabled until you inspect it and explicitly approve it.</p>
          </section>` : ""}
        ${isThirdPartyPackage(pkg) && reviewed ? `
          <section class="packages-notice is-reviewed">
            <strong>Reviewed</strong>
            <p>Approved on ${escapeHtml(formatReviewTime(pkg.review.approvedAt))}.</p>
          </section>` : ""}
        <section class="packages-info-grid">
          <article><span>Source</span><strong>${escapeHtml(pkg.source?.repo ?? "unknown")}</strong></article>
          <article><span>Ref</span><strong>${escapeHtml(pkg.source?.ref ?? "main")}</strong></article>
          <article><span>Resolved commit</span><strong class="packages-mono">${escapeHtml(pkg.source?.resolvedCommit ?? "unknown")}</strong></article>
          <article><span>Runtime</span><strong>${escapeHtml(pkg.runtime ?? "unknown")}</strong></article>
          <article><span>Version</span><strong>${escapeHtml(pkg.version ?? "0.0.0")}</strong></article>
          <article><span>Updated</span><strong>${escapeHtml(new Date(pkg.updatedAt).toLocaleString())}</strong></article>
        </section>
        <section class="packages-section-block">
          <h2>Capabilities</h2>
          <div class="packages-chip-row">
            ${(Array.isArray(pkg.bindingNames) && pkg.bindingNames.length > 0)
              ? pkg.bindingNames.map((binding) => `<span class="packages-chip">${escapeHtml(binding)}</span>`).join("")
              : '<span class="packages-empty-inline">No declared bindings.</span>'}
          </div>
        </section>
        <section class="packages-section-block">
          <h2>Entrypoints</h2>
          <div class="packages-table-list">
            ${(Array.isArray(pkg.entrypoints) && pkg.entrypoints.length > 0)
              ? pkg.entrypoints.map((entrypoint) => `
                <div class="packages-table-row">
                  <strong>${escapeHtml(entrypoint.name)}</strong>
                  <span>${escapeHtml(entrypoint.kind)}</span>
                </div>`).join("")
              : '<div class="packages-empty-inline">No entrypoints.</div>'}
          </div>
        </section>
      </section>
    </section>`;
}

function renderDiscoverStage(routeBase, statusText, errorText, importSource, importRef, importSubdir, remotes, catalogName, remoteName, remoteUrl) {
  const catalogLinks = [
    `<a class="${catalogName === "local" ? "is-active" : ""}" href="${escapeHtml(buildUrl(routeBase, { screen: "discover", catalog: "local", source: importSource, ref: importRef, subdir: importSubdir }))}">Local</a>`,
    ...((Array.isArray(remotes) ? remotes : []).map((remote) => `<a class="${catalogName === remote.name ? "is-active" : ""}" href="${escapeHtml(buildUrl(routeBase, { screen: "discover", catalog: remote.name, source: importSource, ref: importRef, subdir: importSubdir }))}">${escapeHtml(remote.name)}</a>`)),
  ].join("");

  return `
    <section class="packages-stage">
      <header class="packages-stage-header">
        <div class="packages-stage-copy">
          <div class="packages-title-row"><h1>Discover</h1></div>
          <p>Import packages from explicit sources and browse public catalogs exposed by this server or configured remotes.</p>
        </div>
      </header>
      <section class="packages-stage-body packages-discover-body">
        <section class="packages-section-block">
          <h2>Import</h2>
          <form method="post" class="packages-form-grid is-import">
            <input type="hidden" name="action" value="add" />
            <label>
              <span>Source</span>
              <input type="text" name="source" value="${escapeHtml(importSource)}" placeholder="owner/repo or https://..." spellcheck="false" />
            </label>
            <label>
              <span>Ref</span>
              <input type="text" name="ref" value="${escapeHtml(importRef)}" placeholder="main" spellcheck="false" />
            </label>
            <label>
              <span>Subdir</span>
              <input type="text" name="subdir" value="${escapeHtml(importSubdir)}" placeholder="." spellcheck="false" />
            </label>
            <button type="submit" class="packages-tool-btn is-primary">Import</button>
          </form>
          <p class="packages-note">Third-party imports stay disabled until reviewed.</p>
        </section>
        <section class="packages-section-block">
          <h2>Remotes</h2>
          <form method="post" class="packages-form-grid is-remote">
            <input type="hidden" name="action" value="remote-add" />
            <label>
              <span>Name</span>
              <input type="text" name="remoteName" value="${escapeHtml(remoteName)}" placeholder="lab" spellcheck="false" />
            </label>
            <label>
              <span>Base URL</span>
              <input type="text" name="remoteUrl" value="${escapeHtml(remoteUrl)}" placeholder="https://gsv.example.com" spellcheck="false" />
            </label>
            <button type="submit" class="packages-tool-btn">Add remote</button>
          </form>
          <nav class="packages-subfilters">${catalogLinks}</nav>
        </section>
        ${statusText ? `<p class="packages-status">${escapeHtml(statusText)}</p>` : ""}
        ${errorText ? `<p class="packages-status is-error">${escapeHtml(errorText)}</p>` : ""}
      </section>
    </section>`;
}

function renderRepoToolbar(routeBase, selectedRepo, repoPrimary, repoView, browseRef, searchQuery, selectedCommit, refs) {
  const branches = Object.keys(refs?.heads ?? {}).sort();
  return `
    <div class="packages-stage-subbar">
      <form method="get" class="packages-inline-form">
        <input type="hidden" name="screen" value="repos" />
        <input type="hidden" name="repo" value="${escapeHtml(selectedRepo.repo)}" />
        <input type="hidden" name="repoView" value="${escapeHtml(repoView)}" />
        <input type="hidden" name="q" value="${escapeHtml(searchQuery || "")}" />
        ${selectedCommit ? `<input type="hidden" name="commit" value="${escapeHtml(selectedCommit)}" />` : ""}
        <label>
          <span>Ref</span>
          <select name="ref">
            ${(branches.length > 0 ? branches : [browseRef]).map((branch) => `<option value="${escapeHtml(branch)}"${branch === browseRef ? " selected" : ""}>${escapeHtml(branch)}</option>`).join("")}
          </select>
        </label>
        <button type="submit" class="packages-tool-btn">Browse</button>
      </form>
      ${repoPrimary && isThirdPartyPackage(repoPrimary)
        ? renderActionButton(
          "public-set",
          { repo: selectedRepo.repo, public: selectedRepo.public ? "false" : "true" },
          selectedRepo.public ? "Hide" : "Publish",
          selectedRepo.public ? "Hide repo from public catalog" : "Expose repo in public catalog",
        )
        : ""}
    </div>`;
}

function renderRepoTabs(routeBase, selectedRepo, repoView, browseRef, path, searchQuery, selectedCommit) {
  const tabs = [
    ["files", "Files", { path }],
    ["commits", "Commits", {}],
    ["diff", "Diff", { commit: selectedCommit }],
    ["search", "Search", { q: searchQuery }],
    ["packages", "Packages", {}],
  ];
  return `
    <nav class="packages-stage-tabs">
      ${tabs.map(([id, label, extras]) => `<a class="${repoView === id ? "is-active" : ""}" href="${escapeHtml(repoHref(routeBase, selectedRepo.repo, id, { ref: browseRef, ...extras }))}">${escapeHtml(label)}</a>`).join("")}
    </nav>`;
}

function renderRepoBreadcrumbs(routeBase, selectedRepo, browseRef, path) {
  const normalized = normalizePath(path);
  const segments = normalized ? normalized.split("/") : [];
  const crumbs = [
    `<a href="${escapeHtml(repoHref(routeBase, selectedRepo.repo, "files", { ref: browseRef }))}">${escapeHtml(selectedRepo.repo)}</a>`,
  ];
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    crumbs.push('<span class="packages-crumb-sep">/</span>');
    crumbs.push(`<a href="${escapeHtml(repoHref(routeBase, selectedRepo.repo, "files", { ref: browseRef, path: current }))}">${escapeHtml(segment)}</a>`);
  }
  return `<nav class="packages-breadcrumbs">${crumbs.join("")}</nav>`;
}

function renderRepoFiles(routeBase, selectedRepo, browseRef, path, readResult) {
  if (!readResult) {
    return '<div class="packages-empty">No repository content loaded.</div>';
  }
  if (readResult.kind === "file") {
    return `
      ${renderRepoBreadcrumbs(routeBase, selectedRepo, browseRef, path)}
      <div class="packages-repo-file-meta">
        <strong>${escapeHtml(path || "/")}</strong>
        <span>${escapeHtml(String(readResult.size ?? 0))} bytes</span>
      </div>
      ${readResult.isBinary
        ? '<div class="packages-empty">Binary file preview omitted.</div>'
        : `<pre class="packages-code">${escapeHtml(readResult.content ?? "")}</pre>`}`;
  }

  const rows = [];
  if (path) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    rows.push(`
      <a class="packages-table-row is-link" href="${escapeHtml(repoHref(routeBase, selectedRepo.repo, "files", { ref: browseRef, path: parent }))}">
        <strong>..</strong>
        <span>parent</span>
      </a>`);
  }
  for (const entry of Array.isArray(readResult.entries) ? readResult.entries : []) {
    rows.push(`
      <a class="packages-table-row is-link" href="${escapeHtml(repoHref(routeBase, selectedRepo.repo, "files", { ref: browseRef, path: entry.path }))}">
        <strong>${escapeHtml(entry.name)}</strong>
        <span>${escapeHtml(entry.type)}</span>
      </a>`);
  }
  return `
    ${renderRepoBreadcrumbs(routeBase, selectedRepo, browseRef, path)}
    <div class="packages-table-list">${rows.join("") || '<div class="packages-empty">Folder is empty.</div>'}</div>`;
}

function renderRepoCommits(routeBase, selectedRepo, browseRef, offset, logResult) {
  const entries = Array.isArray(logResult?.entries) ? logResult.entries : [];
  const prevHref = offset > 0
    ? repoHref(routeBase, selectedRepo.repo, "commits", { ref: browseRef, offset: Math.max(0, offset - COMMIT_PAGE_SIZE) })
    : "";
  const nextHref = entries.length === COMMIT_PAGE_SIZE
    ? repoHref(routeBase, selectedRepo.repo, "commits", { ref: browseRef, offset: offset + COMMIT_PAGE_SIZE })
    : "";
  return `
    <div class="packages-table-list">
      ${entries.length === 0
        ? '<div class="packages-empty">No commits available.</div>'
        : entries.map((entry) => `
          <a class="packages-table-row is-link is-commit" href="${escapeHtml(repoHref(routeBase, selectedRepo.repo, "diff", { ref: browseRef, commit: entry.hash }))}">
            <span class="packages-mono">${escapeHtml(shortHash(entry.hash))}</span>
            <strong>${escapeHtml(firstLine(entry.message))}</strong>
            <span>${escapeHtml(`${entry.author} · ${formatTimestamp(entry.commitTime)}`)}</span>
          </a>`).join("")}
    </div>
    <div class="packages-pagination">
      ${prevHref ? `<a href="${escapeHtml(prevHref)}">Previous</a>` : "<span></span>"}
      ${nextHref ? `<a href="${escapeHtml(nextHref)}">Next</a>` : "<span></span>"}
    </div>`;
}

function renderRepoDiff(diffResult) {
  if (!diffResult) {
    return '<div class="packages-empty">Select a commit to inspect its diff.</div>';
  }
  return `
    <section class="packages-diff-summary">
      <span class="packages-badge is-catalog">${escapeHtml(shortHash(diffResult.commitHash))}</span>
      ${diffResult.parentHash ? `<span class="packages-badge is-private">parent ${escapeHtml(shortHash(diffResult.parentHash))}</span>` : ""}
      <span>${escapeHtml(`${diffResult.stats.filesChanged} files changed`)}</span>
      <span>${escapeHtml(`+${diffResult.stats.additions} / -${diffResult.stats.deletions}`)}</span>
    </section>
    <div class="packages-diff-list">
      ${(Array.isArray(diffResult.files) ? diffResult.files : []).map((file) => `
        <article class="packages-diff-file">
          <header>
            <strong>${escapeHtml(file.path)}</strong>
            <span class="packages-badge ${file.status === "added" ? "is-enabled" : file.status === "deleted" ? "is-disabled" : "is-reviewed"}">${escapeHtml(file.status)}</span>
          </header>
          ${Array.isArray(file.hunks) && file.hunks.length > 0
            ? file.hunks.map((hunk) => `
              <section class="packages-diff-hunk">
                <div class="packages-diff-hunk-meta">@@ -${escapeHtml(String(hunk.oldStart))},${escapeHtml(String(hunk.oldCount))} +${escapeHtml(String(hunk.newStart))},${escapeHtml(String(hunk.newCount))} @@</div>
                <pre class="packages-diff-code">${hunk.lines.map((line) => `<span class="packages-diff-line ${line.tag === "add" ? "is-add" : line.tag === "delete" ? "is-delete" : line.tag === "binary" ? "is-binary" : ""}">${escapeHtml(line.tag === "add" ? "+" : line.tag === "delete" ? "-" : line.tag === "binary" ? "!" : " ")}${escapeHtml(line.content)}</span>`).join("\n")}</pre>
              </section>`).join("")
            : '<div class="packages-empty-inline">No textual hunks.</div>'}
        </article>`).join("") || '<div class="packages-empty">No file changes.</div>'}
    </div>`;
}

function renderRepoSearch(routeBase, selectedRepo, browseRef, searchQuery, searchResult) {
  const matches = Array.isArray(searchResult?.matches) ? searchResult.matches : [];
  return `
    <section class="packages-search-pane">
      <form method="get" class="packages-inline-form is-search">
        <input type="hidden" name="screen" value="repos" />
        <input type="hidden" name="repo" value="${escapeHtml(selectedRepo.repo)}" />
        <input type="hidden" name="repoView" value="search" />
        <input type="hidden" name="ref" value="${escapeHtml(browseRef)}" />
        <label>
          <span>Query</span>
          <input type="text" name="q" value="${escapeHtml(searchQuery)}" placeholder="Search code" spellcheck="false" />
        </label>
        <button type="submit" class="packages-tool-btn">Search</button>
      </form>
      ${searchQuery
        ? `<div class="packages-search-meta">${escapeHtml(`${matches.length} match${matches.length === 1 ? "" : "es"}${searchResult?.truncated ? " (truncated)" : ""}`)}</div>`
        : '<div class="packages-empty-inline">Enter a search query.</div>'}
      <div class="packages-table-list">
        ${!searchQuery
          ? ""
          : matches.length === 0
            ? '<div class="packages-empty">No matches.</div>'
            : matches.map((match) => `
              <a class="packages-table-row is-link is-search-result" href="${escapeHtml(repoHref(routeBase, selectedRepo.repo, "files", { ref: browseRef, path: match.path }))}">
                <strong>${escapeHtml(match.path)}</strong>
                <span>${escapeHtml(`L${match.line} · ${match.content.trim()}`)}</span>
              </a>`).join("")}
      </div>
    </section>`;
}

function renderRepoPackages(routeBase, selectedRepo, repoPackages) {
  return `
    <div class="packages-table-list">
      ${repoPackages.length === 0
        ? '<div class="packages-empty">No packages detected in this repo.</div>'
        : repoPackages.map((pkg) => `
          <a class="packages-table-row is-link" href="${escapeHtml(packageHref(routeBase, needsReviewApproval(pkg) ? "review" : "installed", pkg.packageId))}">
            <strong>${escapeHtml(pkg.name)}</strong>
            <span>${escapeHtml(`${scopeLabel(pkg.scope)} · ${packageStateLabel(pkg)} · ${pkg.source?.subdir ?? "."}`)}</span>
          </a>`).join("")}
    </div>`;
}

function renderRepoStage(routeBase, selectedRepo, repoPrimary, repoPackages, repoView, browseRef, path, offset, refs, readResult, logResult, diffResult, searchQuery, searchResult, selectedCommit) {
  if (!selectedRepo || !repoPrimary) {
    return '<section class="packages-stage"><div class="packages-empty">Select a repository.</div></section>';
  }

  let body = "";
  if (repoView === "commits") {
    body = renderRepoCommits(routeBase, selectedRepo, browseRef, offset, logResult);
  } else if (repoView === "diff") {
    body = renderRepoDiff(diffResult);
  } else if (repoView === "search") {
    body = renderRepoSearch(routeBase, selectedRepo, browseRef, searchQuery, searchResult);
  } else if (repoView === "packages") {
    body = renderRepoPackages(routeBase, selectedRepo, repoPackages);
  } else {
    body = renderRepoFiles(routeBase, selectedRepo, browseRef, path, readResult);
  }

  return `
    <section class="packages-stage">
      <header class="packages-stage-header">
        <div class="packages-stage-copy">
          <div class="packages-title-row">
            <h1>${escapeHtml(selectedRepo.repo)}</h1>
            <span class="packages-badge ${selectedRepo.public ? "is-public" : "is-private"}">${selectedRepo.public ? "Public" : "Private"}</span>
            <span class="packages-badge is-catalog">${escapeHtml(`${repoPackages.length} package${repoPackages.length === 1 ? "" : "s"}`)}</span>
          </div>
          <p>Browse repository contents, commit history, diffs, search results, and detected packages.</p>
        </div>
      </header>
      ${renderRepoToolbar(routeBase, selectedRepo, repoPrimary, repoView, browseRef, searchQuery, selectedCommit, refs)}
      ${renderRepoTabs(routeBase, selectedRepo, repoView, browseRef, path, searchQuery, selectedCommit)}
      <section class="packages-stage-body">${body}</section>
    </section>`;
}

function renderLayout(state) {
  const {
    routeBase,
    screen,
    packages,
    selectedPkg,
    scopeFilter,
    remotes,
    catalog,
    catalogName,
    importSource,
    importRef,
    importSubdir,
    remoteName,
    remoteUrl,
    statusText,
    errorText,
    repos,
    selectedRepo,
    repoPrimary,
    repoPackages,
    repoView,
    browseRef,
    path,
    offset,
    refs,
    readResult,
    logResult,
    diffResult,
    searchQuery,
    searchResult,
    selectedCommit,
    openChatProcess,
  } = state;

  const reviewPackages = packages.filter((pkg) => needsReviewApproval(pkg));
  const listPane = screen === "repos"
    ? renderRepoListPane(routeBase, repos, selectedRepo, repoView)
    : screen === "discover"
      ? renderDiscoverListPane(routeBase, catalog, importSource, importRef, importSubdir, catalogName)
      : renderPackageListPane(routeBase, screen, screen === "review" ? reviewPackages : packages, selectedPkg?.packageId ?? "", scopeFilter);

  const stage = screen === "repos"
    ? renderRepoStage(routeBase, selectedRepo, repoPrimary, repoPackages, repoView, browseRef, path, offset, refs, readResult, logResult, diffResult, searchQuery, searchResult, selectedCommit)
    : screen === "discover"
      ? renderDiscoverStage(routeBase, statusText, errorText, importSource, importRef, importSubdir, remotes, catalogName, remoteName, remoteUrl)
      : renderPackageStage(routeBase, screen, selectedPkg, refs, browseRef, scopeFilter);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Packages</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #eef3f8;
        --pane: rgba(247, 250, 253, 0.92);
        --pane-strong: rgba(255, 255, 255, 0.96);
        --line: rgba(28, 44, 56, 0.09);
        --line-strong: rgba(28, 44, 56, 0.16);
        --text: #18303c;
        --muted: #68808e;
        --accent: #174e87;
        --accent-soft: rgba(23, 78, 135, 0.1);
        --ok: #2a7b57;
        --warn: #9c6a2d;
        --danger: #975441;
        --mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        --sans: Manrope, system-ui, sans-serif;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        background: transparent;
        color: var(--text);
        font-family: var(--sans);
      }
      a { color: inherit; }
      main {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 168px 320px minmax(0, 1fr);
        background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.08));
      }
      .packages-app-nav,
      .packages-list-pane,
      .packages-stage {
        min-height: 0;
      }
      .packages-app-nav {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        border-right: 1px solid var(--line);
        background: rgba(238, 243, 248, 0.88);
      }
      .packages-app-nav header {
        padding: 14px 14px 10px;
        border-bottom: 1px solid var(--line);
      }
      .packages-app-nav header strong {
        display: block;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .packages-app-nav-items {
        display: grid;
        align-content: start;
        gap: 2px;
        padding: 10px 8px;
      }
      .packages-app-nav-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 34px;
        padding: 0 10px;
        border-radius: 8px;
        text-decoration: none;
        color: var(--muted);
        font-size: 13px;
        font-weight: 700;
      }
      .packages-app-nav-item:hover,
      .packages-app-nav-item.is-selected {
        background: rgba(255, 255, 255, 0.72);
        color: var(--text);
      }
      .packages-app-nav-badge {
        min-width: 20px;
        height: 20px;
        padding: 0 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 11px;
      }
      .packages-list-pane {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        border-right: 1px solid var(--line);
        background: rgba(244, 248, 252, 0.9);
      }
      .packages-pane-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px 10px;
        border-bottom: 1px solid var(--line);
      }
      .packages-pane-header strong {
        display: block;
        font-size: 13px;
      }
      .packages-pane-header span {
        display: block;
        margin-top: 2px;
        font-size: 12px;
        color: var(--muted);
      }
      .packages-subfilters {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .packages-subfilters a {
        font-size: 12px;
        color: var(--muted);
        text-decoration: none;
      }
      .packages-subfilters a.is-active {
        color: var(--accent);
        font-weight: 700;
      }
      .packages-list-scroll {
        min-height: 0;
        overflow: auto;
        padding: 8px;
        display: grid;
        align-content: start;
        gap: 2px;
      }
      .packages-list-item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: start;
        min-height: 52px;
        padding: 10px 10px;
        border-radius: 8px;
        text-decoration: none;
      }
      .packages-list-item:hover,
      .packages-list-item.is-selected {
        background: rgba(255, 255, 255, 0.8);
      }
      .packages-list-copy,
      .packages-list-meta {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .packages-list-copy strong,
      .packages-table-row strong,
      .packages-stage-copy h1 {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .packages-list-copy span,
      .packages-table-row span,
      .packages-note,
      .packages-status,
      .packages-stage-copy p,
      .packages-repo-file-meta span,
      .packages-empty-inline,
      .packages-empty {
        color: var(--muted);
      }
      .packages-list-copy span,
      .packages-list-meta,
      .packages-table-row span,
      .packages-status,
      .packages-note,
      .packages-empty-inline,
      .packages-empty,
      .packages-repo-file-meta span {
        font-size: 12px;
      }
      .packages-list-meta {
        justify-items: end;
      }
      .packages-stage {
        display: grid;
        grid-template-rows: auto auto auto minmax(0, 1fr);
        min-height: 0;
        background: rgba(249, 251, 253, 0.88);
      }
      .packages-stage-header,
      .packages-stage-subbar,
      .packages-stage-tabs {
        padding-left: 18px;
        padding-right: 18px;
        border-bottom: 1px solid var(--line);
      }
      .packages-stage-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding-top: 16px;
        padding-bottom: 14px;
      }
      .packages-stage-copy {
        display: grid;
        gap: 6px;
        min-width: 0;
      }
      .packages-title-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .packages-title-row h1 {
        margin: 0;
        font-size: 1.55rem;
        line-height: 1;
        font-family: "Space Grotesk", var(--sans);
      }
      .packages-stage-copy p {
        margin: 0;
        max-width: 72ch;
      }
      .packages-toolbar,
      .packages-inline-form,
      .packages-stage-tabs {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .packages-stage-subbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding-top: 10px;
        padding-bottom: 10px;
      }
      .packages-inline-form label,
      .packages-form-grid label {
        display: grid;
        gap: 4px;
      }
      .packages-inline-form label span,
      .packages-form-grid label span {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .packages-inline-form select,
      .packages-inline-form input,
      .packages-form-grid input {
        min-height: 34px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid transparent;
        background: rgba(255,255,255,0.92);
        color: var(--text);
        font: inherit;
        outline: none;
      }
      .packages-inline-form select:focus,
      .packages-inline-form input:focus,
      .packages-form-grid input:focus {
        border-color: rgba(23, 78, 135, 0.24);
      }
      .packages-stage-tabs {
        padding-top: 8px;
        padding-bottom: 8px;
      }
      .packages-stage-tabs a {
        color: var(--muted);
        text-decoration: none;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .packages-stage-tabs a.is-active {
        color: var(--accent);
      }
      .packages-stage-body {
        min-height: 0;
        overflow: auto;
        padding: 18px;
        display: grid;
        align-content: start;
        gap: 18px;
      }
      .packages-info-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 1px;
        border: 1px solid var(--line);
        background: var(--line);
      }
      .packages-info-grid article {
        display: grid;
        gap: 4px;
        min-height: 64px;
        padding: 12px 12px;
        background: var(--pane-strong);
      }
      .packages-info-grid article span {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .packages-section-block {
        display: grid;
        gap: 10px;
      }
      .packages-section-block h2 {
        margin: 0;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .packages-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .packages-chip,
      .packages-badge {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 0 8px;
        border-radius: 999px;
        font-size: 12px;
        line-height: 1;
        background: rgba(23, 78, 135, 0.08);
        color: var(--text);
      }
      .packages-badge.is-mine,
      .packages-badge.is-reviewed { background: rgba(39, 123, 87, 0.12); color: var(--ok); }
      .packages-badge.is-system,
      .packages-badge.is-catalog { background: rgba(23, 78, 135, 0.1); color: var(--accent); }
      .packages-badge.is-workspace,
      .packages-badge.is-review { background: rgba(156, 106, 45, 0.12); color: var(--warn); }
      .packages-badge.is-public,
      .packages-badge.is-enabled { background: rgba(39, 123, 87, 0.12); color: var(--ok); }
      .packages-badge.is-private,
      .packages-badge.is-disabled { background: rgba(151, 84, 65, 0.12); color: var(--danger); }
      .packages-table-list,
      .packages-diff-list {
        display: grid;
        gap: 1px;
        border: 1px solid var(--line);
        background: var(--line);
      }
      .packages-table-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        min-height: 42px;
        padding: 10px 12px;
        background: var(--pane-strong);
      }
      .packages-table-row.is-link {
        text-decoration: none;
      }
      .packages-table-row.is-link:hover {
        background: #ffffff;
      }
      .packages-table-row.is-commit {
        grid-template-columns: 76px minmax(0, 1fr) auto;
      }
      .packages-table-row.is-search-result {
        grid-template-columns: minmax(0, 1fr);
      }
      .packages-breadcrumbs {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .packages-breadcrumbs a,
      .packages-pagination a,
      .packages-link-btn {
        color: var(--accent);
        text-decoration: none;
      }
      .packages-crumb-sep { color: var(--muted); }
      .packages-repo-file-meta,
      .packages-search-meta,
      .packages-diff-summary {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        font-size: 12px;
      }
      .packages-code,
      .packages-diff-code,
      .packages-mono {
        font-family: var(--mono);
      }
      .packages-code,
      .packages-diff-code {
        margin: 0;
        padding: 14px;
        overflow: auto;
        border: 1px solid var(--line);
        background: #fbfdff;
        font-size: 12px;
        line-height: 1.55;
      }
      .packages-diff-file {
        display: grid;
        gap: 10px;
        padding: 14px;
        background: var(--pane-strong);
      }
      .packages-diff-file header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .packages-diff-hunk { display: grid; gap: 6px; }
      .packages-diff-hunk-meta {
        font-size: 11px;
        color: var(--muted);
        font-family: var(--mono);
      }
      .packages-diff-line { display: block; }
      .packages-diff-line.is-add { color: var(--ok); }
      .packages-diff-line.is-delete { color: var(--danger); }
      .packages-diff-line.is-binary { color: var(--warn); }
      .packages-form-grid {
        display: grid;
        gap: 10px;
      }
      .packages-form-grid.is-import {
        grid-template-columns: minmax(280px, 1.7fr) 140px 140px auto;
        align-items: end;
      }
      .packages-form-grid.is-remote {
        grid-template-columns: 180px minmax(280px, 1.4fr) auto;
        align-items: end;
      }
      .packages-tool-btn,
      .packages-link-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 34px;
        padding: 0 10px;
        border: 0;
        border-radius: 6px;
        background: rgba(232, 238, 245, 0.9);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .packages-tool-btn.is-primary {
        background: var(--accent);
        color: white;
      }
      .packages-status { margin: 0; }
      .packages-status.is-error { color: var(--danger); }
      .packages-notice {
        display: grid;
        gap: 4px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        background: var(--pane-strong);
      }
      .packages-notice strong {
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .packages-notice.is-review strong { color: var(--warn); }
      .packages-notice.is-reviewed strong { color: var(--ok); }
      .packages-notice p { margin: 0; color: var(--muted); }
      .packages-pagination {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .packages-search-pane {
        display: grid;
        gap: 12px;
      }
      .packages-inline-form.is-search {
        align-items: end;
      }
      .packages-inline-form.is-search label {
        min-width: min(420px, 100%);
      }
      .packages-empty,
      .packages-empty-inline {
        padding: 4px 0;
      }
      @media (max-width: 1120px) {
        main {
          grid-template-columns: 152px 280px minmax(0, 1fr);
        }
        .packages-info-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 900px) {
        main {
          grid-template-columns: 1fr;
          grid-template-rows: auto auto minmax(0, 1fr);
        }
        .packages-app-nav,
        .packages-list-pane {
          border-right: 0;
          border-bottom: 1px solid var(--line);
        }
        .packages-app-nav-items {
          grid-auto-flow: column;
          grid-auto-columns: max-content;
          overflow: auto;
        }
        .packages-form-grid.is-import,
        .packages-form-grid.is-remote,
        .packages-info-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <aside class="packages-app-nav">
        <header><strong>Packages</strong></header>
        <nav class="packages-app-nav-items">${renderAppNav(routeBase, screen, reviewPackages.length)}</nav>
      </aside>
      ${listPane}
      ${stage}
    </main>
    ${openChatProcess ? `<script>
      window.parent.postMessage(${JSON.stringify({
        type: "gsv:open-chat-process",
        detail: openChatProcess,
      })}, window.location.origin);
    </script>` : ""}
  </body>
</html>`;
}

export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};
  const appFrame = props.appFrame;
  const kernel = props.kernel;
  if (!appFrame || !kernel) {
    return new Response("App frame missing", { status: 500 });
  }

  const routeBase = appFrame.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/packages";
  const url = new URL(request.url);
  const screen = ["installed", "review", "discover", "repos"].includes(url.searchParams.get("screen") ?? "")
    ? url.searchParams.get("screen")
    : "installed";
  let statusText = "";
  let errorText = "";
  let openChatProcess = null;
  let selectedPackageId = url.searchParams.get("packageId")?.trim() ?? "";
  let selectedRepoSlug = url.searchParams.get("repo")?.trim() ?? "";
  let importSource = url.searchParams.get("source")?.trim() ?? "";
  let importRef = url.searchParams.get("ref")?.trim() ?? "main";
  let importSubdir = url.searchParams.get("subdir")?.trim() ?? ".";
  let catalogName = normalizeCatalogSelection(url.searchParams.get("catalog"));
  let remoteName = "";
  let remoteUrl = "";
  const scopeFilter = ["all", "mine", "system"].includes(url.searchParams.get("scope") ?? "")
    ? url.searchParams.get("scope")
    : "all";

  if (request.method === "POST") {
    try {
      const form = await request.formData();
      const action = String(form.get("action") ?? "").trim();
      if (action === "add") {
        importSource = String(form.get("source") ?? "").trim();
        importRef = String(form.get("ref") ?? "").trim() || "main";
        importSubdir = String(form.get("subdir") ?? "").trim() || ".";
        const source = parseImportSource(importSource);
        const result = await kernel.request("pkg.add", {
          remoteUrl: source.remoteUrl || undefined,
          repo: source.repo || undefined,
          ref: importRef,
          subdir: importSubdir,
        });
        selectedPackageId = result.package.packageId;
        selectedRepoSlug = result.package.source?.repo ?? selectedRepoSlug;
        statusText = result.package.enabled
          ? `Imported and enabled ${result.package.name} from ${result.imported.repo}`
          : `Imported ${result.package.name} from ${result.imported.repo}. Review it before enabling.`;
      } else if (action === "remote-add") {
        remoteName = String(form.get("remoteName") ?? "").trim();
        remoteUrl = String(form.get("remoteUrl") ?? "").trim();
        const result = await kernel.request("pkg.remote.add", {
          name: remoteName,
          baseUrl: remoteUrl,
        });
        catalogName = result.remote.name;
        remoteName = "";
        remoteUrl = "";
        statusText = `${result.changed ? "Added" : "Updated"} remote ${result.remote.name}`;
      } else if (action === "install") {
        const result = await kernel.request("pkg.install", {
          packageId: String(form.get("packageId") ?? "").trim(),
        });
        selectedPackageId = result.package.packageId;
        selectedRepoSlug = result.package.source?.repo ?? selectedRepoSlug;
        statusText = `Enabled ${result.package.name}`;
      } else if (action === "review") {
        const packageId = String(form.get("packageId") ?? "").trim();
        const listResult = await kernel.request("pkg.list", {});
        const target = Array.isArray(listResult?.packages)
          ? listResult.packages.find((pkg) => pkg.packageId === packageId)
          : null;
        if (!target) {
          throw new Error(`Unknown package: ${packageId}`);
        }
        const spawned = await kernel.request("proc.spawn", {
          profile: "review",
          label: `Review ${target.name}`,
          prompt: buildReviewPrompt(target),
          workspace: { mode: "none" },
          mounts: [
            { kind: "package-source", packageId: target.packageId, mountPath: "/src/package" },
            { kind: "package-repo", packageId: target.packageId, mountPath: "/src/repo" },
          ],
        });
        if (!spawned?.ok) {
          throw new Error(spawned?.error || "Failed to spawn review process");
        }
        selectedPackageId = target.packageId;
        selectedRepoSlug = target.source?.repo ?? selectedRepoSlug;
        openChatProcess = {
          pid: spawned.pid,
          workspaceId: spawned.workspaceId,
          cwd: spawned.cwd,
        };
        statusText = `Opened reviewer for ${target.name}`;
      } else if (action === "review-approve") {
        const result = await kernel.request("pkg.review.approve", {
          packageId: String(form.get("packageId") ?? "").trim(),
        });
        selectedPackageId = result.package.packageId;
        selectedRepoSlug = result.package.source?.repo ?? selectedRepoSlug;
        statusText = result.changed
          ? `Approved review for ${result.package.name}`
          : `${result.package.name} was already approved`;
      } else if (action === "remove") {
        const result = await kernel.request("pkg.remove", {
          packageId: String(form.get("packageId") ?? "").trim(),
        });
        selectedPackageId = result.package.packageId;
        selectedRepoSlug = result.package.source?.repo ?? selectedRepoSlug;
        statusText = `Disabled ${result.package.name}`;
      } else if (action === "public-set") {
        const result = await kernel.request("pkg.public.set", {
          packageId: String(form.get("packageId") ?? "").trim() || undefined,
          repo: String(form.get("repo") ?? "").trim() || undefined,
          public: String(form.get("public") ?? "").trim() === "true",
        });
        selectedRepoSlug = result.repo;
        statusText = `${result.public ? "Exposed" : "Hid"} ${result.repo} ${result.public ? "in" : "from"} the public catalog`;
      } else if (action === "checkout") {
        const result = await kernel.request("pkg.checkout", {
          packageId: String(form.get("packageId") ?? "").trim(),
          ref: String(form.get("ref") ?? "").trim(),
        });
        selectedPackageId = result.package.packageId;
        selectedRepoSlug = result.package.source?.repo ?? selectedRepoSlug;
        importRef = result.package.source?.ref ?? importRef;
        statusText = `Switched ${result.package.name} to ${result.package.source?.ref ?? "main"}`;
      }
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
  }

  let packages = [];
  let remotes = [];
  let catalog = { source: { kind: "local", name: "local" }, packages: [] };
  try {
    const result = await kernel.request("pkg.list", {});
    packages = Array.isArray(result?.packages) ? result.packages : [];
  } catch (error) {
    errorText = errorText || (error instanceof Error ? error.message : String(error));
  }
  try {
    const result = await kernel.request("pkg.remote.list", {});
    remotes = Array.isArray(result?.remotes) ? result.remotes : [];
  } catch (error) {
    errorText = errorText || (error instanceof Error ? error.message : String(error));
  }
  try {
    const result = await kernel.request("pkg.public.list", {
      remote: catalogName === "local" ? undefined : catalogName,
    });
    catalog = result;
  } catch (error) {
    errorText = errorText || (error instanceof Error ? error.message : String(error));
  }

  const visiblePackages = screen === "review"
    ? packages.filter((pkg) => needsReviewApproval(pkg))
    : packages;
  const selectedPkg = pickSelectedPackage(visiblePackages, selectedPackageId);
  const repos = collectRepos(packages);
  const selectedRepo = pickSelectedRepo(repos, selectedRepoSlug, selectedPkg);
  const repoPackages = selectedRepo ? selectedRepo.packages : [];
  const repoPrimary = selectedRepo?.primary ?? null;
  const repoView = ["files", "commits", "diff", "search", "packages"].includes(url.searchParams.get("repoView") ?? "")
    ? url.searchParams.get("repoView")
    : "files";
  const browseRef = url.searchParams.get("ref")?.trim()
    || selectedPkg?.source?.ref
    || repoPrimary?.source?.ref
    || "main";
  const path = normalizePath(url.searchParams.get("path") ?? "");
  const offset = clampOffset(url.searchParams.get("offset"));
  const searchQuery = url.searchParams.get("q")?.trim() ?? "";
  let selectedCommit = url.searchParams.get("commit")?.trim() ?? "";

  let refs = { heads: {}, tags: {} };
  let readResult = null;
  let logResult = { entries: [] };
  let diffResult = null;
  let searchResult = { matches: [], truncated: false };

  const repoTargetPkg = screen === "repos" ? repoPrimary : selectedPkg;
  if (repoTargetPkg) {
    try {
      refs = await kernel.request("pkg.repo.refs", { packageId: repoTargetPkg.packageId });
    } catch (error) {
      errorText = errorText || (error instanceof Error ? error.message : String(error));
    }
  }

  if (screen === "repos" && repoPrimary) {
    try {
      if (repoView === "files") {
        readResult = await kernel.request("pkg.repo.read", {
          packageId: repoPrimary.packageId,
          ref: browseRef,
          path,
          root: "repo",
        });
      } else if (repoView === "commits") {
        logResult = await kernel.request("pkg.repo.log", {
          packageId: repoPrimary.packageId,
          ref: browseRef,
          limit: COMMIT_PAGE_SIZE,
          offset,
        });
      } else if (repoView === "diff") {
        if (!selectedCommit) {
          const headLog = await kernel.request("pkg.repo.log", {
            packageId: repoPrimary.packageId,
            ref: browseRef,
            limit: 1,
            offset: 0,
          });
          selectedCommit = headLog?.entries?.[0]?.hash ?? "";
        }
        if (selectedCommit) {
          diffResult = await kernel.request("pkg.repo.diff", {
            packageId: repoPrimary.packageId,
            commit: selectedCommit,
            context: 3,
          });
        }
      } else if (repoView === "search" && searchQuery) {
        searchResult = await kernel.request("pkg.repo.search", {
          packageId: repoPrimary.packageId,
          ref: browseRef,
          query: searchQuery,
          root: "repo",
        });
      }
    } catch (error) {
      errorText = errorText || (error instanceof Error ? error.message : String(error));
    }
  }

  const html = renderLayout({
    routeBase,
    screen,
    packages,
    selectedPkg,
    scopeFilter,
    remotes,
    catalog,
    catalogName,
    importSource,
    importRef,
    importSubdir,
    remoteName,
    remoteUrl,
    statusText,
    errorText,
    repos,
    selectedRepo,
    repoPrimary,
    repoPackages,
    repoView,
    browseRef,
    path,
    offset,
    refs,
    readResult,
    logResult,
    diffResult,
    searchQuery,
    searchResult,
    selectedCommit,
    openChatProcess,
  });

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default { fetch: handleFetch };
