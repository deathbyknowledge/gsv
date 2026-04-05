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
    return '<p class="config-empty muted">No processes match the current filter.</p>';
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

    return `
      <article class="process-row">
        <div class="process-row-main">
          <div class="process-row-head">
            <h3>${escapeHtml(title)}</h3>
            <span class="process-state-pill ${stateClass}">${escapeHtml(state || "unknown")}</span>
          </div>
          <p class="muted process-row-meta"><code>${escapeHtml(pid)}</code> · uid ${escapeHtml(uid)} · profile ${escapeHtml(profile)}</p>
          <p class="muted process-row-meta">parent ${escapeHtml(parentPid)} · created ${escapeHtml(formatTimestampMs(entry?.createdAt))}</p>
        </div>
        <div class="process-row-actions">
          <button
            type="button"
            class="runtime-btn"
            data-action="open-chat"
            data-pid="${escapeHtml(pid)}"
            data-workspace-id="${escapeHtml(workspaceId)}"
            data-cwd="${escapeHtml(cwd)}"
          >
            Open in Chat
          </button>
          <form method="post" action="${escapeHtml(routeBase)}" class="inline-form">
            <input type="hidden" name="action" value="kill" />
            <input type="hidden" name="pid" value="${escapeHtml(pid)}" />
            <input type="hidden" name="q" value="${escapeHtml(query)}" />
            <button type="submit" class="runtime-btn">Reset</button>
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
      :root { color-scheme: dark; }
      body {
        margin: 0;
        font: 14px/1.5 var(--gsv-font-sans, "Inter", sans-serif);
        background: var(--gsv-color-bg, #0c111b);
        color: var(--gsv-color-text, #f3f5f7);
      }
      .process-app {
        min-height: 100vh;
        box-sizing: border-box;
        padding: 24px;
        display: grid;
        gap: 18px;
      }
      .process-page-header,
      .process-toolbar,
      .process-list {
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(10, 15, 23, 0.72);
        border-radius: 18px;
        box-shadow: 0 14px 38px rgba(0, 0, 0, 0.22);
      }
      .process-page-header {
        padding: 20px 22px;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
      }
      .process-page-copy h1 {
        margin: 0;
        font-size: 32px;
        line-height: 1.1;
      }
      .process-page-copy p { margin: 8px 0 0; max-width: 62ch; }
      .eyebrow {
        margin: 0 0 8px;
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(193, 205, 224, 0.72);
      }
      .process-toolbar { padding: 16px 18px; }
      .process-toolbar-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }
      .process-toolbar label {
        display: grid;
        gap: 8px;
        min-width: min(100%, 360px);
        font-size: 13px;
        color: rgba(193, 205, 224, 0.86);
      }
      .process-toolbar input {
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        color: inherit;
        border-radius: 12px;
        padding: 10px 12px;
      }
      .toolbar-actions,
      .process-row-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      .runtime-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        border-radius: 999px;
        padding: 10px 14px;
        font: inherit;
        cursor: pointer;
      }
      .runtime-btn:hover { background: rgba(255, 255, 255, 0.1); }
      .process-list { padding: 14px; display: grid; gap: 12px; }
      .process-row {
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        border-radius: 16px;
        padding: 16px;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .process-row-main { min-width: 0; }
      .process-row-head {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .process-row-head h3 { margin: 0; font-size: 18px; }
      .process-row-meta { margin: 6px 0 0; }
      .inline-form { display: inline-flex; }
      .process-state-pill {
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .process-state-pill.is-running { background: rgba(73, 209, 148, 0.16); color: #73e2aa; }
      .process-state-pill.is-paused { background: rgba(255, 208, 84, 0.16); color: #ffd46c; }
      .process-state-pill.is-other { background: rgba(157, 174, 198, 0.16); color: #d7dfea; }
      .control-error-text,
      .config-empty,
      .muted { color: rgba(193, 205, 224, 0.76); }
      .control-error-text { margin: 0; color: #ffb4b4; }
      code { font-family: var(--gsv-font-mono, "SFMono-Regular", "Consolas", monospace); }
      @media (max-width: 760px) {
        .process-app { padding: 14px; }
        .process-page-header,
        .process-row { grid-template-columns: 1fr; display: grid; }
      }
    </style>
  </head>
  <body>
    <section class="process-app">
      <header class="process-page-header">
        <div class="process-page-copy">
          <p class="eyebrow">Process Surface</p>
          <h1>Processes</h1>
          <p>Inspect process state and jump directly into a process conversation in Chat.</p>
        </div>
        <p class="muted">Showing ${filtered.length} of ${processes.length} process${processes.length === 1 ? "" : "es"}.</p>
      </header>

      <section class="process-toolbar">
        <form method="get" action="${escapeHtml(routeBase)}" class="process-toolbar-row">
          <label>
            Search
            <input
              type="text"
              name="q"
              value="${escapeHtml(query)}"
              placeholder="Filter by pid, label, or parent pid"
            />
          </label>
          <div class="toolbar-actions">
            <button type="submit" class="runtime-btn">Apply</button>
            <a class="runtime-btn" href="${escapeHtml(routeBase)}">Clear</a>
          </div>
        </form>
      </section>

      <section class="process-list">
        ${renderProcessRows(routeBase, query, filtered)}
      </section>

      ${error ? `<p class="control-error-text">${escapeHtml(error)}</p>` : ""}
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
