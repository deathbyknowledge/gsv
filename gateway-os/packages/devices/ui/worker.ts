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

function renderDevices(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    return '<article class="card"><p class="muted">No devices reported.</p></article>';
  }

  return devices.map((device) => {
    const id = device?.id ?? device?.deviceId ?? "unknown";
    const label = device?.label ?? device?.name ?? id;
    const status = device?.status ?? (device?.online ? "online" : "offline");
    const kind = device?.kind ?? device?.type ?? "device";
    const detail = JSON.stringify(device, null, 2);
    return `
      <article class="card">
        <div class="tag-row">
          <span class="tag">${escapeHtml(String(kind))}</span>
          <span class="tag">${escapeHtml(String(status))}</span>
        </div>
        <h2>${escapeHtml(String(label))}</h2>
        <p class="muted"><code>${escapeHtml(String(id))}</code></p>
        <pre>${escapeHtml(detail)}</pre>
      </article>`;
  }).join("");
}

function renderPage(routeBase, devices, error) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Devices</title>
    <link rel="stylesheet" href="/runtime/theme.css" />
    <style>
      main { max-width: 1040px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
      .hero, .card { border: 1px solid var(--edge); background: var(--panel); border-radius: 22px; padding: 20px; box-shadow: 0 22px 60px rgba(0, 0, 0, 0.35); }
      .hero p, .hero h1, .card p, .card h2 { margin: 0; }
      .hero h1 { font-size: clamp(28px, 5vw, 52px); margin-bottom: 10px; }
      .eyebrow { text-transform: uppercase; letter-spacing: 0.16em; font-size: 11px; color: var(--accent); margin-bottom: 8px; }
      .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
      .tag-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
      .tag { display: inline-flex; align-items: center; padding: 6px 10px; border-radius: 999px; background: rgba(138, 224, 255, 0.12); border: 1px solid rgba(138, 224, 255, 0.16); }
      .muted { color: var(--muted); }
      code { font-family: "SFMono-Regular", "Consolas", monospace; color: var(--accent); }
      pre { margin: 14px 0 0; white-space: pre-wrap; word-break: break-word; border-radius: 16px; background: rgba(5, 9, 19, 0.8); padding: 14px; color: var(--text); }
      .error { border-color: rgba(255, 132, 132, 0.24); background: rgba(255, 132, 132, 0.08); }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">Package-served devices</p>
        <h1>Devices</h1>
        <p class="muted">This app is served from <code>${escapeHtml(routeBase)}</code> and lists devices through <code>KERNEL.request("sys.device.list", ...)</code>.</p>
      </section>
      ${error ? `<section class="hero error"><p>${escapeHtml(error)}</p></section>` : ""}
      <section class="grid">${renderDevices(devices)}</section>
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

    let devices = [];
    let error = "";
    try {
      const listing = await kernel.request("sys.device.list", {});
      devices = asDeviceList(listing);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    return new Response(renderPage(routeBase, devices, error), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
}

export default { fetch: handleFetch };
