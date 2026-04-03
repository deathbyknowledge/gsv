import { WorkerEntrypoint } from "cloudflare:workers";

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
    return '<p class="muted">No connected devices reported.</p>';
  }

  return `<ul class="device-list">${devices.map((device) => {
    const id = device?.id ?? device?.deviceId ?? "unknown";
    const label = device?.label ?? device?.name ?? id;
    const status = device?.status ?? (device?.online ? "online" : "offline");
    return `<li><strong>${escapeHtml(label)}</strong><span class="muted">${escapeHtml(String(id))} · ${escapeHtml(String(status))}</span></li>`;
  }).join("")}</ul>`;
}

function renderResult(result, error) {
  if (error) {
    return `<section class="panel error"><h2>Command failed</h2><pre>${escapeHtml(error)}</pre></section>`;
  }
  if (!result) {
    return "";
  }
  return `
    <section class="panel">
      <h2>Result</h2>
      <p class="muted">exit ${escapeHtml(result.exitCode ?? "?")}</p>
      <div class="output-grid">
        <article>
          <h3>stdout</h3>
          <pre>${escapeHtml(result.stdout ?? "")}</pre>
        </article>
        <article>
          <h3>stderr</h3>
          <pre>${escapeHtml(result.stderr ?? "")}</pre>
        </article>
      </div>
    </section>`;
}

function renderPage(routeBase, command, result, error, devices) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Shell</title>
    <link rel="stylesheet" href="/runtime/theme.css" />
    <style>
      main { max-width: 1040px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
      .panel { border: 1px solid var(--edge); background: var(--panel); border-radius: 22px; padding: 20px; box-shadow: 0 22px 60px rgba(0, 0, 0, 0.35); }
      h1, h2, h3, p { margin: 0; }
      h1 { font-size: clamp(28px, 5vw, 52px); }
      h2 { font-size: 20px; margin-bottom: 10px; }
      h3 { font-size: 14px; margin-bottom: 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em; }
      .muted { color: var(--muted); }
      .eyebrow { text-transform: uppercase; letter-spacing: 0.16em; font-size: 11px; color: var(--accent); margin-bottom: 8px; }
      form { display: grid; gap: 12px; margin-top: 16px; }
      textarea { min-height: 140px; resize: vertical; border-radius: 16px; border: 1px solid var(--edge); background: rgba(5, 9, 19, 0.66); color: var(--text); padding: 14px; font: 500 14px/1.6 "SFMono-Regular", "Consolas", monospace; }
      button { width: fit-content; border: 1px solid rgba(138, 224, 255, 0.24); background: rgba(138, 224, 255, 0.14); color: var(--text); border-radius: 999px; padding: 9px 14px; font: inherit; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; border-radius: 16px; background: rgba(5, 9, 19, 0.8); padding: 14px; color: var(--text); }
      .output-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-top: 14px; }
      .device-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
      .device-list li { display: grid; gap: 2px; padding: 12px 14px; border-radius: 14px; background: rgba(138, 224, 255, 0.08); }
      .error { border-color: rgba(255, 132, 132, 0.24); }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <p class="eyebrow">Package-served shell</p>
        <h1>Shell</h1>
        <p class="muted">This app is served from <code>${escapeHtml(routeBase)}</code> and executes commands through <code>KERNEL.request("shell.exec", ...)</code>.</p>
        <form method="post">
          <textarea name="command" spellcheck="false">${escapeHtml(command)}</textarea>
          <button type="submit">Run command</button>
        </form>
      </section>
      ${renderResult(result, error)}
      <section class="panel">
        <h2>Connected devices</h2>
        ${renderDevices(devices)}
      </section>
    </main>
  </body>
</html>`;
}

export default class ShellApp extends WorkerEntrypoint {
  async fetch(request) {
    const appFrame = this.ctx.props.appFrame;
    const kernel = this.ctx.props.kernel;
    if (!appFrame || !kernel) {
      return new Response("App frame missing", { status: 500 });
    }

    const url = new URL(request.url);
    const routeBase = appFrame.routeBase ?? this.env.PACKAGE_ROUTE_BASE ?? "/apps/shell";
    if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let command = "pwd\nls";
    let result = null;
    let error = "";

    if (request.method === "POST") {
      try {
        const form = await request.formData();
        command = String(form.get("command") ?? "").trim();
        if (!command) {
          error = "command is required";
        } else {
          result = await kernel.request("shell.exec", { command });
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }

    let devices = [];
    try {
      const listing = await kernel.request("sys.device.list", {});
      devices = asDeviceList(listing);
    } catch {
      devices = [];
    }

    return new Response(renderPage(routeBase, command, result, error, devices), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
}
