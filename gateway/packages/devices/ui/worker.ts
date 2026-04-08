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

  function asDeviceList(value) {
    if (Array.isArray(value)) {
      return value;
    }
    if (Array.isArray(value?.devices)) {
      return value.devices;
    }
    return [];
  }

  function normalizeDevice(device) {
    const id = String(device?.id ?? device?.deviceId ?? "unknown");
    const label = String(device?.label ?? device?.name ?? id);
    const kind = String(device?.kind ?? device?.type ?? "device");
    const online = typeof device?.online === "boolean"
      ? device.online
      : String(device?.status ?? "").toLowerCase() === "online";
    const status = String(device?.status ?? (online ? "online" : "offline"));
    const platform = String(device?.platform ?? device?.os ?? "").trim();
    const version = String(device?.version ?? "").trim();
    return { id, label, kind, online, status, platform, version, raw: device };
  }

  function filterDevices(devices, query, scope) {
    const q = String(query ?? "").trim().toLowerCase();
    return devices.filter((device) => {
      if (scope === "online" && !device.online) {
        return false;
      }
      if (scope === "offline" && device.online) {
        return false;
      }
      if (!q) {
        return true;
      }
      return [device.id, device.label, device.kind, device.status, device.platform, device.version]
        .some((part) => part.toLowerCase().includes(q));
    });
  }

  function countBy(devices, predicate) {
    let count = 0;
    for (const device of devices) {
      if (predicate(device)) {
        count += 1;
      }
    }
    return count;
  }

  function renderSummary(devices) {
    const total = devices.length;
    const online = countBy(devices, (device) => device.online);
    const offline = total - online;
    return `
      <div class="devices-summary">
        <div class="devices-metric">
          <span class="devices-metric-label">Devices</span>
          <strong>${total}</strong>
        </div>
        <div class="devices-metric">
          <span class="devices-metric-label">Online</span>
          <strong>${online}</strong>
        </div>
        <div class="devices-metric">
          <span class="devices-metric-label">Offline</span>
          <strong>${offline}</strong>
        </div>
      </div>
    `;
  }

  function renderToolbar(routeBase, query, scope, devices) {
    return `
      <section class="devices-toolbar">
        <div class="devices-toolbar-copy">
          <p class="devices-eyebrow">Fleet</p>
          <h1>Devices</h1>
          <p class="devices-subtitle">Operational endpoints known to the gateway.</p>
        </div>
        ${renderSummary(devices)}
        <form method="get" class="devices-toolbar-form">
          <label class="devices-field devices-field-search">
            <span>Search</span>
            <input name="q" type="text" value="${escapeHtml(query)}" placeholder="Find by device, platform, status" spellcheck="false" />
          </label>
          <label class="devices-field devices-field-scope">
            <span>Scope</span>
            <select name="scope">
              <option value="all"${scope === "all" ? " selected" : ""}>All devices</option>
              <option value="online"${scope === "online" ? " selected" : ""}>Online</option>
              <option value="offline"${scope === "offline" ? " selected" : ""}>Offline</option>
            </select>
          </label>
          <div class="devices-toolbar-actions">
            <button type="submit" class="devices-btn devices-btn-primary">Filter</button>
            <a class="devices-btn devices-btn-quiet" href="${escapeHtml(routeBase)}">Reset</a>
          </div>
        </form>
      </section>
    `;
  }

  function renderStatusPill(device) {
    const tone = device.online ? "is-online" : "is-offline";
    return `<span class="devices-pill ${tone}">${escapeHtml(device.status)}</span>`;
  }

  function renderMeta(device) {
    const items = [];
    if (device.platform) {
      items.push(`<span>${escapeHtml(device.platform)}</span>`);
    }
    if (device.version) {
      items.push(`<span>${escapeHtml(device.version)}</span>`);
    }
    items.push(`<code>${escapeHtml(device.id)}</code>`);
    return items.join("<span class=\"devices-meta-sep\">•</span>");
  }

  function renderDevices(devices) {
    if (devices.length === 0) {
      return `
        <section class="devices-empty">
          <h2>No matching devices</h2>
          <p>Adjust the filter or wait for a device to report in.</p>
        </section>
      `;
    }

    return `
      <section class="devices-grid">
        ${devices.map((device) => `
          <article class="devices-item">
            <header class="devices-item-header">
              <div>
                <p class="devices-item-kind">${escapeHtml(device.kind)}</p>
                <h2>${escapeHtml(device.label)}</h2>
              </div>
              ${renderStatusPill(device)}
            </header>
            <p class="devices-meta">${renderMeta(device)}</p>
            <details class="devices-details">
              <summary>Raw details</summary>
              <pre>${escapeHtml(JSON.stringify(device.raw, null, 2))}</pre>
            </details>
          </article>
        `).join("")}
      </section>
    `;
  }

  function renderPage(routeBase, devices, filteredDevices, query, scope, error) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Devices</title>
    <style>
      :root {
        color-scheme: light;
        --surface: #f7f9fc;
        --surface-low: #edf2f7;
        --surface-lowest: #ffffff;
        --text: #191c1e;
        --muted: #63727c;
        --primary: #003466;
        --primary-container: #1a4b84;
        --accent: #1a4b84;
        --ghost-line: rgba(25, 28, 30, 0.12);
        --ghost-line-strong: rgba(25, 28, 30, 0.18);
        --shadow: 0 20px 40px rgba(25, 28, 30, 0.06), 0 10px 10px rgba(25, 28, 30, 0.04);
        font-family: Manrope, system-ui, sans-serif;
      }

      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body { background: transparent; color: var(--text); }
      main {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 100vh;
      }
      .devices-toolbar {
        display: grid;
        grid-template-columns: auto auto minmax(320px, 1fr);
        gap: 18px 24px;
        align-items: end;
        padding: 18px 20px 14px;
        background: rgba(247, 249, 252, 0.72);
        backdrop-filter: blur(10px) saturate(1.04);
        -webkit-backdrop-filter: blur(10px) saturate(1.04);
      }
      .devices-toolbar-copy h1,
      .devices-item h2,
      .devices-empty h2 {
        margin: 0;
        font-family: "Space Grotesk", system-ui, sans-serif;
        font-weight: 600;
      }
      .devices-toolbar-copy h1 { font-size: 30px; line-height: 1.02; }
      .devices-eyebrow,
      .devices-field span,
      .devices-item-kind,
      .devices-metric-label {
        margin: 0 0 6px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .devices-subtitle,
      .devices-meta,
      .devices-empty p {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 13px;
      }
      .devices-summary {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      .devices-metric {
        min-width: 92px;
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.62);
        border-radius: 12px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.62);
      }
      .devices-metric strong {
        display: block;
        font-size: 22px;
        line-height: 1;
      }
      .devices-toolbar-form {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) 170px auto;
        gap: 12px;
        align-items: end;
      }
      .devices-field {
        display: grid;
        gap: 6px;
      }
      .devices-field input,
      .devices-field select {
        width: 100%;
        min-height: 42px;
        border: 0;
        border-left: 2px solid transparent;
        border-radius: 4px;
        padding: 0 12px;
        background: var(--surface-low);
        color: var(--text);
        font: inherit;
        outline: none;
      }
      .devices-field input:focus,
      .devices-field select:focus {
        background: var(--surface-lowest);
        border-left-color: var(--accent);
      }
      .devices-toolbar-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: flex-end;
      }
      .devices-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 38px;
        padding: 0 14px;
        border-radius: 8px;
        border: 0;
        font: inherit;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
      }
      .devices-btn-primary {
        background: linear-gradient(135deg, var(--primary), var(--primary-container));
        color: white;
        box-shadow: 0 10px 22px rgba(9, 45, 90, 0.18);
      }
      .devices-btn-quiet {
        background: rgba(255,255,255,0.64);
        color: var(--text);
      }
      .devices-stage {
        display: grid;
        align-content: start;
        gap: 14px;
        padding: 14px 20px 20px;
      }
      .devices-error {
        color: #7b412d;
        background: rgba(144, 75, 54, 0.12);
        padding: 10px 12px;
        border-radius: 10px;
      }
      .devices-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 14px;
      }
      .devices-item,
      .devices-empty {
        background: var(--surface-low);
        border-radius: 14px;
        padding: 16px;
        box-shadow: var(--shadow);
      }
      .devices-item-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .devices-item h2 { font-size: 24px; line-height: 1.04; }
      .devices-pill {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 0 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        background: rgba(26, 75, 132, 0.1);
        color: var(--accent);
      }
      .devices-pill.is-offline {
        background: rgba(99, 114, 124, 0.12);
        color: var(--muted);
      }
      .devices-meta {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .devices-meta code {
        font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 12px;
        color: var(--accent);
      }
      .devices-meta-sep { color: rgba(25, 28, 30, 0.22); }
      .devices-details {
        margin-top: 14px;
        background: rgba(255,255,255,0.52);
        border-radius: 12px;
        padding: 10px 12px 12px;
      }
      .devices-details summary {
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
        list-style: none;
      }
      .devices-details summary::-webkit-details-marker { display: none; }
      .devices-details pre {
        margin: 12px 0 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: 12px/1.5 "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
        color: var(--muted);
      }
      @media (max-width: 980px) {
        .devices-toolbar {
          grid-template-columns: 1fr;
          padding: 14px;
        }
        .devices-toolbar-form {
          grid-template-columns: 1fr;
        }
        .devices-toolbar-actions {
          justify-content: flex-start;
        }
        .devices-stage {
          padding: 12px 14px 16px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      ${renderToolbar(routeBase, query, scope, devices)}
      <section class="devices-stage">
        ${error ? `<section class="devices-error">${escapeHtml(error)}</section>` : ""}
        ${renderDevices(filteredDevices)}
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
  const routeBase = appFrame.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/devices";
  if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
    return new Response("Not Found", { status: 404 });
  }
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const query = String(url.searchParams.get("q") ?? "").trim();
  const rawScope = String(url.searchParams.get("scope") ?? "all").trim();
  const scope = rawScope === "online" || rawScope === "offline" ? rawScope : "all";

  let devices = [];
  let error = "";
  try {
    const listing = await kernel.request("sys.device.list", {});
    devices = asDeviceList(listing).map(normalizeDevice);
    devices.sort((left, right) => {
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const filteredDevices = filterDevices(devices, query, scope);

  return new Response(renderPage(routeBase, devices, filteredDevices, query, scope, error), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default { fetch: handleFetch };
