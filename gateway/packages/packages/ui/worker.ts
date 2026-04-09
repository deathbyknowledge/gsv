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
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function normalizePath(path) {
  return String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function clampOffset(raw) {
  const parsed = Number.parseInt(String(raw ?? "0"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
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

function pickSelectedPackage(packages, selectedPackageId) {
  if (!Array.isArray(packages) || packages.length === 0) {
    return null;
  }
  if (selectedPackageId) {
    const exact = packages.find((pkg) => pkg.packageId === selectedPackageId);
    if (exact) {
      return exact;
    }
  }
  return packages.find((pkg) => pkg.name === "packages") ?? packages[0];
}

function isThirdPartyPackage(pkg) {
  const repo = String(pkg?.source?.repo ?? "").trim();
  return repo !== "" && repo !== "system/gsv";
}

function needsReviewApproval(pkg) {
  return Boolean(pkg?.review?.required) && !pkg?.review?.approvedAt;
}

function buildReviewPrompt(pkg) {
  const packageId = String(pkg?.packageId ?? "").trim();
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
    `Review the imported package "${name}" (${packageId}).`,
    "",
    `Source repo: ${repo}`,
    `Source ref: ${ref}`,
    `Subdir: ${subdir}`,
    `Declared bindings: ${bindings}`,
    `Entrypoints: ${entrypoints}`,
    "",
    "Use PackageRefs, PackageRead, and PackageLog to inspect the source and recent history.",
    "Focus on requested capabilities, suspicious behavior, hidden network or shell access, destructive actions, and whether it should be enabled.",
    "Conclude with a clear recommendation: approve or do not approve.",
  ].join("\n");
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

function packageHref(routeBase, pkg, view, extras = {}) {
  return buildUrl(routeBase, {
    packageId: pkg.packageId,
    view,
    ref: extras.ref ?? pkg.source?.ref ?? "main",
    path: extras.path,
    offset: extras.offset,
  });
}

function renderSidebar(routeBase, packages, selectedPackageId) {
  if (!Array.isArray(packages) || packages.length === 0) {
    return '<div class="packages-empty">No packages installed yet.</div>';
  }

  return packages.map((pkg) => {
    const selected = pkg.packageId === selectedPackageId;
    const href = packageHref(routeBase, pkg, "overview");
    const dotClass = pkg.enabled ? "is-enabled" : (isThirdPartyPackage(pkg) ? "is-review" : "is-disabled");
    const secondary = !pkg.enabled && isThirdPartyPackage(pkg)
      ? "Review required"
      : (pkg.source?.repo ?? "unknown");
    return `
      <a class="packages-nav-item ${selected ? "is-selected" : ""}" href="${escapeHtml(href)}">
        <span class="packages-nav-dot ${dotClass}" aria-hidden="true"></span>
        <span class="packages-nav-main">
          <strong>${escapeHtml(pkg.name)}</strong>
          <span>${escapeHtml(secondary)}</span>
        </span>
        <span class="packages-nav-ref">${escapeHtml(pkg.source?.ref ?? "main")}</span>
      </a>`;
  }).join("");
}

function renderImportRail(statusText, errorText, sourceValue, refValue, subdirValue) {
  return `
    <section class="packages-rail">
      <form method="post" class="packages-import-form">
        <input type="hidden" name="action" value="add" />
        <label>
          <span>Source</span>
          <input type="text" name="source" value="${escapeHtml(sourceValue)}" placeholder="owner/repo or https://..." spellcheck="false" />
        </label>
        <label>
          <span>Ref</span>
          <input type="text" name="ref" value="${escapeHtml(refValue)}" placeholder="main" spellcheck="false" />
        </label>
        <label>
          <span>Subdir</span>
          <input type="text" name="subdir" value="${escapeHtml(subdirValue)}" placeholder="." spellcheck="false" />
        </label>
        <button type="submit" class="packages-icon-btn" title="Import package" aria-label="Import package">＋</button>
      </form>
      <p class="packages-rail-note">Imported third-party packages stay disabled until you review their code and capabilities.</p>
      ${statusText ? `<p class="packages-status">${escapeHtml(statusText)}</p>` : ""}
      ${errorText ? `<p class="packages-status is-error">${escapeHtml(errorText)}</p>` : ""}
    </section>`;
}

function renderHeader(routeBase, pkg, refs, browseRef, path, view) {
  const currentRef = browseRef || pkg.source?.ref || "main";
  const reviewPending = needsReviewApproval(pkg);
  const reviewed = Boolean(pkg?.review?.approvedAt);
  const branches = Object.keys(refs?.heads ?? {}).sort();
  const branchOptions = (branches.length > 0 ? branches : [currentRef]).map((branch) => {
    const selected = branch === currentRef ? " selected" : "";
    return `<option value="${escapeHtml(branch)}"${selected}>${escapeHtml(branch)}</option>`;
  }).join("");
  const packageAction = pkg.enabled
    ? (pkg.name === "packages"
      ? '<span class="packages-static-note">Core package</span>'
      : `
        <form method="post">
          <input type="hidden" name="action" value="remove" />
          <input type="hidden" name="packageId" value="${escapeHtml(pkg.packageId)}" />
          <button type="submit" class="packages-icon-btn" title="Disable package" aria-label="Disable package">−</button>
        </form>`)
    : !reviewPending ? `
      <form method="post">
        <input type="hidden" name="action" value="install" />
        <input type="hidden" name="packageId" value="${escapeHtml(pkg.packageId)}" />
        <button type="submit" class="packages-icon-btn" title="Enable package after review" aria-label="Enable package after review">▶</button>
      </form>` : '<span class="packages-static-note">Review first</span>';

  const reviewAction = isThirdPartyPackage(pkg)
    ? `
      <form method="post">
        <input type="hidden" name="action" value="review" />
        <input type="hidden" name="packageId" value="${escapeHtml(pkg.packageId)}" />
        <button type="submit" class="packages-icon-btn" title="Open package reviewer" aria-label="Open package reviewer">⌕</button>
      </form>`
    : "";

  const approveAction = reviewPending
    ? `
      <form method="post">
        <input type="hidden" name="action" value="review-approve" />
        <input type="hidden" name="packageId" value="${escapeHtml(pkg.packageId)}" />
        <button type="submit" class="packages-icon-btn" title="Approve review" aria-label="Approve review">✓</button>
      </form>`
    : (reviewed ? '<span class="packages-static-note">Reviewed</span>' : "");

  const checkoutAction = currentRef !== (pkg.source?.ref ?? "main")
    ? `
      <form method="post">
        <input type="hidden" name="action" value="checkout" />
        <input type="hidden" name="packageId" value="${escapeHtml(pkg.packageId)}" />
        <input type="hidden" name="ref" value="${escapeHtml(currentRef)}" />
        <button type="submit" class="packages-icon-btn" title="Use this ref" aria-label="Use this ref">↺</button>
      </form>`
    : "";

  return `
    <header class="packages-header">
      <div class="packages-header-copy">
        <div class="packages-title-row">
          <h1>${escapeHtml(pkg.name)}</h1>
          <span class="packages-runtime">${escapeHtml(pkg.runtime ?? "unknown")}</span>
          <span class="packages-state ${pkg.enabled ? "is-enabled" : "is-disabled"}">${pkg.enabled ? "enabled" : "disabled"}</span>
        </div>
        <p>${escapeHtml(pkg.description || "No description provided.")}</p>
      </div>
      <div class="packages-header-tools">
        <form method="get" class="packages-ref-form">
          <input type="hidden" name="packageId" value="${escapeHtml(pkg.packageId)}" />
          <input type="hidden" name="view" value="${escapeHtml(view)}" />
          ${path ? `<input type="hidden" name="path" value="${escapeHtml(path)}" />` : ""}
          <select name="ref">${branchOptions}</select>
          <button type="submit" class="packages-icon-btn" title="Browse ref" aria-label="Browse ref">↗</button>
        </form>
        ${checkoutAction}
        ${reviewAction}
        ${approveAction}
        ${packageAction}
      </div>
    </header>`;
}

function renderTabs(routeBase, pkg, ref, path, view) {
  const tabs = [
    ["overview", packageHref(routeBase, pkg, "overview", { ref })],
    ["code", packageHref(routeBase, pkg, "code", { ref, path })],
    ["commits", packageHref(routeBase, pkg, "commits", { ref })],
  ];
  return `
    <nav class="packages-tabs">
      ${tabs.map(([name, href]) => `<a class="${view === name ? "is-active" : ""}" href="${escapeHtml(href)}">${escapeHtml(name)}</a>`).join("")}
    </nav>`;
}

function renderOverview(pkg, refs) {
  const resolvedCommit = pkg.source?.resolvedCommit ?? "Not resolved";
  const heads = Object.keys(refs?.heads ?? {}).sort();
  const tags = Object.keys(refs?.tags ?? {}).sort();
  const bindings = Array.isArray(pkg.bindingNames) ? pkg.bindingNames : [];
  const reviewBanner = isThirdPartyPackage(pkg) && needsReviewApproval(pkg)
    ? `
      <section class="packages-review-banner">
        <strong>Review required before enable</strong>
        <p>This package was imported from a third-party source. Inspect its capabilities, code, and commit history before enabling it.</p>
        <ul class="packages-review-list">
          <li>Read the declared bindings below.</li>
          <li>Browse the code and recent commits.</li>
          <li>Only enable it once you trust the source.</li>
        </ul>
      </section>`
    : isThirdPartyPackage(pkg) && pkg?.review?.approvedAt
      ? `
        <section class="packages-review-banner is-approved">
          <strong>Review approved</strong>
          <p>This package was marked as reviewed on ${escapeHtml(new Date(pkg.review.approvedAt).toLocaleString())}. You can enable it when ready.</p>
        </section>`
    : "";
  return `
    <section class="packages-workspace">
      ${reviewBanner}
      <section class="packages-meta-grid">
        <article>
          <span>Source</span>
          <strong>${escapeHtml(pkg.source?.repo ?? "unknown")}</strong>
        </article>
        <article>
          <span>Active ref</span>
          <strong>${escapeHtml(pkg.source?.ref ?? "main")}</strong>
        </article>
        <article>
          <span>Resolved commit</span>
          <strong class="packages-mono">${escapeHtml(resolvedCommit)}</strong>
        </article>
        <article>
          <span>Version</span>
          <strong>${escapeHtml(pkg.version ?? "0.0.0")}</strong>
        </article>
      </section>
      <section class="packages-section">
        <h2>Granted bindings</h2>
        <div class="packages-chip-grid">
          ${bindings.map((binding) => `<span class="packages-chip">${escapeHtml(binding)}</span>`).join("") || '<span class="packages-chip">No bindings</span>'}
        </div>
      </section>
      <section class="packages-section">
        <h2>Entrypoints</h2>
        <ul class="packages-entry-list">
          ${(Array.isArray(pkg.entrypoints) ? pkg.entrypoints : []).map((entrypoint) => `
            <li>
              <strong>${escapeHtml(entrypoint.name)}</strong>
              <span>${escapeHtml(entrypoint.kind)}</span>
            </li>`).join("") || '<li><strong>No entrypoints</strong><span>n/a</span></li>'}
        </ul>
      </section>
      <section class="packages-section">
        <h2>Available refs</h2>
        <div class="packages-chip-grid">
          ${heads.map((head) => `<span class="packages-chip">${escapeHtml(head)}</span>`).join("") || '<span class="packages-chip">No branches</span>'}
          ${tags.map((tag) => `<span class="packages-chip">tag:${escapeHtml(tag)}</span>`).join("")}
        </div>
      </section>
    </section>`;
}

function renderBreadcrumbs(routeBase, pkg, ref, path) {
  const normalized = normalizePath(path);
  const segments = normalized ? normalized.split("/") : [];
  const crumbs = [
    `<a href="${escapeHtml(packageHref(routeBase, pkg, "code", { ref }))}">${escapeHtml(pkg.name)}</a>`,
  ];
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    crumbs.push(`<span class="packages-crumb-sep">/</span>`);
    crumbs.push(`<a href="${escapeHtml(packageHref(routeBase, pkg, "code", { ref, path: current }))}">${escapeHtml(segment)}</a>`);
  }
  return `<nav class="packages-breadcrumbs">${crumbs.join("")}</nav>`;
}

function renderTree(routeBase, pkg, ref, path, readResult) {
  const rows = [];
  if (path) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    rows.push(`
      <a class="packages-tree-row is-up" href="${escapeHtml(packageHref(routeBase, pkg, "code", { ref, path: parent }))}">
        <span class="packages-tree-icon">↩</span>
        <strong>..</strong>
        <span>parent</span>
      </a>`);
  }
  for (const entry of readResult.entries) {
    rows.push(`
      <a class="packages-tree-row" href="${escapeHtml(packageHref(routeBase, pkg, "code", { ref, path: entry.path }))}">
        <span class="packages-tree-icon">${entry.type === "tree" ? "▣" : entry.type === "symlink" ? "↗" : "≣"}</span>
        <strong>${escapeHtml(entry.name)}</strong>
        <span>${escapeHtml(entry.type)}</span>
      </a>`);
  }
  return `
    ${renderBreadcrumbs(routeBase, pkg, ref, path)}
    <section class="packages-workspace packages-tree-grid">
      ${rows.join("") || '<div class="packages-empty">Folder is empty.</div>'}
    </section>`;
}

function renderFile(routeBase, pkg, ref, path, readResult) {
  return `
    ${renderBreadcrumbs(routeBase, pkg, ref, path)}
    <section class="packages-workspace">
      <div class="packages-file-meta">
        <strong>${escapeHtml(path || "/")}</strong>
        <span>${escapeHtml(String(readResult.size ?? 0))} bytes</span>
      </div>
      ${readResult.isBinary
        ? '<div class="packages-empty">Binary file preview omitted.</div>'
        : `<pre class="packages-code">${escapeHtml(readResult.content ?? "")}</pre>`}
    </section>`;
}

function renderCommits(routeBase, pkg, ref, offset, logResult) {
  const prevHref = offset > 0
    ? packageHref(routeBase, pkg, "commits", { ref, offset: Math.max(0, offset - COMMIT_PAGE_SIZE) })
    : "";
  const nextHref = Array.isArray(logResult.entries) && logResult.entries.length === COMMIT_PAGE_SIZE
    ? packageHref(routeBase, pkg, "commits", { ref, offset: offset + COMMIT_PAGE_SIZE })
    : "";
  return `
    <section class="packages-workspace packages-commit-list">
      ${(Array.isArray(logResult.entries) ? logResult.entries : []).map((entry) => `
        <article class="packages-commit-row">
          <span class="packages-commit-hash">${escapeHtml(shortHash(entry.hash))}</span>
          <div>
            <strong>${escapeHtml(firstLine(entry.message))}</strong>
            <p>${escapeHtml(entry.author)} · ${escapeHtml(formatTimestamp(entry.commitTime))}</p>
          </div>
        </article>`).join("") || '<div class="packages-empty">No commits available.</div>'}
      <div class="packages-pagination">
        ${prevHref ? `<a href="${escapeHtml(prevHref)}">Previous</a>` : "<span></span>"}
        ${nextHref ? `<a href="${escapeHtml(nextHref)}">Next</a>` : "<span></span>"}
      </div>
    </section>`;
}

function renderMain(routeBase, selectedPkg, view, refs, browseRef, path, readResult, logResult, offset) {
  if (!selectedPkg) {
    return '<section class="packages-main-stage"><div class="packages-empty">Import or enable a package to get started.</div></section>';
  }

  const currentRef = browseRef || selectedPkg.source?.ref || "main";
  const body = view === "commits"
    ? renderCommits(routeBase, selectedPkg, currentRef, offset, logResult)
    : view === "code"
      ? readResult?.kind === "file"
        ? renderFile(routeBase, selectedPkg, currentRef, path, readResult)
        : renderTree(routeBase, selectedPkg, currentRef, path, readResult)
      : renderOverview(selectedPkg, refs);

  return `
    <section class="packages-main-stage">
      ${renderHeader(routeBase, selectedPkg, refs, currentRef, path, view)}
      ${renderTabs(routeBase, selectedPkg, currentRef, path, view)}
      ${body}
    </section>`;
}

function renderPage(state) {
  const {
    routeBase,
    packages,
    selectedPkg,
    view,
    browseRef,
    path,
    refs,
    readResult,
    logResult,
    offset,
    statusText,
    errorText,
    importSource,
    importRef,
    importSubdir,
    openChatProcess,
  } = state;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Packages</title>
    <style>
      :root {
        color-scheme: light;
        --surface: #f7f9fc;
        --surface-low: #e9eff6;
        --surface-lowest: #ffffff;
        --line: rgba(42, 50, 56, 0.08);
        --text: #1f2d33;
        --muted: #61737b;
        --primary: #003466;
        --primary-soft: #1a4b84;
        --danger: #904b36;
        font-family: Manrope, system-ui, sans-serif;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        background: transparent;
        color: var(--text);
      }
      main {
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
      }
      .packages-rail {
        display: grid;
        gap: 8px;
        padding: 12px 14px 10px;
        background: rgba(247, 249, 252, 0.56);
        border-bottom: 1px solid var(--line);
      }
      .packages-import-form {
        display: grid;
        grid-template-columns: minmax(260px, 1.8fr) minmax(110px, 0.4fr) minmax(120px, 0.5fr) auto;
        gap: 8px;
        align-items: end;
      }
      .packages-import-form label,
      .packages-ref-form {
        display: grid;
        gap: 4px;
      }
      .packages-import-form span,
      .packages-rail-note {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .packages-rail-note {
        margin: 0;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0;
        text-transform: none;
      }
      .packages-import-form input,
      .packages-ref-form select {
        width: 100%;
        min-height: 34px;
        padding: 0 10px;
        border-radius: 4px;
        border: 1px solid transparent;
        background: rgba(255, 255, 255, 0.78);
        color: var(--text);
        font: inherit;
        outline: none;
      }
      .packages-import-form input:focus,
      .packages-ref-form select:focus {
        border-color: rgba(26, 75, 132, 0.24);
        background: rgba(255, 255, 255, 0.96);
      }
      .packages-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 34px;
        min-height: 34px;
        padding: 0 8px;
        border: 0;
        border-radius: 6px;
        background: rgba(233, 239, 246, 0.76);
        color: var(--text);
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
      }
      .packages-static-note {
        font-size: 12px;
        color: var(--muted);
      }
      .packages-status {
        margin: 0;
        font-size: 12px;
        color: var(--muted);
      }
      .packages-status.is-error {
        color: var(--danger);
      }
      .packages-shell {
        min-height: 0;
        display: grid;
        grid-template-columns: 300px minmax(0, 1fr);
      }
      .packages-sidebar {
        min-height: 0;
        overflow: auto;
        padding: 10px;
        background: rgba(233, 239, 246, 0.56);
      }
      .packages-nav-item {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        padding: 10px 12px;
        border-radius: 10px;
        color: inherit;
        text-decoration: none;
      }
      .packages-nav-item:hover,
      .packages-nav-item.is-selected {
        background: rgba(255, 255, 255, 0.72);
      }
      .packages-nav-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #98a7b4;
      }
      .packages-nav-dot.is-enabled { background: #5f8a73; }
      .packages-nav-dot.is-review { background: #b38a4d; }
      .packages-nav-dot.is-disabled { background: #b3bcc4; }
      .packages-nav-main {
        min-width: 0;
        display: grid;
        gap: 2px;
      }
      .packages-nav-main strong,
      .packages-nav-ref,
      .packages-runtime,
      .packages-state,
      .packages-meta-grid article span,
      .packages-chip,
      .packages-file-meta span,
      .packages-commit-hash,
      .packages-nav-main span,
      .packages-commit-row p {
        font-size: 12px;
      }
      .packages-nav-main span,
      .packages-nav-ref,
      .packages-runtime,
      .packages-meta-grid article span,
      .packages-file-meta span,
      .packages-commit-row p {
        color: var(--muted);
      }
      .packages-main-stage {
        min-height: 0;
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        padding: 10px 14px 14px;
      }
      .packages-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .packages-header-copy {
        display: grid;
        gap: 6px;
      }
      .packages-title-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .packages-title-row h1 {
        margin: 0;
        font-family: "Space Grotesk", system-ui, sans-serif;
        font-size: 1.8rem;
        line-height: 0.98;
      }
      .packages-header-copy p {
        margin: 0;
        color: var(--muted);
        max-width: 60ch;
      }
      .packages-state {
        color: var(--muted);
      }
      .packages-state.is-enabled { color: #5f8a73; }
      .packages-state.is-disabled { color: #8f5b47; }
      .packages-header-tools,
      .packages-ref-form {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .packages-ref-form select {
        min-width: 180px;
      }
      .packages-tabs {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 10px 0 8px;
      }
      .packages-tabs a {
        color: var(--muted);
        text-decoration: none;
        font-size: 13px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .packages-tabs a.is-active {
        color: var(--primary);
      }
      .packages-workspace {
        min-height: 0;
        overflow: auto;
        background: rgba(255, 255, 255, 0.54);
        padding: 14px;
        border-radius: 12px;
      }
      .packages-meta-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin-bottom: 18px;
      }
      .packages-meta-grid article {
        display: grid;
        gap: 4px;
        padding: 10px 12px;
        background: rgba(233, 239, 246, 0.56);
        border-radius: 10px;
      }
      .packages-meta-grid article strong {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .packages-mono,
      .packages-code,
      .packages-commit-hash {
        font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      }
      .packages-section + .packages-section {
        margin-top: 18px;
      }
      .packages-review-banner {
        display: grid;
        gap: 8px;
        margin-bottom: 18px;
        padding: 12px 14px;
        border-radius: 10px;
        background: rgba(233, 239, 246, 0.66);
      }
      .packages-review-banner strong {
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--primary);
      }
      .packages-review-banner.is-approved strong {
        color: #5f8a73;
      }
      .packages-review-banner p {
        margin: 0;
        color: var(--muted);
      }
      .packages-review-list {
        margin: 0;
        padding-left: 18px;
        color: var(--text);
      }
      .packages-section h2 {
        margin: 0 0 10px;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--muted);
      }
      .packages-entry-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 8px;
      }
      .packages-entry-list li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        background: rgba(233, 239, 246, 0.46);
        border-radius: 10px;
      }
      .packages-chip-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .packages-chip {
        display: inline-flex;
        align-items: center;
        min-height: 28px;
        padding: 0 10px;
        border-radius: 999px;
        background: rgba(233, 239, 246, 0.7);
      }
      .packages-breadcrumbs {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 0 8px;
      }
      .packages-breadcrumbs a,
      .packages-pagination a {
        color: var(--primary);
        text-decoration: none;
      }
      .packages-crumb-sep {
        color: var(--muted);
      }
      .packages-tree-grid,
      .packages-commit-list {
        display: grid;
        gap: 8px;
      }
      .packages-tree-row,
      .packages-commit-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 10px;
        background: rgba(233, 239, 246, 0.46);
        color: inherit;
        text-decoration: none;
      }
      .packages-tree-row:hover,
      .packages-commit-row:hover {
        background: rgba(233, 239, 246, 0.7);
      }
      .packages-tree-row strong,
      .packages-commit-row strong {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .packages-tree-row span:last-child {
        color: var(--muted);
      }
      .packages-tree-icon {
        width: 18px;
        text-align: center;
        color: var(--primary-soft);
      }
      .packages-file-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .packages-code {
        margin: 0;
        white-space: pre-wrap;
        overflow: auto;
      }
      .packages-pagination {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding-top: 8px;
      }
      .packages-empty {
        padding: 16px;
        color: var(--muted);
      }
      @media (max-width: 980px) {
        .packages-import-form {
          grid-template-columns: 1fr;
        }
        .packages-shell {
          grid-template-columns: 1fr;
        }
        .packages-meta-grid {
          grid-template-columns: 1fr 1fr;
        }
        .packages-main-stage {
          padding: 10px 12px 12px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      ${renderImportRail(statusText, errorText, importSource, importRef, importSubdir)}
      <section class="packages-shell">
        <aside class="packages-sidebar">${renderSidebar(routeBase, packages, selectedPkg?.packageId ?? "")}</aside>
        ${renderMain(routeBase, selectedPkg, view, refs, browseRef, path, readResult, logResult, offset)}
      </section>
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
  let statusText = "";
  let errorText = "";
  let openChatProcess = null;
  let selectedPackageId = url.searchParams.get("packageId")?.trim() ?? "";
  let importSource = url.searchParams.get("source")?.trim() ?? "";
  let importRef = url.searchParams.get("ref")?.trim() ?? "main";
  let importSubdir = url.searchParams.get("subdir")?.trim() ?? ".";

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
        statusText = result.package.enabled
          ? `Imported and enabled ${result.package.name} from ${result.imported.repo}`
          : `Imported ${result.package.name} from ${result.imported.repo}. Review it before enabling.`;
      } else if (action === "install") {
        const result = await kernel.request("pkg.install", {
          packageId: String(form.get("packageId") ?? "").trim(),
        });
        selectedPackageId = result.package.packageId;
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
        });
        if (!spawned?.ok) {
          throw new Error(spawned?.error || "Failed to spawn review process");
        }
        selectedPackageId = target.packageId;
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
        statusText = result.changed
          ? `Approved review for ${result.package.name}`
          : `${result.package.name} was already approved`;
      } else if (action === "remove") {
        const result = await kernel.request("pkg.remove", {
          packageId: String(form.get("packageId") ?? "").trim(),
        });
        selectedPackageId = result.package.packageId;
        statusText = `Disabled ${result.package.name}`;
      } else if (action === "checkout") {
        const result = await kernel.request("pkg.checkout", {
          packageId: String(form.get("packageId") ?? "").trim(),
          ref: String(form.get("ref") ?? "").trim(),
        });
        selectedPackageId = result.package.packageId;
        statusText = `Switched ${result.package.name} to ${result.package.source?.ref ?? "main"}`;
      }
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
  }

  let packages = [];
  try {
    const result = await kernel.request("pkg.list", {});
    packages = Array.isArray(result?.packages) ? result.packages : [];
  } catch (error) {
    errorText = errorText || (error instanceof Error ? error.message : String(error));
  }

  const selectedPkg = pickSelectedPackage(packages, selectedPackageId);
  const view = ["overview", "code", "commits"].includes(url.searchParams.get("view") ?? "")
    ? url.searchParams.get("view")
    : "overview";
  const browseRef = url.searchParams.get("ref")?.trim() || selectedPkg?.source?.ref || "main";
  const path = normalizePath(url.searchParams.get("path") ?? "");
  const offset = clampOffset(url.searchParams.get("offset"));

  let refs = { heads: {}, tags: {} };
  let readResult = null;
  let logResult = { entries: [] };

  if (selectedPkg) {
    try {
      refs = await kernel.request("pkg.repo.refs", { packageId: selectedPkg.packageId });
    } catch (error) {
      errorText = errorText || (error instanceof Error ? error.message : String(error));
    }

    if (view === "code") {
      try {
        readResult = await kernel.request("pkg.repo.read", {
          packageId: selectedPkg.packageId,
          ref: browseRef,
          path,
        });
      } catch (error) {
        errorText = errorText || (error instanceof Error ? error.message : String(error));
        readResult = { kind: "tree", entries: [] };
      }
    }

    if (view === "commits") {
      try {
        logResult = await kernel.request("pkg.repo.log", {
          packageId: selectedPkg.packageId,
          ref: browseRef,
          limit: COMMIT_PAGE_SIZE,
          offset,
        });
      } catch (error) {
        errorText = errorText || (error instanceof Error ? error.message : String(error));
      }
    }
  }

  return new Response(renderPage({
    routeBase,
    packages,
    selectedPkg,
    view,
    browseRef,
    path,
    refs,
    readResult,
    logResult,
    offset,
    statusText,
    errorText,
    importSource,
    importRef,
    importSubdir,
    openChatProcess,
  }), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default { fetch: handleFetch };
