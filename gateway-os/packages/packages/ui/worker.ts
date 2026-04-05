export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};

const COMMIT_PAGE_SIZE = 30;

function escapeHtml(value) {
  return String(value)
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

function normalizeRoutePath(path) {
  const trimmed = String(path ?? "").trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function normalizePath(path) {
  return String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function clampOffset(raw) {
  const value = Number.parseInt(String(raw ?? "0"), 10);
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function formatTimestamp(unixSeconds) {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) {
    return "unknown";
  }
  return new Date(unixSeconds * 1000).toLocaleString();
}

function firstLine(message) {
  return String(message ?? "").split("\n")[0] || "No commit message";
}

function shortHash(hash) {
  return String(hash ?? "").slice(0, 7);
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

function renderPackageStatusPills(pkg) {
  return `
    <div class="pkg-pills">
      <span class="pkg-pill ${pkg.enabled ? "is-enabled" : "is-disabled"}">${pkg.enabled ? "enabled" : "disabled"}</span>
      <span class="pkg-pill">v${escapeHtml(pkg.version ?? "0")}</span>
      <span class="pkg-pill">${escapeHtml(pkg.runtime ?? "unknown")}</span>
    </div>`;
}

function renderPackageActions(pkg) {
  const packageId = escapeHtml(pkg.packageId ?? "");
  if (pkg.enabled) {
    if (pkg.name === "packages") {
      return '<p class="pkg-action-note">Core package</p>';
    }
    return `
      <form method="post" class="inline-form">
        <input type="hidden" name="action" value="remove" />
        <input type="hidden" name="packageId" value="${packageId}" />
        <button type="submit" class="btn btn-danger">Disable</button>
      </form>`;
  }
  return `
    <form method="post" class="inline-form">
      <input type="hidden" name="action" value="install" />
      <input type="hidden" name="packageId" value="${packageId}" />
      <button type="submit" class="btn">Enable</button>
    </form>`;
}

function renderSidebar(routeBase, packages, selectedPackageId) {
  if (!Array.isArray(packages) || packages.length === 0) {
    return '<p class="sidebar-empty">No packages installed.</p>';
  }

  return packages.map((pkg) => {
    const href = buildUrl(routeBase, {
      packageId: pkg.packageId,
      view: "code",
      ref: pkg.source?.ref ?? "main",
    });
    const selected = pkg.packageId === selectedPackageId;
    const sourceLabel = `${pkg.source?.repo ?? "unknown"}#${pkg.source?.ref ?? "main"}`;
    return `
      <article class="pkg-card ${selected ? "is-selected" : ""}">
        <a href="${escapeHtml(href)}" class="pkg-link">
          <div class="pkg-title-row">
            <strong>${escapeHtml(pkg.name ?? "package")}</strong>
            <span class="pkg-source-ref">${escapeHtml(pkg.source?.ref ?? "main")}</span>
          </div>
          <p class="pkg-description">${escapeHtml(pkg.description ?? "")}</p>
          ${renderPackageStatusPills(pkg)}
          <p class="pkg-source">${escapeHtml(sourceLabel)}</p>
        </a>
        <div class="pkg-actions">${renderPackageActions(pkg)}</div>
      </article>`;
  }).join("");
}

function renderRepoTabs(routeBase, pkg, ref, path, view) {
  const codeHref = buildUrl(routeBase, {
    packageId: pkg.packageId,
    view: "code",
    ref,
    path,
  });
  const commitsHref = buildUrl(routeBase, {
    packageId: pkg.packageId,
    view: "commits",
    ref,
  });
  return `
    <nav class="repo-tabs">
      <a href="${escapeHtml(codeHref)}" class="${view === "code" ? "is-active" : ""}">Code</a>
      <a href="${escapeHtml(commitsHref)}" class="${view === "commits" ? "is-active" : ""}">Commits</a>
    </nav>`;
}

function renderBreadcrumbs(routeBase, pkg, ref, path) {
  const segments = path ? path.split("/").filter(Boolean) : [];
  const crumbs = [
    `<a href="${escapeHtml(buildUrl(routeBase, { packageId: pkg.packageId, view: "code", ref }))}">${escapeHtml(pkg.name)}</a>`,
  ];
  for (let index = 0; index < segments.length; index += 1) {
    const crumbPath = segments.slice(0, index + 1).join("/");
    crumbs.push(`<span class="crumb-sep">/</span><a href="${escapeHtml(buildUrl(routeBase, { packageId: pkg.packageId, view: "code", ref, path: crumbPath }))}">${escapeHtml(segments[index])}</a>`);
  }
  return `<div class="repo-breadcrumbs">${crumbs.join("")}</div>`;
}

function renderRepoControls(routeBase, pkg, browseRef, path, view, refs) {
  const branches = Object.keys(refs?.heads ?? {}).sort();
  const currentRef = browseRef || pkg.source?.ref || "main";
  const checkoutButton = currentRef !== (pkg.source?.ref ?? "main")
    ? `
      <form method="post" class="ref-form inline-form">
        <input type="hidden" name="action" value="checkout" />
        <input type="hidden" name="packageId" value="${escapeHtml(pkg.packageId)}" />
        <input type="hidden" name="ref" value="${escapeHtml(currentRef)}" />
        <button type="submit" class="btn">Use this ref</button>
      </form>`
    : '<span class="repo-current-ref">Using active ref</span>';

  const branchOptions = branches.length > 0
    ? branches.map((branch) => {
        const selected = branch === currentRef ? ' selected' : '';
        return `<option value="${escapeHtml(branch)}"${selected}>${escapeHtml(branch)}</option>`;
      }).join("")
    : `<option value="${escapeHtml(currentRef)}">${escapeHtml(currentRef)}</option>`;

  return `
    <section class="repo-controls">
      <form method="get" class="ref-form">
        <input type="hidden" name="packageId" value="${escapeHtml(pkg.packageId)}" />
        <input type="hidden" name="view" value="${escapeHtml(view)}" />
        ${path ? `<input type="hidden" name="path" value="${escapeHtml(path)}" />` : ""}
        <label>
          <span>browse ref</span>
          <select name="ref">${branchOptions}</select>
        </label>
        <button type="submit" class="btn">Browse</button>
      </form>
      ${checkoutButton}
    </section>`;
}

function renderCommitList(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '<p class="empty-state">No commits yet.</p>';
  }
  return `
    <ul class="commit-list">
      ${entries.map((entry) => `
        <li class="commit-item">
          <span class="commit-hash">${escapeHtml(shortHash(entry.hash))}</span>
          <div class="commit-msg">
            <strong>${escapeHtml(firstLine(entry.message))}</strong>
            <div class="commit-meta">${escapeHtml(entry.author)} · ${escapeHtml(formatTimestamp(entry.commitTime))}</div>
          </div>
        </li>`).join("")}
    </ul>`;
}

function renderTreeView(routeBase, pkg, ref, path, readResult, recentLog) {
  const rows = [];
  if (path) {
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    rows.push(`
      <tr>
        <td class="tree-icon">↩</td>
        <td class="tree-name"><a href="${escapeHtml(buildUrl(routeBase, { packageId: pkg.packageId, view: "code", ref, path: parentPath }))}">..</a></td>
        <td class="tree-meta">parent</td>
      </tr>`);
  }
  for (const entry of readResult.entries) {
    const href = buildUrl(routeBase, {
      packageId: pkg.packageId,
      view: "code",
      ref,
      path: entry.path,
    });
    rows.push(`
      <tr>
        <td class="tree-icon">${entry.type === "tree" ? "📁" : entry.type === "symlink" ? "↗" : "📄"}</td>
        <td class="tree-name"><a href="${escapeHtml(href)}">${escapeHtml(entry.name)}</a></td>
        <td class="tree-meta">${escapeHtml(entry.type)}</td>
      </tr>`);
  }

  const recentSection = recentLog && Array.isArray(recentLog.entries) && recentLog.entries.length > 0
    ? `
      <section class="section-block">
        <h2>Recent commits</h2>
        ${renderCommitList(recentLog.entries)}
      </section>`
    : "";

  return `
    <section class="section-block">
      <div class="section-title-row">
        <h1>${escapeHtml(path || "/")}</h1>
        <span class="section-meta">${readResult.entries.length} entries</span>
      </div>
      <table class="tree-table">
        <tbody>${rows.join("")}</tbody>
      </table>
    </section>
    ${recentSection}`;
}

function renderFileView(path, readResult) {
  return `
    <section class="section-block">
      <div class="file-header">
        <strong>${escapeHtml(path || "/")}</strong>
        <span class="section-meta">${escapeHtml(String(readResult.size ?? 0))} bytes</span>
      </div>
      ${readResult.isBinary
        ? '<div class="binary-state">Binary file. Text preview is intentionally omitted.</div>'
        : `<pre class="blob-pre">${escapeHtml(readResult.content ?? "")}</pre>`}
    </section>`;
}

function renderCommitsView(routeBase, pkg, ref, offset, logResult) {
  const prevHref = offset > 0
    ? buildUrl(routeBase, {
        packageId: pkg.packageId,
        view: "commits",
        ref,
        offset: Math.max(0, offset - COMMIT_PAGE_SIZE),
      })
    : null;
  const nextHref = Array.isArray(logResult.entries) && logResult.entries.length === COMMIT_PAGE_SIZE
    ? buildUrl(routeBase, {
        packageId: pkg.packageId,
        view: "commits",
        ref,
        offset: offset + COMMIT_PAGE_SIZE,
      })
    : null;

  return `
    <section class="section-block">
      <div class="section-title-row">
        <h1>Commits on ${escapeHtml(ref)}</h1>
        <span class="section-meta">offset ${escapeHtml(String(offset))}</span>
      </div>
      ${renderCommitList(logResult.entries)}
      <div class="pagination">
        ${prevHref ? `<a href="${escapeHtml(prevHref)}">Previous</a>` : ""}
        ${nextHref ? `<a href="${escapeHtml(nextHref)}">Next</a>` : ""}
      </div>
    </section>`;
}

function renderRepoView(routeBase, pkg, refs, ref, view, path, repoState) {
  const activeRef = pkg.source?.ref ?? "main";
  const resolvedCommit = pkg.source?.resolvedCommit ? `<span class="meta-chip">resolved ${escapeHtml(shortHash(pkg.source.resolvedCommit))}</span>` : "";
  const repoLabel = escapeHtml(pkg.source?.repo ?? "unknown");
  const content = view === "commits"
    ? renderCommitsView(routeBase, pkg, ref, repoState.offset, repoState.log)
    : repoState.read.kind === "tree"
      ? renderTreeView(routeBase, pkg, ref, path, repoState.read, repoState.recentLog)
      : renderFileView(path, repoState.read);

  return `
    <section class="repo-shell">
      <div class="repo-bar-wrap">
        <div class="repo-bar">
          <div class="repo-crumb">
            <span class="owner-name">${repoLabel}</span>
            <span class="sep">#</span>
            <span class="repo-name">${escapeHtml(ref)}</span>
          </div>
          ${renderRepoTabs(routeBase, pkg, ref, path, view)}
        </div>
      </div>
      <main class="repo-main">
        <section class="repo-meta">
          <div>
            <p class="repo-title">${escapeHtml(pkg.name)}</p>
            <p class="repo-subtitle">${escapeHtml(pkg.description ?? "")}</p>
          </div>
          <div class="repo-meta-chips">
            <span class="meta-chip">active ${escapeHtml(activeRef)}</span>
            ${resolvedCommit}
          </div>
        </section>
        ${renderBreadcrumbs(routeBase, pkg, ref, path)}
        ${renderRepoControls(routeBase, pkg, ref, path, view, refs)}
        ${content}
      </main>
    </section>`;
}

function renderPage({ frame, packageDoName, packages, selectedPackage, selectedRef, selectedView, selectedPath, statusText, loadError, routeBase, repoRefs, repoState }) {
  const sidebar = renderSidebar(routeBase, packages, selectedPackage?.packageId ?? null);
  const mainContent = selectedPackage
    ? renderRepoView(routeBase, selectedPackage, repoRefs, selectedRef, selectedView, selectedPath, repoState)
    : '<section class="repo-shell"><main class="repo-main"><p class="empty-state">No package selected.</p></main></section>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Packages</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: #eef3f7;
        --surface: #f7f9fc;
        --surface-low: #f1f5f8;
        --surface-high: #ffffff;
        --surface-tint: #e8eef3;
        --text: #191c1e;
        --text-muted: rgba(25, 28, 30, 0.66);
        --text-soft: rgba(25, 28, 30, 0.5);
        --primary: #003466;
        --primary-soft: #1a4b84;
        --secondary: #904b36;
        --focus: rgba(0, 52, 102, 0.14);
        --shadow-soft: 0 20px 40px rgba(25, 28, 30, 0.06), 0 10px 10px rgba(25, 28, 30, 0.04);
        --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        --ui: "Manrope", "Segoe UI", sans-serif;
        --display: "Space Grotesk", "Avenir Next", sans-serif;
      }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        font-family: var(--ui);
        font-size: 14px;
        line-height: 1.55;
        color: var(--text);
        background:
          radial-gradient(circle at 16% 0%, rgba(255, 255, 255, 0.82) 0%, rgba(255, 255, 255, 0) 34%),
          linear-gradient(180deg, #f4f7fa 0%, var(--bg) 100%);
      }
      a {
        color: var(--primary);
        text-decoration: none;
      }
      a:hover { text-decoration: none; }
      header {
        background: transparent;
      }
      .global-nav {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 20px 24px 12px;
      }
      .logo {
        color: var(--text);
        font-family: var(--display);
        font-weight: 700;
        font-size: 0.78rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .global-meta {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--text-soft);
        font-size: 12px;
      }
      .global-meta code {
        font-family: var(--mono);
        background: rgba(255, 255, 255, 0.62);
        padding: 3px 7px;
        border-radius: 999px;
      }
      .app-shell {
        min-height: calc(100vh - 64px);
        display: grid;
        grid-template-columns: 320px minmax(0, 1fr);
        gap: 18px;
        padding: 0 18px 18px;
      }
      .sidebar,
      .repo-shell {
        min-width: 0;
        background: rgba(247, 249, 252, 0.86);
        border-radius: 18px;
        box-shadow: var(--shadow-soft);
      }
      .sidebar {
        padding: 22px 18px 18px;
        overflow: auto;
      }
      .sidebar h1 {
        margin: 0 0 8px;
        font-family: var(--display);
        font-size: clamp(1.8rem, 3vw, 2.3rem);
        line-height: 1;
        letter-spacing: -0.03em;
      }
      .sidebar-copy {
        margin: 0 0 18px;
        max-width: 28ch;
        color: var(--text-muted);
      }
      .sidebar-stack { display: grid; gap: 12px; }
      .pkg-card {
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.7);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
        overflow: hidden;
        transition: transform 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
      }
      .pkg-card.is-selected {
        background: var(--surface-high);
        box-shadow:
          0 14px 28px rgba(25, 28, 30, 0.08),
          inset 0 1px 0 rgba(255, 255, 255, 0.72);
        transform: translateY(-1px);
      }
      .pkg-link {
        display: block;
        padding: 14px 14px 10px;
        color: inherit;
        text-decoration: none;
      }
      .pkg-link:hover { text-decoration: none; }
      .pkg-title-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }
      .pkg-title-row strong {
        font-size: 0.95rem;
        font-weight: 700;
      }
      .pkg-description {
        margin: 7px 0 0;
        color: var(--text-muted);
        font-size: 13px;
      }
      .pkg-source {
        margin: 10px 0 0;
        color: var(--text-soft);
        font-size: 12px;
      }
      .pkg-source-ref {
        color: var(--text-soft);
        font-size: 11px;
        font-family: var(--mono);
      }
      .pkg-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 12px 0 0;
      }
      .pkg-pill {
        display: inline-flex;
        align-items: center;
        padding: 4px 9px;
        border-radius: 999px;
        background: rgba(232, 238, 243, 0.92);
        color: rgba(25, 28, 30, 0.78);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .pkg-pill.is-enabled {
        background: rgba(218, 235, 225, 0.92);
        color: #29533e;
      }
      .pkg-pill.is-disabled {
        background: rgba(240, 243, 246, 0.92);
        color: rgba(25, 28, 30, 0.54);
      }
      .pkg-actions { padding: 0 14px 14px; }
      .pkg-action-note,
      .sidebar-empty,
      .empty-state,
      .binary-state {
        margin: 0;
        color: var(--text-muted);
      }
      .btn {
        border: 0;
        background: rgba(232, 238, 243, 0.9);
        color: var(--text);
        border-radius: 8px;
        padding: 9px 14px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        transition: transform 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
      }
      .btn:hover {
        background: rgba(225, 233, 239, 1);
        transform: translateY(-1px);
      }
      .btn-danger {
        background: rgba(144, 75, 54, 0.12);
        color: var(--secondary);
      }
      .inline-form { margin: 0; }
      .repo-shell {
        display: flex;
        flex-direction: column;
        padding: 16px;
      }
      .repo-bar-wrap {
        margin-bottom: 18px;
      }
      .repo-bar {
        display: flex;
        align-items: center;
        gap: 16px;
        justify-content: space-between;
        flex-wrap: wrap;
        padding: 14px 18px;
        border-radius: 16px;
        background: var(--surface-low);
      }
      .repo-crumb {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .repo-tabs {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .repo-tabs a {
        color: var(--text-muted);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding: 6px 10px;
        border-radius: 999px;
      }
      .repo-tabs a.is-active {
        color: var(--primary);
        background: rgba(0, 52, 102, 0.08);
      }
      .owner-name,
      .repo-name {
        color: var(--text);
        font-weight: 700;
      }
      .sep { color: var(--text-soft); }
      .repo-main {
        padding: 0 4px 4px;
      }
      .repo-meta {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 18px;
      }
      .repo-title {
        margin: 0;
        font-family: var(--display);
        font-size: clamp(2rem, 3vw, 2.6rem);
        font-weight: 700;
        letter-spacing: -0.04em;
        line-height: 0.95;
      }
      .repo-subtitle {
        margin: 8px 0 0;
        max-width: 54ch;
        color: var(--text-muted);
      }
      .repo-meta-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .meta-chip {
        display: inline-flex;
        align-items: center;
        padding: 5px 9px;
        border-radius: 999px;
        background: rgba(232, 238, 243, 0.92);
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .repo-breadcrumbs {
        margin-bottom: 16px;
        color: var(--text-soft);
        font-size: 13px;
      }
      .crumb-sep { margin: 0 6px; color: var(--text-soft); }
      .repo-controls {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 20px;
        padding: 14px 16px;
        border-radius: 16px;
        background: var(--surface-low);
      }
      .ref-form {
        display: flex;
        align-items: flex-end;
        gap: 8px;
        flex-wrap: wrap;
      }
      .ref-form label {
        display: grid;
        gap: 6px;
      }
      .ref-form span {
        color: var(--text-soft);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .ref-form select {
        min-width: 180px;
        border: 0;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.88);
        color: var(--text);
        padding: 10px 12px;
        font: inherit;
      }
      .repo-current-ref {
        color: var(--primary);
        font-size: 12px;
        font-weight: 700;
      }
      .section-block {
        background: var(--surface-low);
        border-radius: 18px;
        margin-bottom: 20px;
        padding: 8px;
      }
      .section-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px 10px;
      }
      .section-title-row h1,
      .section-block h2 {
        margin: 0;
        font-family: var(--display);
        letter-spacing: -0.03em;
      }
      .section-title-row h1 { font-size: 1.3rem; }
      .section-block h2 {
        padding: 12px 14px 0;
        font-size: 1rem;
      }
      .section-meta {
        color: var(--text-soft);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .tree-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0 8px;
      }
      .tree-table td {
        padding: 10px 14px;
        background: var(--surface-high);
      }
      .tree-table td:first-child {
        border-radius: 12px 0 0 12px;
      }
      .tree-table td:last-child {
        border-radius: 0 12px 12px 0;
      }
      .tree-icon {
        width: 40px;
        color: var(--text-soft);
      }
      .tree-meta {
        width: 96px;
        color: var(--text-soft);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .file-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: var(--surface-high);
        border-radius: 12px 12px 0 0;
      }
      .blob-pre {
        margin: 0;
        padding: 16px;
        overflow: auto;
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        background: var(--surface-high);
        border-radius: 0 0 12px 12px;
      }
      .binary-state {
        padding: 16px;
        background: var(--surface-high);
        border-radius: 0 0 12px 12px;
      }
      .commit-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 8px;
      }
      .commit-item {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 12px 14px;
        background: var(--surface-high);
        border-radius: 12px;
      }
      .commit-hash {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--primary);
        background: rgba(0, 52, 102, 0.08);
        border-radius: 999px;
        padding: 4px 8px;
      }
      .commit-msg { min-width: 0; }
      .commit-meta {
        margin-top: 4px;
        color: var(--text-soft);
        font-size: 12px;
      }
      .pagination {
        display: flex;
        gap: 12px;
        padding: 8px 6px 4px;
      }
      .status-line {
        margin: 0 18px 16px;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(0, 52, 102, 0.08);
        color: var(--text);
      }
      .status-line p { margin: 0; }
      .status-line.is-error {
        background: rgba(144, 75, 54, 0.12);
        color: #6f3929;
      }
      @media (max-width: 980px) {
        .global-nav {
          padding: 16px 16px 10px;
        }
        .app-shell {
          grid-template-columns: 1fr;
          gap: 14px;
          padding: 0 12px 12px;
        }
        .sidebar,
        .repo-shell {
          border-radius: 16px;
        }
        .repo-bar,
        .repo-controls {
          padding: 12px;
        }
        .repo-meta {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="global-nav">
        <a href="${escapeHtml(routeBase)}" class="logo">packages</a>
        <div class="global-meta">
          <span>${escapeHtml(frame.username)}</span>
          <span>•</span>
          <code>${escapeHtml(packageDoName)}</code>
        </div>
      </div>
    </header>
    ${statusText ? `<div class="status-line"><p>${escapeHtml(statusText)}</p></div>` : ""}
    ${loadError ? `<div class="status-line is-error"><p>${escapeHtml(loadError)}</p></div>` : ""}
    <div class="app-shell">
      <aside class="sidebar">
        <h1>Packages</h1>
        <p class="sidebar-copy">Private repo browser and package control plane, served through the gateway instead of exposing ripgit directly.</p>
        <div class="sidebar-stack">${sidebar}</div>
      </aside>
      ${mainContent}
    </div>
  </body>
</html>`;
}

 
    const appFrame = props.appFrame;
    const packageDoName = props.packageDoName;
    const kernel = props.kernel;
    if (!appFrame || !packageDoName || !kernel) {
      return new Response("App frame missing", { status: 500 });
    }

    const url = new URL(request.url);
    const routeBase = appFrame.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/packages";
    const linkRouteBase = typeof url.searchParams.get("windowId") === "string" && url.searchParams.get("windowId")?.trim()
      ? buildUrl(routeBase, { windowId: url.searchParams.get("windowId")?.trim() })
      : routeBase;
    if (normalizeRoutePath(url.pathname) !== normalizeRoutePath(routeBase)) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let statusText = "";
    let loadError = "";

    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const action = String(formData.get("action") ?? "").trim();
        const packageId = String(formData.get("packageId") ?? "").trim();
        if (!packageId) {
          throw new Error("packageId is required");
        }
        if (action === "install") {
          const result = await kernel.request("pkg.install", { packageId });
          statusText = result?.changed
            ? `Enabled ${result.package?.name ?? packageId}`
            : `${result.package?.name ?? packageId} was already enabled`;
        } else if (action === "remove") {
          const result = await kernel.request("pkg.remove", { packageId });
          statusText = result?.changed
            ? `Disabled ${result.package?.name ?? packageId}`
            : `${result.package?.name ?? packageId} was already disabled`;
        } else if (action === "checkout") {
          const ref = String(formData.get("ref") ?? "").trim();
          const result = await kernel.request("pkg.checkout", { packageId, ref });
          statusText = result?.changed
            ? `Switched ${result.package?.name ?? packageId} to ${result.package?.source?.ref ?? ref}`
            : `${result.package?.name ?? packageId} is already using ${result.package?.source?.ref ?? ref}`;
        } else {
          throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        loadError = error instanceof Error ? error.message : String(error);
      }
    }

    let packages = [];
    let selectedPackage = null;
    let repoRefs = { heads: {}, tags: {}, activeRef: "main" };
    let repoState = {
      offset: 0,
      log: { entries: [] },
      recentLog: { entries: [] },
      read: { kind: "tree", entries: [] },
    };

    try {
      const listing = await kernel.request("pkg.list", {});
      packages = Array.isArray(listing?.packages) ? listing.packages : [];
      selectedPackage = pickSelectedPackage(packages, url.searchParams.get("packageId"));
      if (selectedPackage) {
        const selectedRef = url.searchParams.get("ref")?.trim() || selectedPackage.source?.ref || "main";
        const selectedView = url.searchParams.get("view") === "commits" ? "commits" : "code";
        const selectedPath = normalizePath(url.searchParams.get("path"));
        const offset = clampOffset(url.searchParams.get("offset"));
        repoRefs = await kernel.request("pkg.repo.refs", { packageId: selectedPackage.packageId });
        if (selectedView === "commits") {
          repoState = {
            offset,
            log: await kernel.request("pkg.repo.log", {
              packageId: selectedPackage.packageId,
              ref: selectedRef,
              limit: COMMIT_PAGE_SIZE,
              offset,
            }),
            recentLog: { entries: [] },
            read: { kind: "tree", entries: [] },
          };
        } else {
          const read = await kernel.request("pkg.repo.read", {
            packageId: selectedPackage.packageId,
            ref: selectedRef,
            path: selectedPath,
          });
          repoState = {
            offset,
            log: { entries: [] },
            recentLog: read.kind === "tree"
              ? await kernel.request("pkg.repo.log", {
                  packageId: selectedPackage.packageId,
                  ref: selectedRef,
                  limit: 8,
                  offset: 0,
                })
              : { entries: [] },
            read,
          };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      loadError = loadError ? `${loadError} ${message}` : message;
    }

    const selectedRef = selectedPackage
      ? (url.searchParams.get("ref")?.trim() || selectedPackage.source?.ref || repoRefs.activeRef || "main")
      : "main";
    const selectedView = url.searchParams.get("view") === "commits" ? "commits" : "code";
    const selectedPath = normalizePath(url.searchParams.get("path"));

    return new Response(renderPage({
      frame: appFrame,
      packageDoName,
      packages,
      selectedPackage,
      selectedRef,
      selectedView,
      selectedPath,
      statusText,
      loadError,
      routeBase: linkRouteBase,
      repoRefs,
      repoState,
    }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
}

export default { fetch: handleFetch };
