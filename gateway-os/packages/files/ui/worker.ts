export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function detectPathStyle(path) {
  return String(path ?? "").trim().startsWith("/") ? "absolute" : "relative";
}

function normalizeTarget(target) {
  const value = String(target ?? "").trim();
  return value.length > 0 ? value : "gsv";
}

function defaultPathForTarget(target) {
  return normalizeTarget(target) === "gsv" ? "/" : ".";
}

function normalizePath(input, style = detectPathStyle(input)) {
  const raw = String(input ?? "").replaceAll("\\", "/").trim();
  const normalized = [];

  for (const part of raw.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  if (style === "absolute") {
    return normalized.length > 0 ? `/${normalized.join("/")}` : "/";
  }
  return normalized.length > 0 ? normalized.join("/") : ".";
}

function resolvePath(input, cwd, style) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return cwd;
  }
  if (raw.startsWith("/")) {
    return normalizePath(raw, "absolute");
  }

  const base = normalizePath(cwd, style);
  if (style === "absolute") {
    const prefix = base === "/" ? "/" : `${base}/`;
    return normalizePath(`${prefix}${raw}`, "absolute");
  }
  const prefix = base === "." ? "" : `${base}/`;
  return normalizePath(`${prefix}${raw}`, "relative");
}

function parentPath(path, style) {
  const normalized = normalizePath(path, style);
  if (style === "absolute") {
    if (normalized === "/") {
      return "/";
    }
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  if (normalized === ".") {
    return ".";
  }

  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? parts.join("/") : ".";
}

function joinPath(base, child, style) {
  return resolvePath(child, base, style);
}

function withTarget(target, args) {
  const normalizedTarget = normalizeTarget(target);
  if (normalizedTarget === "gsv") {
    return args;
  }
  return { ...args, target: normalizedTarget };
}

function decodeNumberedText(content) {
  return String(content ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}

function formatBytes(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function isDirectoryResult(value) {
  return value && value.ok === true && Array.isArray(value.files) && Array.isArray(value.directories);
}

function isFileResult(value) {
  return value && value.ok === true && "content" in value;
}

function renderTargetOptions(target, devices) {
  const normalizedTarget = normalizeTarget(target);
  const options = [
    `<option value="gsv"${normalizedTarget === "gsv" ? " selected" : ""}>gsv</option>`,
  ];

  for (const device of devices) {
    const deviceId = String(device?.deviceId ?? "").trim();
    if (!deviceId) {
      continue;
    }
    const label = device?.platform
      ? `${deviceId} (${device.platform}${device.online === false ? ", offline" : ""})`
      : deviceId;
    options.push(
      `<option value="${escapeHtml(deviceId)}"${normalizedTarget === deviceId ? " selected" : ""}>${escapeHtml(label)}</option>`,
    );
  }

  return options.join("");
}

function renderEntries(routeBase, target, currentPath, pathStyle, result, selectedPath = currentPath) {
  const directories = Array.isArray(result?.directories) ? result.directories : [];
  const files = Array.isArray(result?.files) ? result.files : [];
  const parent = parentPath(currentPath, pathStyle);
  const items = [];

  if (!((pathStyle === "absolute" && currentPath === "/") || (pathStyle === "relative" && currentPath === "."))) {
    items.push(`
      <li>
        <a href="${routeBase}?target=${encodeURIComponent(target)}&path=${encodeURIComponent(parent)}" class="entry-link">
          <span class="entry-icon">..</span>
          <span>Parent directory</span>
        </a>
      </li>`);
  }

  for (const name of directories) {
    const nextPath = joinPath(currentPath, name, pathStyle);
    items.push(`
      <li>
        <a href="${routeBase}?target=${encodeURIComponent(target)}&path=${encodeURIComponent(nextPath)}" class="entry-link${nextPath === selectedPath ? " is-active" : ""}">
          <span class="entry-icon">DIR</span>
          <span>${escapeHtml(name)}</span>
        </a>
      </li>`);
  }

  for (const name of files) {
    const nextPath = joinPath(currentPath, name, pathStyle);
    items.push(`
      <li>
        <a href="${routeBase}?target=${encodeURIComponent(target)}&path=${encodeURIComponent(nextPath)}" class="entry-link${nextPath === selectedPath ? " is-active" : ""}">
          <span class="entry-icon">FILE</span>
          <span>${escapeHtml(name)}</span>
        </a>
      </li>`);
  }

  if (items.length === 0) {
    return "<p class=\"muted\">Directory is empty.</p>";
  }

  return `<ul class="entry-list">${items.join("")}</ul>`;
}

function renderImageContent(contentItems) {
  const blocks = [];
  for (const item of contentItems) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "text") {
      blocks.push(`<pre>${escapeHtml(item.text ?? "")}</pre>`);
      continue;
    }
    if (item.type === "image") {
      blocks.push(
        `<img class="image-preview" alt="File preview" src="data:${escapeHtml(item.mimeType ?? "image/png")};base64,${escapeHtml(item.data ?? "")}" />`,
      );
    }
  }
  return blocks.join("");
}

function renderFile(routeBase, target, currentPath, result) {
  const content = result.content;
  const sizeLabel = formatBytes(result.size);

  if (Array.isArray(content)) {
    return `
      <section class="panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Image preview</p>
            <h2>${escapeHtml(currentPath)}</h2>
            <p class="muted">${escapeHtml(sizeLabel)}</p>
          </div>
          <form method="post" class="inline-form">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="target" value="${escapeHtml(target)}" />
            <input type="hidden" name="path" value="${escapeHtml(currentPath)}" />
            <button type="submit" class="app-action is-danger">Delete</button>
          </form>
        </div>
        ${renderImageContent(content)}
      </section>`;
  }

  const decoded = decodeNumberedText(content);
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">File editor</p>
          <h2>${escapeHtml(currentPath)}</h2>
          <p class="muted">${escapeHtml(sizeLabel)}</p>
        </div>
        <form method="post" class="inline-form">
          <input type="hidden" name="action" value="delete" />
          <input type="hidden" name="target" value="${escapeHtml(target)}" />
          <input type="hidden" name="path" value="${escapeHtml(currentPath)}" />
          <button type="submit" class="app-action is-danger">Delete</button>
        </form>
      </div>
      <form method="post" class="editor-form">
        <input type="hidden" name="action" value="save" />
        <input type="hidden" name="target" value="${escapeHtml(target)}" />
        <input type="hidden" name="path" value="${escapeHtml(currentPath)}" />
        <textarea name="content" spellcheck="false">${escapeHtml(decoded)}</textarea>
        <button type="submit" class="app-action">Save</button>
      </form>
    </section>`;
}

function renderSearchResults(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return "<p class=\"muted\">No matches found.</p>";
  }

  return `<ul class="search-list">${matches.map((match) => `
    <li>
      <p><strong>${escapeHtml(match.path ?? "")}</strong><span class="muted"> line ${escapeHtml(match.line ?? "?")}</span></p>
      <pre>${escapeHtml(match.content ?? "")}</pre>
    </li>`).join("")}</ul>`;
}

function renderDirectoryOverview(currentPath, result) {
  const directories = Array.isArray(result?.directories) ? result.directories : [];
  const files = Array.isArray(result?.files) ? result.files : [];
  return `
    <section class="panel content-panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">Directory</p>
          <h2>${escapeHtml(currentPath)}</h2>
          <p class="muted">${directories.length} folders · ${files.length} files</p>
        </div>
      </div>
      <div class="directory-overview">
        <article class="overview-card">
          <h3>Navigator</h3>
          <p class="muted">Browse files and folders from the left. Open a file to edit or preview it here.</p>
        </article>
        <article class="overview-card">
          <h3>Current location</h3>
          <p class="muted"><code>${escapeHtml(currentPath)}</code></p>
        </article>
      </div>
    </section>`;
}

function renderSidebar(routeBase, target, devices, currentPath, pathStyle, searchQuery, navigator) {
  return `
    <aside class="panel sidebar">
      <div class="sidebar-head">
        <p class="eyebrow">Workspace files</p>
        <h1>Files</h1>
        <p class="muted">Browse target storage, search within the current path, and edit files in place.</p>
      </div>

      <div class="sidebar-section">
        <form method="get" class="sidebar-form">
          <label class="field">
            <span class="muted">Target</span>
            <select name="target">${renderTargetOptions(target, devices)}</select>
          </label>
          <label class="field">
            <span class="muted">Path</span>
            <input type="text" name="path" value="${escapeHtml(currentPath)}" />
          </label>
          <button type="submit" class="app-action">Open</button>
        </form>
      </div>

      <div class="sidebar-section">
        <form method="get" class="sidebar-form">
          <input type="hidden" name="target" value="${escapeHtml(target)}" />
          <input type="hidden" name="path" value="${escapeHtml(currentPath)}" />
          <label class="field">
            <span class="muted">Search</span>
            <input type="text" name="q" value="${escapeHtml(searchQuery)}" />
          </label>
          <button type="submit" class="app-action">Search</button>
        </form>
      </div>

      <div class="sidebar-section sidebar-nav">
        <div class="sidebar-nav-head">
          <p class="eyebrow">Navigator</p>
          <p class="muted"><code>${escapeHtml(navigator?.path ?? currentPath)}</code></p>
        </div>
        ${navigator ? renderEntries(routeBase, target, navigator.path, navigator.pathStyle, navigator.result, currentPath) : '<p class="muted">No directory context available.</p>'}
      </div>
    </aside>`;
}

function renderPage(input) {
  const {
    routeBase,
    target,
    devices,
    currentPath,
    pathStyle,
    statusText,
    errorText,
    searchQuery,
    navigator,
    view,
  } = input;

  let mainContent = "";
  if (view.kind === "directory") {
    mainContent = renderDirectoryOverview(currentPath, view.result);
  } else if (view.kind === "file") {
    mainContent = renderFile(routeBase, target, currentPath, view.result);
  } else if (view.kind === "search") {
    mainContent = `
      <section class="panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Search</p>
            <h2>${escapeHtml(currentPath)}</h2>
            <p class="muted">query ${escapeHtml(searchQuery)}</p>
          </div>
          <a class="app-action link-action" href="${routeBase}?target=${encodeURIComponent(target)}&path=${encodeURIComponent(currentPath)}">Clear search</a>
        </div>
        ${renderSearchResults(view.result.matches)}
      </section>`;
  } else {
    mainContent = `
      <section class="panel error-panel">
        <p>${escapeHtml(view.error)}</p>
      </section>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Files</title>
    <style>
      :root {
        color-scheme: light;
        --page: #ece7df;
        --surface: rgba(248, 244, 237, 0.94);
        --surface-soft: rgba(241, 235, 226, 0.96);
        --surface-muted: rgba(228, 220, 208, 0.9);
        --text: #191c1e;
        --text-muted: rgba(25, 28, 30, 0.64);
        --text-soft: rgba(25, 28, 30, 0.48);
        --primary: #003466;
        --primary-soft: #1a4b84;
        --accent: #904b36;
        --danger: #8a3b3b;
        --danger-soft: rgba(255, 232, 230, 0.95);
        --notice-soft: rgba(241, 231, 220, 0.95);
        --shadow: 0 18px 36px rgba(25, 28, 30, 0.06), 0 8px 16px rgba(25, 28, 30, 0.04);
        --display: "Space Grotesk", "Avenir Next", sans-serif;
        --ui: "Manrope", "Segoe UI", sans-serif;
        --mono: "IBM Plex Mono", "SFMono-Regular", monospace;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 14px/1.55 var(--ui);
        color: var(--text);
        background:
          radial-gradient(circle at 12% 0%, rgba(255, 255, 255, 0.86) 0%, rgba(255, 255, 255, 0) 30%),
          linear-gradient(180deg, #f6f8fb 0%, var(--page) 100%);
      }
      h1, h2, h3, p { margin: 0; }
      h1, h2 { font-family: var(--display); letter-spacing: -0.04em; }
      h1 { font-size: clamp(2rem, 4vw, 3.1rem); line-height: 0.94; }
      h2 { font-size: 1.8rem; line-height: 0.96; }
      main { min-height: 100vh; padding: 22px; display: grid; }
      .files-shell { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; align-items: start; }
      .panel { background: var(--surface); border-radius: 20px; box-shadow: var(--shadow); padding: 18px; }
      .sidebar { display: grid; gap: 16px; position: sticky; top: 22px; }
      .sidebar-head { display: grid; gap: 8px; }
      .sidebar-section { display: grid; gap: 12px; }
      .sidebar-form { display: grid; gap: 12px; }
      .sidebar-nav { min-height: 0; }
      .sidebar-nav-head { display: grid; gap: 6px; }
      .eyebrow { text-transform: uppercase; letter-spacing: 0.12em; font-size: 11px; font-weight: 800; color: var(--text-soft); }
      .muted { color: var(--text-muted); }
      .field { display: grid; gap: 6px; }
      .field input, .field select, .editor-form textarea {
        border: 0;
        background: rgba(255, 255, 255, 0.7);
        color: var(--text);
        border-radius: 10px;
        padding: 10px 12px;
        font: inherit;
        outline: none;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
      }
      .field input:focus, .field select:focus, .editor-form textarea:focus { box-shadow: inset 3px 0 0 rgba(0, 52, 102, 0.45); }
      .app-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
        border: 0;
        background: rgba(228, 220, 208, 0.92);
        color: var(--text);
        border-radius: 10px;
        padding: 10px 14px;
        font: inherit;
        font-weight: 700;
      }
      .app-action.is-danger { background: var(--danger-soft); color: var(--danger); }
      .content-stack { display: grid; gap: 14px; }
      .status-line { padding: 14px 16px; border-radius: 16px; background: var(--notice-soft); }
      .status-line.is-error, .error-panel { background: var(--danger-soft); color: var(--danger); }
      .content-panel { min-width: 0; }
      .panel-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: start; justify-content: space-between; margin-bottom: 16px; }
      .inline-form { margin: 0; }
      .entry-list, .search-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
      .entry-link {
        display: grid;
        grid-template-columns: 56px 1fr;
        gap: 12px;
        align-items: center;
        text-decoration: none;
        color: inherit;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(255, 250, 245, 0.62);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.64);
      }
      .entry-link.is-active {
        background: rgba(233, 217, 206, 0.96);
      }
      .entry-icon { font-size: 11px; letter-spacing: 0.12em; color: var(--accent); }
      .search-list li, .overview-card {
        padding: 14px;
        border-radius: 16px;
        background: var(--surface-soft);
      }
      .directory-overview { display: grid; gap: 12px; }
      .editor-form { display: grid; gap: 12px; margin-top: 18px; }
      .editor-form textarea { min-height: 460px; resize: vertical; font: 500 14px/1.6 var(--mono); }
      pre, code { font-family: var(--mono); }
      pre { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; border-radius: 14px; background: rgba(232, 238, 243, 0.82); padding: 12px; color: var(--text); }
      .image-preview { display: block; max-width: 100%; border-radius: 18px; background: rgba(232, 238, 243, 0.82); margin-top: 12px; }
      @media (max-width: 900px) {
        .files-shell { grid-template-columns: 1fr; }
        .sidebar { position: static; }
      }
      @media (max-width: 720px) {
        main { padding: 14px; }
        .entry-link { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="files-shell">
        ${renderSidebar(routeBase, target, devices, currentPath, pathStyle, searchQuery, navigator)}
        <section class="content-stack">
          ${statusText ? `<section class="status-line"><p>${escapeHtml(statusText)}</p></section>` : ""}
          ${errorText ? `<section class="status-line is-error"><p>${escapeHtml(errorText)}</p></section>` : ""}
          ${mainContent}
        </section>
      </section>
    </main>
  </body>
</html>`;
}

 
    const appFrame = props.appFrame;
    const kernel = props.kernel;
    if (!appFrame || !kernel) {
      return new Response("App frame missing", { status: 500 });
    }

    const url = new URL(request.url);
    const routeBase = appFrame.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/files";
    if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let target = normalizeTarget(url.searchParams.get("target") ?? "gsv");
    let currentPath = normalizePath(
      url.searchParams.get("path") ?? defaultPathForTarget(target),
      detectPathStyle(url.searchParams.get("path") ?? defaultPathForTarget(target)),
    );
    let pathStyle = detectPathStyle(currentPath);
    let searchQuery = String(url.searchParams.get("q") ?? "").trim();
    let statusText = "";
    let errorText = "";
    let devices = [];

    try {
      const payload = await kernel.request("sys.device.list", {});
      devices = Array.isArray(payload?.devices) ? payload.devices : [];
      devices.sort((left, right) => String(left?.deviceId ?? "").localeCompare(String(right?.deviceId ?? "")));
      if (target !== "gsv" && !devices.some((device) => String(device?.deviceId ?? "") === target)) {
        target = "gsv";
        currentPath = normalizePath(defaultPathForTarget(target), detectPathStyle(defaultPathForTarget(target)));
        pathStyle = detectPathStyle(currentPath);
      }
    } catch {
      devices = [];
    }

    if (request.method === "POST") {
      try {
        const form = await request.formData();
        const action = String(form.get("action") ?? "").trim();
        target = normalizeTarget(form.get("target") ?? target);
        const pathValue = String(form.get("path") ?? currentPath);
        const path = normalizePath(pathValue, detectPathStyle(pathValue));
        currentPath = path;
        pathStyle = detectPathStyle(path);
        searchQuery = "";

        if (action === "save") {
          const result = await kernel.request("fs.write", withTarget(target, {
            path,
            content: String(form.get("content") ?? ""),
          }));
          if (result?.ok) {
            statusText = `Saved ${path}`;
          } else {
            errorText = result?.error ?? `Failed to save ${path}`;
          }
        } else if (action === "delete") {
          const result = await kernel.request("fs.delete", withTarget(target, { path }));
          if (result?.ok) {
            statusText = `Deleted ${path}`;
            currentPath = parentPath(path, pathStyle);
          } else {
            errorText = result?.error ?? `Failed to delete ${path}`;
          }
        } else {
          errorText = `Unknown action: ${action}`;
        }
      } catch (error) {
        errorText = error instanceof Error ? error.message : String(error);
      }
    }

    let view;
    if (searchQuery) {
      try {
        const result = await kernel.request("fs.search", withTarget(target, {
          path: currentPath,
          query: searchQuery,
        }));
        if (result?.ok) {
          view = { kind: "search", result };
        } else {
          view = { kind: "error", error: result?.error ?? "Search failed" };
        }
      } catch (error) {
        view = { kind: "error", error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      try {
        let result = await kernel.request("fs.read", withTarget(target, { path: currentPath }));
        if (!result?.ok && target !== "gsv") {
          const fallbackPath = currentPath.startsWith("/") ? currentPath.replace(/^\/+/, "") || "." : `/${currentPath}`;
          if (fallbackPath !== currentPath) {
            const fallback = await kernel.request("fs.read", withTarget(target, { path: fallbackPath }));
            if (fallback?.ok) {
              currentPath = fallbackPath;
              pathStyle = detectPathStyle(currentPath);
              result = fallback;
            }
          }
        }

        if (isDirectoryResult(result)) {
          currentPath = normalizePath(result.path ?? currentPath, detectPathStyle(result.path ?? currentPath));
          pathStyle = detectPathStyle(currentPath);
          view = { kind: "directory", result };
        } else if (isFileResult(result)) {
          currentPath = normalizePath(result.path ?? currentPath, detectPathStyle(result.path ?? currentPath));
          pathStyle = detectPathStyle(currentPath);
          view = { kind: "file", result };
        } else {
          view = { kind: "error", error: result?.error ?? `Unable to open ${currentPath}` };
        }
      } catch (error) {
        view = { kind: "error", error: error instanceof Error ? error.message : String(error) };
      }
    }

    let navigator = null;
    try {
      const navigatorBasePath = view?.kind === "file"
        ? parentPath(currentPath, pathStyle)
        : currentPath;
      const navigatorResult = await kernel.request("fs.read", withTarget(target, { path: navigatorBasePath }));
      if (isDirectoryResult(navigatorResult)) {
        const normalizedNavigatorPath = normalizePath(
          navigatorResult.path ?? navigatorBasePath,
          detectPathStyle(navigatorResult.path ?? navigatorBasePath),
        );
        navigator = {
          path: normalizedNavigatorPath,
          pathStyle: detectPathStyle(normalizedNavigatorPath),
          result: navigatorResult,
        };
      }
    } catch {}

    return new Response(renderPage({
      routeBase,
      target,
      devices,
      currentPath,
      pathStyle,
      searchQuery,
      statusText,
      errorText,
      navigator,
      view,
    }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
}

export default { fetch: handleFetch };
