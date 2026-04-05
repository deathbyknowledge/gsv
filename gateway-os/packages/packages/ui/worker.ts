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
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: 14px;
        color: #1f2328;
        background: #ffffff;
        line-height: 1.5;
      }
      a { color: #0969da; text-decoration: none; }
      a:hover { text-decoration: underline; }
      header { border-bottom: 1px solid #d1d9e0; background: #ffffff; }
      .global-nav {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 44px;
        padding: 0 18px;
      }
      .logo { color: #1f2328; font-weight: 700; font-size: 15px; }
      .global-meta { display: flex; align-items: center; gap: 10px; color: #656d76; font-size: 12px; }
      .app-shell {
        min-height: calc(100vh - 45px);
        display: grid;
        grid-template-columns: 320px minmax(0, 1fr);
      }
      .sidebar {
        border-right: 1px solid #d1d9e0;
        background: #f6f8fa;
        padding: 16px;
        overflow: auto;
      }
      .sidebar h1 { margin: 0 0 6px; font-size: 20px; }
      .sidebar-copy { margin: 0 0 16px; color: #656d76; }
      .sidebar-stack { display: grid; gap: 12px; }
      .pkg-card {
        border: 1px solid #d1d9e0;
        border-radius: 8px;
        background: #ffffff;
        overflow: hidden;
      }
      .pkg-card.is-selected { border-color: #0969da; box-shadow: inset 0 0 0 1px #0969da; }
      .pkg-link { display: block; padding: 12px; color: inherit; text-decoration: none; }
      .pkg-link:hover { text-decoration: none; background: #f6f8fa; }
      .pkg-title-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .pkg-description { margin: 6px 0 0; color: #656d76; font-size: 13px; }
      .pkg-source { margin: 8px 0 0; color: #656d76; font-size: 12px; }
      .pkg-source-ref { color: #656d76; font-size: 12px; }
      .pkg-pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
      .pkg-pill {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        background: #ddf4ff;
        color: #1f2328;
        font-size: 12px;
      }
      .pkg-pill.is-enabled { background: #dafbe1; }
      .pkg-pill.is-disabled { background: #f6f8fa; color: #656d76; }
      .pkg-actions { padding: 0 12px 12px; }
      .pkg-action-note { margin: 0; color: #656d76; font-size: 12px; }
      .sidebar-empty, .empty-state { color: #656d76; }
      .btn {
        border: 1px solid #d1d9e0;
        background: #ffffff;
        color: #1f2328;
        border-radius: 6px;
        padding: 6px 12px;
        font: inherit;
        cursor: pointer;
      }
      .btn:hover { background: #f6f8fa; }
      .btn-danger { border-color: #cf222e; color: #cf222e; }
      .inline-form { margin: 0; }
      .repo-shell { min-width: 0; display: flex; flex-direction: column; }
      .repo-bar-wrap {
        border-bottom: 1px solid #d1d9e0;
        background: #f6f8fa;
      }
      .repo-bar {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 0 24px;
        min-height: 40px;
      }
      .repo-crumb { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
      .repo-tabs { display: flex; align-items: center; gap: 16px; margin-left: auto; }
      .repo-tabs a { color: #656d76; font-size: 13px; }
      .repo-tabs a.is-active { color: #1f2328; font-weight: 600; }
      .owner-name, .repo-name { color: #1f2328; font-weight: 600; }
      .sep { color: #656d76; }
      .repo-main { padding: 24px; max-width: 1100px; }
      .repo-meta {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 16px;
      }
      .repo-title { margin: 0; font-size: 24px; font-weight: 700; }
      .repo-subtitle { margin: 4px 0 0; color: #656d76; }
      .repo-meta-chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .meta-chip {
        display: inline-flex;
        align-items: center;
        padding: 4px 8px;
        border: 1px solid #d1d9e0;
        border-radius: 999px;
        background: #ffffff;
        color: #656d76;
        font-size: 12px;
      }
      .repo-breadcrumbs { margin-bottom: 16px; color: #656d76; }
      .crumb-sep { margin: 0 6px; color: #656d76; }
      .repo-controls {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 20px;
      }
      .ref-form { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
      .ref-form label { display: grid; gap: 6px; }
      .ref-form span { color: #656d76; font-size: 12px; }
      .ref-form select {
        min-width: 180px;
        border: 1px solid #d1d9e0;
        border-radius: 6px;
        background: #ffffff;
        color: #1f2328;
        padding: 6px 10px;
        font: inherit;
      }
      .repo-current-ref { color: #0969da; font-size: 12px; font-weight: 600; }
      .section-block {
        border: 1px solid #d1d9e0;
        border-radius: 6px;
        background: #ffffff;
        margin-bottom: 20px;
      }
      .section-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid #d1d9e0;
      }
      .section-title-row h1, .section-block h2 { margin: 0; font-size: 20px; }
      .section-block h2 { padding: 14px 16px 0; font-size: 16px; }
      .section-meta { color: #656d76; font-size: 12px; }
      .tree-table { width: 100%; border-collapse: collapse; }
      .tree-table td { padding: 8px 16px; border-top: 1px solid #d1d9e0; }
      .tree-table tr:first-child td { border-top: none; }
      .tree-icon { width: 32px; color: #656d76; }
      .tree-meta { width: 96px; color: #656d76; font-size: 12px; text-transform: lowercase; }
      .file-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 16px;
        background: #f6f8fa;
        border-bottom: 1px solid #d1d9e0;
      }
      .blob-pre {
        margin: 0;
        padding: 16px;
        overflow: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .binary-state { padding: 16px; color: #656d76; }
      .commit-list { list-style: none; margin: 0; padding: 0; }
      .commit-item {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 12px 16px;
        border-top: 1px solid #d1d9e0;
      }
      .commit-item:first-child { border-top: none; }
      .commit-hash {
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 12px;
        color: #0969da;
        background: #ddf4ff;
        border-radius: 4px;
        padding: 2px 6px;
      }
      .commit-msg { min-width: 0; }
      .commit-meta { margin-top: 4px; color: #656d76; font-size: 12px; }
      .pagination {
        display: flex;
        gap: 12px;
        padding: 16px;
        border-top: 1px solid #d1d9e0;
      }
      .status-line {
        margin: 0 24px 0;
        padding: 10px 12px;
        border-bottom: 1px solid #d1d9e0;
        background: #fff8c5;
        color: #1f2328;
      }
      .status-line.is-error { background: #ffebe9; }
      @media (max-width: 980px) {
        .app-shell { grid-template-columns: 1fr; }
        .sidebar { border-right: none; border-bottom: 1px solid #d1d9e0; }
        .repo-main { padding: 16px; }
        .repo-bar { padding: 0 16px; }
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
    if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
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
      routeBase,
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
