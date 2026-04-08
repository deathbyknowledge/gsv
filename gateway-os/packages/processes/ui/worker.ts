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

function formatTimestampMs(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function renderProcessRows(routeBase, query, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '<div class="process-empty"><h3>No processes</h3><p>No processes match the current filter.</p></div>';
  }

  return entries.map((entry) => {
    const title = entry?.label && String(entry.label).trim().length > 0 ? String(entry.label).trim() : String(entry?.pid ?? "unknown");
    const state = String(entry?.state ?? "unknown").trim().toLowerCase();
    const stateClass = state === "running" ? "is-running" : state === "paused" ? "is-paused" : "is-other";
    const pid = String(entry?.pid ?? "");
    const profile = String(entry?.profile ?? "unknown");
    const uid = String(entry?.uid ?? "?");
    const parentPid = entry?.parentPid == null ? "—" : String(entry.parentPid);
    const workspaceId = entry?.workspaceId == null ? "" : String(entry.workspaceId);
    const cwd = String(entry?.cwd ?? "");
    const workspaceLabel = workspaceId || "—";
    const cwdLabel = cwd || "—";

    return `
      <article class="process-row">
        <div class="process-row-main">
          <div class="process-row-head">
            <span class="process-state-pill ${stateClass}">
              <span class="process-state-dot" aria-hidden="true"></span>
              ${escapeHtml(state || "unknown")}
            </span>
            <h3>${escapeHtml(title)}</h3>
          </div>
          <p class="muted process-row-meta"><code>${escapeHtml(pid)}</code> · uid ${escapeHtml(uid)} · profile ${escapeHtml(profile)} · parent ${escapeHtml(parentPid)}</p>
          <p class="muted process-row-meta">created ${escapeHtml(formatTimestampMs(entry?.createdAt))}</p>
        </div>
        <div class="process-row-context">
          <div class="process-context-block">
            <span class="process-context-label">Workspace</span>
            <strong>${escapeHtml(workspaceLabel)}</strong>
          </div>
          <div class="process-context-block">
            <span class="process-context-label">Path</span>
            <code>${escapeHtml(cwdLabel)}</code>
          </div>
        </div>
        <div class="process-row-actions">
          <button
            type="button"
            class="process-icon-btn"
            data-action="open-chat"
            data-pid="${escapeHtml(pid)}"
            data-workspace-id="${escapeHtml(workspaceId)}"
            data-cwd="${escapeHtml(cwd)}"
            aria-label="Open in Chat"
            title="Open in Chat"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7.5h12A2.5 2.5 0 0 1 20.5 10v5A2.5 2.5 0 0 1 18 17.5H11l-4.5 3v-3H6A2.5 2.5 0 0 1 3.5 15v-5A2.5 2.5 0 0 1 6 7.5z"/></svg>
          </button>
          <form method="post" action="${escapeHtml(routeBase)}" class="inline-form">
            <input type="hidden" name="action" value="kill" />
            <input type="hidden" name="pid" value="${escapeHtml(pid)}" />
            <input type="hidden" name="q" value="${escapeHtml(query)}" />
            <button type="submit" class="process-icon-btn process-icon-btn-danger" aria-label="Reset process" title="Reset process">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>
            </button>
          </form>
        </div>
      </article>
    `;
  }).join("");
}

function renderPage(routeBase, query, processes, error) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  const filtered = normalizedQuery.length === 0
    ? [...processes]
    : processes.filter((entry) => {
        return (
          String(entry?.pid ?? "").toLowerCase().includes(normalizedQuery) ||
          String(entry?.profile ?? "").toLowerCase().includes(normalizedQuery) ||
          String(entry?.label ?? "").toLowerCase().includes(normalizedQuery) ||
          String(entry?.parentPid ?? "").toLowerCase().includes(normalizedQuery)
        );
      });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Processes</title>
    <link rel="stylesheet" href="/runtime/theme.css" />
    <style>
      :root {
        color-scheme: light;
        --bg: #eef3f7;
        --panel: rgba(247, 249, 252, 0.92);
        --panel-soft: rgba(243, 247, 251, 0.82);
        --line: rgba(42, 50, 56, 0.08);
        --line-strong: rgba(42, 50, 56, 0.14);
        --text: #1f2d33;
        --muted: #61737b;
        --primary: #003466;
        --primary-soft: #1a4b84;
        --danger: #8a3b3b;
      }
      body {
        margin: 0;
        font: 14px/1.5 Manrope, system-ui, sans-serif;
        background: transparent;
        color: var(--text);
      }
      .process-app {
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        background: var(--panel);
      }
      .process-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding: 12px 14px 10px;
        border-bottom: 1px solid var(--line);
        background: rgba(247, 249, 252, 0.56);
        backdrop-filter: blur(10px) saturate(1.04);
        -webkit-backdrop-filter: blur(10px) saturate(1.04);
      }
      .process-toolbar-form {
        display: grid;
        grid-template-columns: minmax(240px, 420px) auto;
        gap: 8px;
        align-items: end;
      }
      .process-field {
        display: grid;
        gap: 4px;
      }
      .process-field span,
      .process-meta-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .process-field input {
        width: 100%;
        min-height: 34px;
        border: 1px solid rgba(38, 48, 56, 0.08);
        background: rgba(255, 255, 255, 0.78);
        color: var(--text);
        border-radius: 4px;
        padding: 0 10px;
        font: inherit;
        outline: none;
      }
      .process-field input:focus {
        border-color: rgba(26, 75, 132, 0.24);
        background: rgba(255, 255, 255, 0.96);
      }
      .process-toolbar-actions,
      .process-row-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .process-toolbar-meta {
        color: var(--muted);
        font-size: 13px;
        font-weight: 600;
      }
      .process-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        border: 0;
        border-radius: 6px;
        background: rgba(233, 239, 246, 0.76);
        color: var(--text);
        cursor: pointer;
      }
      .process-icon-btn svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .process-icon-btn-danger {
        background: rgba(255, 238, 236, 0.92);
        color: var(--danger);
      }
      .process-stage {
        min-height: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
      }
      .process-list-head {
        display: grid;
        grid-template-columns: minmax(0, 1.7fr) minmax(220px, 0.95fr) auto;
        gap: 18px;
        padding: 10px 14px 8px;
        border-bottom: 1px solid var(--line);
        color: var(--muted);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .process-list {
        min-height: 0;
        overflow: auto;
        display: grid;
        align-content: start;
        padding: 0 14px 14px;
      }
      .process-row {
        display: grid;
        grid-template-columns: minmax(0, 1.7fr) minmax(220px, 0.95fr) auto;
        gap: 18px;
        align-items: flex-start;
        padding: 12px 0;
        border-bottom: 1px solid var(--line);
      }
      .process-row-main { min-width: 0; }
      .process-row-head {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .process-row-head h3 {
        margin: 0;
        font-size: 16px;
        line-height: 1.2;
      }
      .process-row-meta { margin: 4px 0 0; }
      .process-row-context {
        display: grid;
        gap: 8px;
        min-width: 0;
      }
      .process-context-block {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .process-context-label {
        color: var(--muted);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .process-context-block strong,
      .process-context-block code {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .inline-form { display: inline-flex; }
      .process-state-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 3px 8px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 700;
      }
      .process-state-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: currentColor;
      }
      .process-state-pill.is-running { background: rgba(73, 209, 148, 0.14); color: #2a6d4e; }
      .process-state-pill.is-paused { background: rgba(255, 208, 84, 0.16); color: #8b6500; }
      .process-state-pill.is-other { background: rgba(157, 174, 198, 0.16); color: #5b6d82; }
      .control-error-text,
      .muted { color: var(--muted); }
      .control-error-text {
        margin: 0;
        padding: 8px 14px 0;
        color: var(--danger);
      }
      .process-empty {
        display: grid;
        place-items: center;
        align-content: center;
        min-height: 280px;
        text-align: center;
        color: var(--muted);
      }
      .process-empty h3 {
        margin: 0;
        font-family: "Space Grotesk", system-ui, sans-serif;
        font-size: 22px;
      }
      .process-empty p { margin: 8px 0 0; }
      code { font-family: "IBM Plex Mono", "SFMono-Regular", "Consolas", monospace; }
      @media (max-width: 760px) {
        .process-toolbar {
          align-items: stretch;
        }
        .process-toolbar-form {
          grid-template-columns: 1fr;
        }
        .process-list-head {
          display: none;
        }
        .process-row {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <section class="process-app">
      <section class="process-toolbar">
        <form method="get" action="${escapeHtml(routeBase)}" class="process-toolbar-form">
          <label class="process-field">
            <span>Search</span>
            <input
              type="text"
              name="q"
              value="${escapeHtml(query)}"
              placeholder="Filter by pid, label, or parent pid"
            />
          </label>
          <div class="process-toolbar-actions">
            <button type="submit" class="process-icon-btn" aria-label="Search" title="Search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg>
            </button>
            <a class="process-icon-btn" href="${escapeHtml(routeBase)}" aria-label="Clear filter" title="Clear filter">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6 6 18"></path></svg>
            </a>
          </div>
        </form>
        <div class="process-toolbar-meta">Showing ${filtered.length} of ${processes.length} process${processes.length === 1 ? "" : "es"}.</div>
      </section>

      ${error ? `<p class="control-error-text">${escapeHtml(error)}</p>` : ""}

      <section class="process-stage">
        <div class="process-list-head">
          <span>Process</span>
          <span>Workspace</span>
          <span>Actions</span>
        </div>
        <section class="process-list">
          ${renderProcessRows(routeBase, query, filtered)}
        </section>
      </section>
    </section>
    <script>
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        const button = target.closest("[data-action='open-chat']");
        if (!(button instanceof HTMLElement)) {
          return;
        }
        const pid = button.dataset.pid?.trim();
        const cwd = button.dataset.cwd?.trim();
        if (!pid || !cwd) {
          return;
        }
        const workspaceId = button.dataset.workspaceId?.trim() || null;
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              type: "gsv:open-chat-process",
              detail: { pid, workspaceId, cwd },
            }, window.location.origin);
            window.parent.dispatchEvent(new CustomEvent("gsv:open-chat-process", {
              detail: { pid, workspaceId, cwd },
            }));
            return;
          }
        } catch {}
        window.location.href = "/apps/chat";
      });
    </script>
  </body>
</html>`;
}

 
    const url = new URL(request.url);
    const routeBase = props.appFrame?.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/processes";
    const kernel = props.kernel;
    if (!kernel) {
      return new Response("KERNEL binding is required", { status: 500 });
    }
    if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method === "POST") {
      const formData = await request.formData();
      const action = String(formData.get("action") ?? "").trim();
      const pid = String(formData.get("pid") ?? "").trim();
      const query = String(formData.get("q") ?? "").trim();
      if (action === "kill" && pid.length > 0) {
        await kernel.request("proc.kill", { pid });
      }
      const redirectUrl = new URL(routeBase, url);
      if (query.length > 0) {
        redirectUrl.searchParams.set("q", query);
      }
      return Response.redirect(redirectUrl.toString(), 303);
    }

    const query = url.searchParams.get("q")?.trim() ?? "";
    let error = "";
    let processes = [];

    try {
      const payload = await kernel.request("proc.list", {});
      const next = Array.isArray(payload?.processes) ? payload.processes : [];
      processes = [...next].sort((left, right) => Number(right?.createdAt ?? 0) - Number(left?.createdAt ?? 0));
    } catch (requestError) {
      error = requestError instanceof Error ? requestError.message : String(requestError);
    }

    return new Response(renderPage(routeBase, query, processes, error || null), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
}

export default { fetch: handleFetch };
