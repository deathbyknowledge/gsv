const FILES_APP_SCRIPT = String.raw`
(() => {
  let dirty = false;
  const editor = document.querySelector('[data-editor]');
  const createButton = document.querySelector('[data-create-file-button]');
  const createForm = document.querySelector('[data-create-file-form]');
  const createInput = document.querySelector('[data-create-file-input]');
  const saveForm = document.querySelector('[data-save-form]');

  const markDirty = () => {
    dirty = true;
    document.body.dataset.dirty = 'true';
  };

  const clearDirty = () => {
    dirty = false;
    document.body.dataset.dirty = 'false';
  };

  if (editor) {
    editor.addEventListener('input', markDirty);
  }

  if (saveForm) {
    saveForm.addEventListener('submit', () => {
      clearDirty();
    });
  }

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    if (form.matches('[data-delete-form], [data-save-form], [data-create-file-form]')) {
      return;
    }
    if (dirty && !window.confirm('Discard unsaved changes to the current file?')) {
      event.preventDefault();
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const createTrigger = target.closest('[data-create-file-button]');
    if (createTrigger) {
      event.preventDefault();
      const name = window.prompt('New file name', 'untitled.txt');
      if (name && name.trim() && createForm instanceof HTMLFormElement && createInput instanceof HTMLInputElement) {
        createInput.value = name.trim();
        createForm.requestSubmit();
      }
      return;
    }

    const navTarget = target.closest('a[data-nav], button[data-nav]');
    if (!navTarget) {
      return;
    }
    if (dirty && !window.confirm('Discard unsaved changes to the current file?')) {
      event.preventDefault();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!dirty) {
      return;
    }
    event.preventDefault();
    event.returnValue = '';
  });
})();
`;

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

function fileIconVariant(name, isDirectory) {
  if (isDirectory) {
    return "folder";
  }
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) {
    return "image";
  }
  if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext)) {
    return "archive";
  }
  if (["md", "txt", "json", "yaml", "yml", "toml", "xml", "html", "css", "js", "ts", "tsx", "rs", "py", "sh"].includes(ext)) {
    return "text";
  }
  return "file";
}

function iconSvg(kind) {
  if (kind === "folder") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.75C3 5.784 3.784 5 4.75 5H9.2c.47 0 .92.184 1.25.512l1.037 1.038c.141.14.332.22.531.22h7.232C20.216 6.77 21 7.554 21 8.52v8.73A1.75 1.75 0 0 1 19.25 19H4.75A1.75 1.75 0 0 1 3 17.25z" fill="currentColor"/></svg>`;
  }
  if (kind === "image") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.75 4h9.5A2.75 2.75 0 0 1 18 6.75v10.5A2.75 2.75 0 0 1 15.25 20h-9.5A2.75 2.75 0 0 1 3 17.25V6.75A2.75 2.75 0 0 1 5.75 4m.25 11.5 2.75-3.25 2.5 2.75 1.75-2 3 3.5zM9 9a1.25 1.25 0 1 0 0-.001z" fill="currentColor"/></svg>`;
  }
  if (kind === "archive") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.75 3h6.086c.464 0 .909.184 1.237.513l2.414 2.414c.329.328.513.773.513 1.237v11.086A2.75 2.75 0 0 1 15.25 21h-7.5A2.75 2.75 0 0 1 5 18.25v-12.5A2.75 2.75 0 0 1 7.75 3M9 8h5v1.5H9zm0 3h5v1.5H9zm0 3h4v1.5H9z" fill="currentColor"/></svg>`;
  }
  if (kind === "text") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.75 3h6.086c.464 0 .909.184 1.237.513l2.414 2.414c.329.328.513.773.513 1.237v11.086A2.75 2.75 0 0 1 15.25 21h-7.5A2.75 2.75 0 0 1 5 18.25v-12.5A2.75 2.75 0 0 1 7.75 3M8.5 9.25h7v1.5h-7zm0 3.5h7v1.5h-7z" fill="currentColor"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.75 3h6.086c.464 0 .909.184 1.237.513l2.414 2.414c.329.328.513.773.513 1.237v11.086A2.75 2.75 0 0 1 15.25 21h-7.5A2.75 2.75 0 0 1 5 18.25v-12.5A2.75 2.75 0 0 1 7.75 3" fill="currentColor"/></svg>`;
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
    `<option value="gsv"${normalizedTarget === "gsv" ? " selected" : ""}>Kernel (gsv)</option>`,
  ];

  for (const device of devices) {
    const deviceId = String(device?.deviceId ?? "").trim();
    if (!deviceId) {
      continue;
    }
    const suffix = device?.online === false ? " · offline" : " · online";
    options.push(
      `<option value="${escapeHtml(deviceId)}"${normalizedTarget === deviceId ? " selected" : ""}>${escapeHtml(deviceId + suffix)}</option>`,
    );
  }

  return options.join("");
}

function buildHref(routeBase, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix.length > 0 ? `${routeBase}?${suffix}` : routeBase;
}

function baseName(path) {
  const style = detectPathStyle(path);
  const normalized = normalizePath(path, style);
  if (normalized === "/" || normalized === ".") {
    return normalized;
  }
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function renderBreadcrumbs(routeBase, target, activePath, pathStyle, searchQuery) {
  const normalized = normalizePath(activePath, pathStyle);
  const parts = [];
  const absoluteSegments = normalized.split("/").filter(Boolean);

  if (pathStyle === "absolute") {
    if (normalized === "/") {
      return `<a data-nav class="files-crumb is-current" href="${buildHref(routeBase, { target, path: "/" })}">/</a>`;
    }

    parts.push(`<a data-nav class="files-crumb" href="${buildHref(routeBase, { target, path: "/" })}">/</a>`);
    let current = "";
    for (const [index, segment] of absoluteSegments.entries()) {
      current += `/${segment}`;
      const isLast = index === absoluteSegments.length - 1;
      parts.push(`<span class="files-crumb-sep">›</span>`);
      parts.push(`<a data-nav class="files-crumb${isLast ? " is-current" : ""}" href="${buildHref(routeBase, { target, path: current })}">${escapeHtml(segment)}</a>`);
    }
    return parts.join("");
  }

  if (normalized === ".") {
    return `<a data-nav class="files-crumb is-current" href="${buildHref(routeBase, { target, path: "." })}">workspace</a>`;
  }

  const segments = normalized.split("/").filter(Boolean);
  parts.push(`<a data-nav class="files-crumb" href="${buildHref(routeBase, { target, path: "." })}">workspace</a>`);
  let current = "";
  for (const [index, segment] of segments.entries()) {
    current = current ? `${current}/${segment}` : segment;
    const isLast = index === segments.length - 1;
    parts.push(`<span class="files-crumb-sep">›</span>`);
    parts.push(`<a data-nav class="files-crumb${isLast ? " is-current" : ""}" href="${buildHref(routeBase, { target, path: current })}">${escapeHtml(segment)}</a>`);
  }
  return parts.join("");
}

function renderToolbar({ routeBase, target, devices, currentPath, pathStyle, searchQuery, canGoUp }) {
  const parent = parentPath(currentPath, pathStyle);
  return `
    <section class="files-toolbar">
      <form method="get" class="files-toolbar-form files-toolbar-form-nav">
        <div class="files-toolbar-group">
          <label class="files-field">
            <span>Target</span>
            <select name="target">
              ${renderTargetOptions(target, devices)}
            </select>
          </label>
          <label class="files-field">
            <span>Path</span>
            <input name="path" type="text" value="${escapeHtml(currentPath)}" spellcheck="false" />
          </label>
        </div>
        <div class="files-toolbar-actions">
          <div class="files-inline-actions">
            <button type="submit" class="files-btn files-btn-primary">Open</button>
            <a data-nav class="files-btn files-btn-quiet${canGoUp ? "" : " is-disabled"}" href="${canGoUp ? buildHref(routeBase, { target, path: parent, q: searchQuery || undefined }) : "#"}">Up</a>
          </div>
          <button type="button" class="files-icon-btn" data-create-file-button aria-label="Create file">＋</button>
        </div>
      </form>
      <form method="get" class="files-toolbar-form files-toolbar-form-search">
        <input type="hidden" name="target" value="${escapeHtml(target)}" />
        <input type="hidden" name="path" value="${escapeHtml(currentPath)}" />
        <div class="files-toolbar-group">
          <label class="files-field">
            <span>Search</span>
            <input name="q" type="text" value="${escapeHtml(searchQuery)}" placeholder="Search this folder" spellcheck="false" />
          </label>
        </div>
        <div class="files-toolbar-actions">
          <div class="files-inline-actions">
            <button type="submit" class="files-btn files-btn-primary">Search</button>
            <a data-nav class="files-btn files-btn-quiet" href="${buildHref(routeBase, { target, path: currentPath })}">Clear</a>
          </div>
        </div>
      </form>
      <form method="post" data-create-file-form class="visually-hidden">
        <input type="hidden" name="action" value="create" />
        <input type="hidden" name="target" value="${escapeHtml(target)}" />
        <input type="hidden" name="path" value="${escapeHtml(currentPath)}" />
        <input type="hidden" name="q" value="${escapeHtml(searchQuery)}" />
        <input data-create-file-input type="hidden" name="name" value="" />
      </form>
    </section>
  `;
}

function renderDirectoryEntries(routeBase, target, currentPath, pathStyle, searchQuery, directoryResult) {
  const directories = Array.isArray(directoryResult?.directories) ? [...directoryResult.directories].sort((a, b) => a.localeCompare(b)) : [];
  const files = Array.isArray(directoryResult?.files) ? [...directoryResult.files].sort((a, b) => a.localeCompare(b)) : [];
  const rows = [];

  for (const name of directories) {
    const nextPath = resolvePath(name, currentPath, pathStyle);
    rows.push(`
      <a data-nav class="files-entry-row is-directory" href="${buildHref(routeBase, { target, path: nextPath, q: searchQuery || undefined })}">
        <span class="files-entry-icon">${iconSvg("folder")}</span>
        <span class="files-entry-name">${escapeHtml(name)}</span>
      </a>
    `);
  }

  for (const name of files) {
    const nextPath = resolvePath(name, currentPath, pathStyle);
    const kind = fileIconVariant(name, false);
    rows.push(`
      <a data-nav class="files-entry-row" href="${buildHref(routeBase, { target, path: currentPath, open: nextPath, q: searchQuery || undefined })}">
        <span class="files-entry-icon">${iconSvg(kind)}</span>
        <span class="files-entry-name">${escapeHtml(name)}</span>
      </a>
    `);
  }

  if (rows.length === 0) {
    return `<div class="files-empty"><h3>Directory is empty</h3><p>Create a file or open a different folder.</p></div>`;
  }

  return `<div class="files-entry-grid">${rows.join("")}</div>`;
}

function renderSearchResults(routeBase, target, currentPath, searchQuery, searchResult) {
  const matches = Array.isArray(searchResult?.matches) ? searchResult.matches : [];
  if (matches.length === 0) {
    return `<div class="files-empty"><h3>No matches</h3><p>Try a different query inside this folder.</p></div>`;
  }

  const rows = matches.map((match) => `
    <a data-nav class="files-search-row" href="${buildHref(routeBase, { target, path: currentPath, q: searchQuery, open: match.path })}">
      <strong>${escapeHtml(match.path)}:${Number(match.line ?? 0)}</strong>
      <code>${escapeHtml(String(match.content ?? ""))}</code>
    </a>
  `).join("");

  return `
    <section class="files-search-view">
      <div class="files-content-toolbar">
        <div class="files-inline-meta">
          <strong>${matches.length} match${matches.length === 1 ? "" : "es"}</strong>
        </div>
        ${searchResult?.truncated ? `<span class="files-pill">Truncated</span>` : ""}
      </div>
      <div class="files-search-list">${rows}</div>
    </section>
  `;
}

function renderImageContent(contentItems) {
  for (const item of contentItems) {
    if (item && typeof item === "object" && item.type === "image") {
      return `<img class="files-image-preview" alt="File preview" src="data:${escapeHtml(item.mimeType ?? "image/png")};base64,${escapeHtml(item.data ?? "")}" />`;
    }
  }
  for (const item of contentItems) {
    if (item && typeof item === "object" && item.type === "text") {
      return `<pre class="files-code-preview">${escapeHtml(item.text ?? "")}</pre>`;
    }
  }
  return `<div class="files-empty"><h3>Preview unavailable</h3><p>This file could not be rendered.</p></div>`;
}

function renderFileView({ routeBase, target, currentPath, searchQuery, filePath, fileResult }) {
  const backHref = buildHref(routeBase, { target, path: currentPath, q: searchQuery || undefined });
  const sizeLabel = formatBytes(fileResult?.size);

  if (Array.isArray(fileResult?.content)) {
    return `
      <section class="files-file-stage">
        <header class="files-content-toolbar">
          <a data-nav class="files-back-link" href="${backHref}">Back to folder</a>
          <div class="files-inline-meta">
            <span>${escapeHtml(sizeLabel)}</span>
          </div>
          <form method="post" data-delete-form>
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="target" value="${escapeHtml(target)}" />
            <input type="hidden" name="path" value="${escapeHtml(filePath)}" />
            <input type="hidden" name="currentPath" value="${escapeHtml(currentPath)}" />
            <input type="hidden" name="q" value="${escapeHtml(searchQuery)}" />
            <button type="submit" class="files-btn files-btn-danger">Delete</button>
          </form>
        </header>
        <section class="files-file-body is-image">${renderImageContent(fileResult.content)}</section>
      </section>
    `;
  }

  return `
    <section class="files-file-stage">
      <header class="files-content-toolbar">
        <a data-nav class="files-back-link" href="${backHref}">Back to folder</a>
        <div class="files-inline-meta">
          <span>${escapeHtml(sizeLabel)}</span>
        </div>
        <div class="files-file-actions">
          <button type="submit" form="files-save-form" class="files-btn files-btn-primary">Save</button>
          <form method="post" data-delete-form>
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="target" value="${escapeHtml(target)}" />
            <input type="hidden" name="path" value="${escapeHtml(filePath)}" />
            <input type="hidden" name="currentPath" value="${escapeHtml(currentPath)}" />
            <input type="hidden" name="q" value="${escapeHtml(searchQuery)}" />
            <button type="submit" class="files-btn files-btn-danger">Delete</button>
          </form>
        </div>
      </header>
      <form id="files-save-form" method="post" data-save-form class="files-editor-form">
        <input type="hidden" name="action" value="save" />
        <input type="hidden" name="target" value="${escapeHtml(target)}" />
        <input type="hidden" name="path" value="${escapeHtml(filePath)}" />
        <input type="hidden" name="currentPath" value="${escapeHtml(currentPath)}" />
        <input type="hidden" name="q" value="${escapeHtml(searchQuery)}" />
        <textarea data-editor class="files-editor" name="content" spellcheck="false">${escapeHtml(decodeNumberedText(fileResult?.content ?? ""))}</textarea>
      </form>
    </section>
  `;
}

function renderDirectoryStage({ routeBase, target, currentPath, pathStyle, searchQuery, directoryResult }) {
  return `
    <section class="files-directory-stage">
      ${renderDirectoryEntries(routeBase, target, currentPath, pathStyle, searchQuery, directoryResult)}
    </section>
  `;
}

function renderPage(state) {
  const {
    routeBase,
    target,
    devices,
    currentPath,
    pathStyle,
    searchQuery,
    statusText,
    errorText,
    directoryResult,
    filePath,
    fileResult,
    searchResult,
  } = state;

  const canGoUp = pathStyle === "absolute" ? currentPath !== "/" : currentPath !== ".";
  const activePath = filePath || currentPath;
  const stage = fileResult
    ? renderFileView({ routeBase, target, currentPath, searchQuery, filePath, fileResult })
    : searchQuery
      ? renderSearchResults(routeBase, target, currentPath, searchQuery, searchResult)
      : renderDirectoryStage({ routeBase, target, currentPath, pathStyle, searchQuery, directoryResult });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Files</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f2ede4;
        --panel: rgba(250, 246, 240, 0.82);
        --panel-strong: #faf6f0;
        --panel-soft: #ece4d7;
        --line: rgba(58, 68, 76, 0.12);
        --line-strong: rgba(42, 50, 56, 0.18);
        --text: #1f2d33;
        --muted: #61737b;
        --primary-a: #003466;
        --primary-b: #1a4b84;
        --accent: #8f5b47;
        --shadow: 0 28px 80px rgba(38, 42, 47, 0.12);
        --glass-shadow: 0 12px 32px rgba(28, 34, 38, 0.12), inset 0 1px 0 rgba(255,255,255,0.58), inset 0 -1px 0 rgba(255,255,255,0.14), inset 0 0 6px 2px rgba(255,255,255,0.18);
        font-family: Manrope, system-ui, sans-serif;
      }

      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        background: transparent;
        color: var(--text);
      }
      body[data-dirty="true"] .files-editor {
        border-color: rgba(143, 91, 71, 0.44);
      }
      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0,0,0,0);
        white-space: nowrap;
        border: 0;
      }
      main {
        min-height: 100vh;
      }
      .files-shell {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 100vh;
      }
      .files-toolbar {
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.95fr);
        gap: 12px 18px;
        align-items: end;
        padding: 16px 18px 14px;
        border-bottom: 1px solid rgba(42, 50, 56, 0.1);
        background: rgba(248, 243, 236, 0.56);
        backdrop-filter: blur(10px) saturate(1.04);
        -webkit-backdrop-filter: blur(10px) saturate(1.04);
      }
      .files-toolbar-form {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: end;
      }
      .files-toolbar-form-nav .files-toolbar-group {
        display: grid;
        grid-template-columns: 190px minmax(280px, 1fr);
        gap: 12px;
      }
      .files-toolbar-form-search .files-toolbar-group {
        display: grid;
        grid-template-columns: minmax(220px, 1fr);
        gap: 12px;
      }
      .files-toolbar-actions,
      .files-inline-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        flex-wrap: wrap;
      }
      .files-inline-meta {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 600;
      }
      .files-stage-eyebrow {
        margin: 0 0 6px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .files-stage h2 {
        margin: 0;
        font-family: "Space Grotesk", system-ui, sans-serif;
        font-size: 24px;
        line-height: 1.06;
        font-weight: 600;
      }
      .files-field {
        display: grid;
        gap: 6px;
      }
      .files-field span {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .files-field input,
      .files-field select {
        width: 100%;
        min-height: 42px;
        border: 1px solid rgba(38, 48, 56, 0.08);
        border-left: 3px solid transparent;
        border-radius: 4px;
        padding: 0 12px;
        background: rgba(247, 242, 236, 0.74);
        color: var(--text);
        font: inherit;
        outline: none;
      }
      .files-field input:focus,
      .files-field select:focus,
      .files-editor:focus {
        border-left-color: var(--primary-b);
        background: rgba(252, 249, 244, 0.92);
      }
      .files-sidebar-actions,
      .files-file-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .files-btn,
      .files-icon-btn,
      .files-back-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 38px;
        padding: 0 14px;
        border-radius: 8px;
        border: 0;
        text-decoration: none;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      .files-btn-primary {
        background: linear-gradient(135deg, var(--primary-a), var(--primary-b));
        color: white;
        box-shadow: 0 10px 22px rgba(9, 45, 90, 0.18);
      }
      .files-btn-quiet,
      .files-icon-btn,
      .files-back-link {
        background: rgba(248, 242, 234, 0.72);
        color: var(--text);
      }
      .files-btn-danger {
        background: rgba(143, 91, 71, 0.14);
        color: #7b412d;
      }
      .files-btn.is-disabled {
        pointer-events: none;
        opacity: 0.45;
      }
      .files-stage {
        padding: 12px 18px 18px;
        display: grid;
        gap: 14px;
        align-content: start;
        min-height: 0;
      }
      .files-status-line {
        padding: 8px 0 0;
        color: var(--text);
      }
      .files-status-line.is-error {
        color: #7b412d;
      }
      .files-breadcrumbs {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        min-height: 26px;
        padding-top: 2px;
      }
      .files-crumb,
      .files-crumb-sep {
        font-size: 13px;
        color: var(--muted);
      }
      .files-crumb {
        text-decoration: none;
      }
      .files-crumb.is-current {
        color: var(--text);
        font-weight: 700;
      }
      .files-entry-grid,
      .files-search-list {
        display: grid;
        gap: 10px;
      }
      .files-entry-grid {
        grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
        gap: 14px;
      }
      .files-entry-row {
        display: grid;
        justify-items: center;
        align-content: start;
        gap: 10px;
        min-height: 132px;
        padding: 18px 14px 14px;
        border-radius: 14px;
        background: rgba(255,255,255,0.34);
        color: inherit;
        text-decoration: none;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.52);
        text-align: center;
      }
      .files-entry-row:hover {
        background: rgba(255,255,255,0.58);
        transform: translateY(-1px);
      }
      .files-search-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 14px;
        padding: 14px 16px;
        border-radius: 12px;
        background: rgba(255,255,255,0.55);
        color: inherit;
        text-decoration: none;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.55);
      }
      .files-search-row:hover {
        background: rgba(255,255,255,0.76);
      }
      .files-entry-icon {
        width: 44px;
        height: 44px;
        color: var(--primary-b);
      }
      .files-entry-icon svg {
        width: 100%;
        height: 100%;
        display: block;
      }
      .files-entry-name,
      .files-search-row strong {
        font-size: 14px;
        line-height: 1.3;
      }
      .files-entry-name {
        display: -webkit-box;
        min-width: 0;
        overflow: hidden;
        color: var(--text);
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        word-break: break-word;
      }
      .files-search-row code {
        color: var(--muted);
        font-size: 12px;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .files-file-stage,
      .files-directory-stage,
      .files-search-view {
        min-height: calc(100vh - 156px);
      }
      .files-content-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
        flex-wrap: wrap;
      }
      .files-back-link {
        padding-inline: 12px;
      }
      .files-editor-form {
        display: grid;
      }
      .files-editor {
        width: 100%;
        min-height: calc(100vh - 226px);
        padding: 16px 18px;
        border-radius: 12px;
        border: 1px solid rgba(38, 48, 56, 0.08);
        border-left: 3px solid transparent;
        background: rgba(255,255,255,0.66);
        color: var(--text);
        font: 13px/1.55 "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        resize: vertical;
        outline: none;
      }
      .files-file-body.is-image {
        display: grid;
        place-items: start center;
      }
      .files-image-preview {
        max-width: 100%;
        border-radius: 14px;
        box-shadow: var(--shadow);
      }
      .files-code-preview {
        margin: 0;
        padding: 18px;
        border-radius: 12px;
        background: rgba(255,255,255,0.82);
        font: 13px/1.55 "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        white-space: pre-wrap;
        overflow: auto;
      }
      .files-empty {
        display: grid;
        align-content: start;
        gap: 6px;
        padding: 12px 2px;
        color: var(--muted);
      }
      .files-empty h3 {
        margin: 0;
        font-size: 18px;
        color: var(--text);
      }
      .files-empty p,
      .files-status-line p {
        margin: 0;
      }
      .files-pill {
        display: inline-flex;
        align-items: center;
        min-height: 28px;
        padding: 0 10px;
        border-radius: 999px;
        background: rgba(143, 91, 71, 0.12);
        color: #7b412d;
        font-size: 12px;
        font-weight: 700;
      }
      @media (max-width: 980px) {
        .files-toolbar {
          grid-template-columns: 1fr;
          padding: 12px 14px;
        }
        .files-toolbar-form,
        .files-toolbar-form-nav .files-toolbar-group,
        .files-toolbar-form-search .files-toolbar-group {
          grid-template-columns: 1fr;
        }
        .files-toolbar-actions,
        .files-inline-actions {
          justify-content: flex-start;
        }
        .files-stage {
          padding: 12px 14px 16px;
        }
        .files-editor,
        .files-file-stage,
        .files-directory-stage,
        .files-search-view { min-height: 0; }
        .files-content-toolbar { align-items: flex-start; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="files-shell">
        ${renderToolbar({ routeBase, target, devices, currentPath, pathStyle, searchQuery, canGoUp })}
        <section class="files-stage">
          ${statusText ? `<section class="files-status-line"><p>${escapeHtml(statusText)}</p></section>` : ""}
          ${errorText ? `<section class="files-status-line is-error"><p>${escapeHtml(errorText)}</p></section>` : ""}
          <nav class="files-breadcrumbs">${renderBreadcrumbs(routeBase, target, activePath, detectPathStyle(activePath), searchQuery)}</nav>
          ${stage}
        </section>
      </section>
    </main>
    <script type="module" src="${escapeHtml(`${routeBase.replace(/\/$/, "")}/app.js`)}"></script>
  </body>
</html>`;
}

async function readPathWithFallback(kernel, target, path) {
  let result = await kernel.request("fs.read", withTarget(target, { path }));
  if (!result?.ok && target !== "gsv") {
    const fallbackPath = path.startsWith("/") ? path.replace(/^\/+/, "") || "." : `/${path}`;
    if (fallbackPath !== path) {
      const fallback = await kernel.request("fs.read", withTarget(target, { path: fallbackPath }));
      if (fallback?.ok) {
        return { path: fallbackPath, result: fallback };
      }
    }
  }
  return { path, result };
}

export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};
  const appFrame = props.appFrame;
  const kernel = props.kernel;
  if (!appFrame || !kernel) {
    return new Response("App frame missing", { status: 500 });
  }

  const url = new URL(request.url);
  const routeBase = appFrame.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/files";
  if (url.pathname === `${routeBase.replace(/\/$/, "")}/app.js`) {
    return new Response(FILES_APP_SCRIPT, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
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
  let openPath = String(url.searchParams.get("open") ?? "").trim();
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
      openPath = "";
      searchQuery = "";
    }
  } catch {
    devices = [];
  }

  if (request.method === "POST") {
    try {
      const form = await request.formData();
      const action = String(form.get("action") ?? "").trim();
      target = normalizeTarget(form.get("target") ?? target);
      currentPath = normalizePath(String(form.get("currentPath") ?? form.get("path") ?? currentPath), detectPathStyle(String(form.get("currentPath") ?? form.get("path") ?? currentPath)));
      pathStyle = detectPathStyle(currentPath);
      searchQuery = String(form.get("q") ?? searchQuery).trim();

      if (action === "save") {
        const path = normalizePath(String(form.get("path") ?? openPath), detectPathStyle(String(form.get("path") ?? openPath)));
        const result = await kernel.request("fs.write", withTarget(target, {
          path,
          content: String(form.get("content") ?? ""),
        }));
        if (result?.ok) {
          openPath = path;
          statusText = `Saved ${path}`;
        } else {
          openPath = path;
          errorText = result?.error ?? `Failed to save ${path}`;
        }
      } else if (action === "delete") {
        const path = normalizePath(String(form.get("path") ?? openPath), detectPathStyle(String(form.get("path") ?? openPath)));
        const result = await kernel.request("fs.delete", withTarget(target, { path }));
        if (result?.ok) {
          openPath = "";
          statusText = `Deleted ${path}`;
        } else {
          openPath = path;
          errorText = result?.error ?? `Failed to delete ${path}`;
        }
      } else if (action === "create") {
        const name = String(form.get("name") ?? "").trim();
        if (!name) {
          errorText = "New file name is required.";
        } else {
          const path = resolvePath(name, currentPath, pathStyle);
          const result = await kernel.request("fs.write", withTarget(target, { path, content: "" }));
          if (result?.ok) {
            openPath = path;
            statusText = `Created ${path}`;
          } else {
            errorText = result?.error ?? `Failed to create ${path}`;
          }
        }
      } else {
        errorText = `Unknown action: ${action}`;
      }
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
  }

  let directoryResult = null;
  let fileResult = null;
  let filePath = openPath ? normalizePath(openPath, detectPathStyle(openPath)) : "";
  let searchResult = { ok: true, matches: [], truncated: false };

  try {
    const directoryRead = await readPathWithFallback(kernel, target, currentPath);
    currentPath = normalizePath(directoryRead.path, detectPathStyle(directoryRead.path));
    pathStyle = detectPathStyle(currentPath);

    if (isDirectoryResult(directoryRead.result)) {
      directoryResult = directoryRead.result;
    } else if (isFileResult(directoryRead.result)) {
      filePath = normalizePath(directoryRead.result.path ?? currentPath, detectPathStyle(directoryRead.result.path ?? currentPath));
      currentPath = parentPath(filePath, detectPathStyle(filePath));
      pathStyle = detectPathStyle(currentPath);
      const parentRead = await readPathWithFallback(kernel, target, currentPath);
      if (isDirectoryResult(parentRead.result)) {
        directoryResult = parentRead.result;
      }
    } else {
      errorText = errorText || directoryRead.result?.error || `Unable to open ${currentPath}`;
    }
  } catch (error) {
    errorText = errorText || (error instanceof Error ? error.message : String(error));
  }

  if (searchQuery) {
    try {
      const result = await kernel.request("fs.search", withTarget(target, {
        path: currentPath,
        query: searchQuery,
      }));
      if (result?.ok) {
        searchResult = result;
      } else {
        errorText = errorText || result?.error || "Search failed";
      }
    } catch (error) {
      errorText = errorText || (error instanceof Error ? error.message : String(error));
    }
  }

  if (filePath) {
    try {
      const fileRead = await readPathWithFallback(kernel, target, filePath);
      if (isFileResult(fileRead.result)) {
        filePath = normalizePath(fileRead.result.path ?? fileRead.path, detectPathStyle(fileRead.result.path ?? fileRead.path));
        fileResult = fileRead.result;
      } else if (isDirectoryResult(fileRead.result)) {
        currentPath = normalizePath(fileRead.result.path ?? fileRead.path, detectPathStyle(fileRead.result.path ?? fileRead.path));
        pathStyle = detectPathStyle(currentPath);
        directoryResult = fileRead.result;
        filePath = "";
      } else {
        errorText = errorText || fileRead.result?.error || `Unable to open ${filePath}`;
        filePath = "";
      }
    } catch (error) {
      errorText = errorText || (error instanceof Error ? error.message : String(error));
      filePath = "";
    }
  }

  if (!directoryResult) {
    directoryResult = { ok: true, path: currentPath, files: [], directories: [] };
  }

  return new Response(renderPage({
    routeBase,
    target,
    devices,
    currentPath,
    pathStyle,
    searchQuery,
    statusText,
    errorText,
    directoryResult,
    filePath,
    fileResult,
    searchResult,
  }), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default { fetch: handleFetch };
