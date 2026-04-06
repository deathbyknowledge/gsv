const SHELL_APP_SCRIPT = String.raw`
(() => {
  const bootstrapNode = document.getElementById('shell-bootstrap');
  const routeBase = document.body.dataset.routeBase || '/apps/shell';
  const initial = bootstrapNode ? JSON.parse(bootstrapNode.textContent || '{}') : {};

  const state = {
    transcript: Array.isArray(initial.transcript) ? initial.transcript.slice() : [],
    history: [],
    historyCursor: null,
    historyDraft: '',
    running: false,
  };

  const stream = document.querySelector('[data-shell-stream]');
  const status = document.querySelector('[data-shell-status]');
  const form = document.querySelector('[data-shell-form]');
  const commandInput = document.querySelector('[data-shell-command]');
  const targetSelect = document.querySelector('[data-shell-target]');
  const workdirInput = document.querySelector('[data-shell-workdir]');
  const timeoutInput = document.querySelector('[data-shell-timeout]');
  const yieldMsInput = document.querySelector('[data-shell-yield]');
  const backgroundInput = document.querySelector('[data-shell-background]');
  const clearButton = document.querySelector('[data-shell-clear]');
  const refreshButton = document.querySelector('[data-shell-refresh]');
  const submitButton = document.querySelector('[data-shell-submit]');

  function setStatus(kind, text) {
    if (!status) return;
    status.dataset.kind = kind;
    status.textContent = text || '';
  }

  function isNearBottom() {
    if (!stream) return true;
    const remaining = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
    return remaining < 96;
  }

  function scrollToBottom() {
    if (!stream) return;
    stream.scrollTop = stream.scrollHeight;
  }

  function renderTranscript() {
    if (!stream) return;
    stream.innerHTML = '';

    if (state.transcript.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'shell-empty';
      empty.textContent = 'No commands yet. Type one below and press Enter.';
      stream.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of state.transcript) {
      const article = document.createElement('article');
      article.className = 'shell-log-entry';

      const commandRow = document.createElement('div');
      commandRow.className = 'shell-log-command-row';

      const prompt = document.createElement('span');
      prompt.className = 'shell-log-prompt';
      prompt.textContent = `${entry.target}$`;
      commandRow.appendChild(prompt);

      const command = document.createElement('code');
      command.className = 'shell-log-command';
      command.textContent = entry.command;
      commandRow.appendChild(command);
      article.appendChild(commandRow);

      if (entry.stdout && entry.stdout.trim().length > 0) {
        const out = document.createElement('pre');
        out.className = 'shell-log-stream is-stdout';
        out.textContent = entry.stdout;
        article.appendChild(out);
      }

      if (entry.stderr && entry.stderr.trim().length > 0) {
        const err = document.createElement('pre');
        err.className = 'shell-log-stream is-stderr';
        err.textContent = entry.stderr;
        article.appendChild(err);
      }

      fragment.appendChild(article);
    }

    stream.appendChild(fragment);
  }

  function rememberCommand(command) {
    const trimmed = String(command || '').trim();
    if (!trimmed) return;
    if (state.history[state.history.length - 1] !== trimmed) {
      state.history.push(trimmed);
    }
    if (state.history.length > 200) {
      state.history = state.history.slice(-200);
    }
    state.historyCursor = null;
    state.historyDraft = '';
  }

  function navigateHistory(direction) {
    if (!commandInput || state.history.length === 0) return;
    if (state.historyCursor === null) {
      state.historyDraft = commandInput.value;
      state.historyCursor = state.history.length;
    }

    const nextIndex = state.historyCursor + direction;
    if (nextIndex < 0) {
      state.historyCursor = 0;
    } else if (nextIndex > state.history.length) {
      state.historyCursor = state.history.length;
    } else {
      state.historyCursor = nextIndex;
    }

    if (state.historyCursor === state.history.length) {
      commandInput.value = state.historyDraft;
    } else {
      commandInput.value = state.history[state.historyCursor] || '';
    }

    const cursor = commandInput.value.length;
    commandInput.setSelectionRange(cursor, cursor);
  }

  function setRunning(running) {
    state.running = running;
    if (submitButton) submitButton.disabled = running;
    if (commandInput) commandInput.disabled = running;
    if (targetSelect) targetSelect.disabled = running;
    if (workdirInput) workdirInput.disabled = running;
    if (timeoutInput) timeoutInput.disabled = running;
    if (yieldMsInput) yieldMsInput.disabled = running;
    if (backgroundInput) backgroundInput.disabled = running;
  }

  async function runCommand() {
    if (!commandInput || !targetSelect) return;
    const command = commandInput.value.trim();
    if (!command) {
      setStatus('error', 'Command is required.');
      return;
    }

    const shouldStick = isNearBottom();
    const payload = {
      target: targetSelect.value,
      command,
      workdir: workdirInput ? workdirInput.value : '',
      timeout: timeoutInput ? timeoutInput.value : '',
      yieldMs: yieldMsInput ? yieldMsInput.value : '',
      background: backgroundInput ? backgroundInput.checked : false,
    };

    rememberCommand(command);
    setRunning(true);
    setStatus('working', 'Running command…');

    try {
      const response = await fetch(routeBase, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shell-json': '1',
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Request failed with ${response.status}`);
      }

      state.transcript = [...state.transcript, data.entry].slice(-120);
      renderTranscript();
      commandInput.value = '';
      setStatus('ready', 'Shell is ready.');
      if (shouldStick) {
        requestAnimationFrame(scrollToBottom);
      }
    } catch (error) {
      state.transcript = [...state.transcript, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        target: payload.target || 'gsv',
        command,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      }].slice(-120);
      renderTranscript();
      setStatus('error', error instanceof Error ? error.message : String(error));
      requestAnimationFrame(scrollToBottom);
    } finally {
      setRunning(false);
      requestAnimationFrame(() => {
        if (commandInput) {
          commandInput.focus();
          const cursor = commandInput.value.length;
          commandInput.setSelectionRange(cursor, cursor);
        }
      });
    }
  }

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void runCommand();
    });
  }

  if (commandInput) {
    commandInput.addEventListener('keydown', (event) => {
      const selectionStart = commandInput.selectionStart || 0;
      const selectionEnd = commandInput.selectionEnd || 0;

      if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'ArrowUp' && selectionStart === 0 && selectionEnd === 0) {
        event.preventDefault();
        navigateHistory(-1);
        return;
      }

      if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'ArrowDown' && selectionStart === commandInput.value.length && selectionEnd === commandInput.value.length) {
        event.preventDefault();
        navigateHistory(1);
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        void runCommand();
      }
    });
  }

  if (clearButton) {
    clearButton.addEventListener('click', () => {
      state.transcript = [];
      renderTranscript();
      setStatus('ready', 'Shell is ready.');
    });
  }

  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      window.location.reload();
    });
  }

  renderTranscript();
  setStatus('ready', 'Shell is ready.');
  requestAnimationFrame(() => {
    if (commandInput) commandInput.focus();
    scrollToBottom();
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

function asDeviceList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.devices)) {
    return value.devices;
  }
  return [];
}

function normalizeTarget(raw) {
  const trimmed = String(raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : "gsv";
}

function asRecord(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value;
}

function asString(value) {
  return typeof value === "string" ? value : null;
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseOptionalPositiveInt(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizeTranscriptEntry(payload, startedAt, target, command) {
  const completedAt = Date.now();
  const record = asRecord(payload);
  const entry = {
    id: `${startedAt}-${completedAt}`,
    target,
    command,
    stdout: "",
    stderr: "",
  };

  if (!record) {
    entry.stdout = prettyJson(payload);
    return entry;
  }

  const explicitOk = asBoolean(record.ok);
  const statusText = (asString(record.status) ?? "").toLowerCase();
  const exitCode = asNumber(record.exitCode);
  const stdout =
    asString(record.stdout) ??
    ((statusText === "completed" || statusText === "failed") ? asString(record.output) : null) ??
    "";
  const stderr = asString(record.stderr) ?? "";
  const errorText = asString(record.error);

  entry.stdout = stdout;
  entry.stderr = stderr;

  const backgrounded =
    asBoolean(record.backgrounded) === true ||
    (statusText === "running" && asString(record.sessionId) !== null);

  if (backgrounded) {
    entry.stdout = asString(record.output) ?? "Started in background.";
    entry.stderr = "";
    return entry;
  }

  if (explicitOk === false || statusText === "failed" || errorText) {
    entry.stderr = errorText ?? entry.stderr;
    return entry;
  }

  if (exitCode !== null && exitCode !== 0 && entry.stderr.trim().length === 0) {
    entry.stderr = `exit ${exitCode}`;
  }

  return entry;
}

function renderTargetOptions(devices) {
  const options = [`<option value="gsv">Kernel (gsv)</option>`];
  for (const device of devices) {
    const deviceId = String(device?.deviceId ?? device?.id ?? "").trim();
    if (!deviceId) {
      continue;
    }
    const online = typeof device?.online === "boolean" ? device.online : true;
    const suffix = online ? " · online" : " · offline";
    options.push(`<option value="${escapeHtml(deviceId)}">${escapeHtml(deviceId + suffix)}</option>`);
  }
  return options.join("");
}

function renderPage(routeBase, devices) {
  const initialState = {
    transcript: [],
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Shell</title>
    <style>
      :root {
        color-scheme: dark;
        --shell-bg: #07111d;
        --shell-panel: #0b1624;
        --shell-panel-hi: #122235;
        --shell-line: rgba(120, 160, 205, 0.14);
        --shell-text: #e3edf7;
        --shell-muted: #8fa3b8;
        --shell-prompt: #7fc6ff;
        --shell-stdout: #dfeaf7;
        --shell-stderr: #ffb6ad;
        --shell-accent: #4da2ff;
        --shell-accent-2: #1a4b84;
        --shell-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
        font-family: Manrope, system-ui, sans-serif;
      }

      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; }
      body {
        background: transparent;
        color: var(--shell-text);
      }
      body[data-route-base] {
        display: block;
      }
      main {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 100vh;
        background: linear-gradient(180deg, rgba(7,17,29,0.92), rgba(11,22,36,0.98));
      }
      .shell-toolbar {
        display: grid;
        grid-template-columns: minmax(160px, auto) minmax(180px, 220px) minmax(220px, 1fr) auto;
        gap: 12px;
        align-items: end;
        padding: 14px 16px 12px;
        border-bottom: 1px solid var(--shell-line);
        background: rgba(7, 17, 29, 0.74);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }
      .shell-toolbar-copy {
        display: grid;
        gap: 4px;
        align-content: end;
      }
      .shell-toolbar-copy h1 {
        margin: 0;
        font: 600 24px/1 "Space Grotesk", system-ui, sans-serif;
      }
      .shell-eyebrow,
      .shell-field span,
      .shell-toggle {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--shell-muted);
      }
      .shell-field {
        display: grid;
        gap: 6px;
      }
      .shell-field input,
      .shell-field select {
        width: 100%;
        min-height: 38px;
        border: 0;
        border-left: 2px solid transparent;
        border-radius: 4px;
        padding: 0 12px;
        background: rgba(18, 34, 53, 0.92);
        color: var(--shell-text);
        font: inherit;
        outline: none;
      }
      .shell-field input:focus,
      .shell-field select:focus,
      .shell-compose textarea:focus {
        border-left-color: var(--shell-accent);
        background: rgba(20, 39, 60, 0.98);
      }
      .shell-toolbar-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        justify-content: flex-end;
        flex-wrap: wrap;
      }
      .shell-btn,
      .shell-toolbar details summary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        padding: 0 12px;
        border-radius: 8px;
        border: 0;
        font: inherit;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
      }
      .shell-btn-primary {
        background: linear-gradient(135deg, var(--shell-accent-2), var(--shell-accent));
        color: white;
        box-shadow: 0 10px 22px rgba(20, 64, 115, 0.28);
      }
      .shell-btn-quiet,
      .shell-toolbar details summary {
        background: rgba(18, 34, 53, 0.92);
        color: var(--shell-text);
      }
      .shell-toolbar details {
        position: relative;
      }
      .shell-toolbar details[open] summary {
        margin-bottom: 10px;
      }
      .shell-options {
        position: absolute;
        right: 0;
        top: 100%;
        z-index: 10;
        min-width: 280px;
        display: grid;
        gap: 10px;
        padding: 12px;
        border-radius: 12px;
        background: rgba(10, 21, 35, 0.98);
        box-shadow: var(--shell-shadow);
        border: 1px solid var(--shell-line);
      }
      .shell-toggle-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .shell-stage {
        display: grid;
        grid-template-rows: minmax(0, 1fr) auto;
        min-height: 0;
      }
      .shell-status {
        min-height: 20px;
        padding: 10px 16px 0;
        color: var(--shell-muted);
        font-size: 13px;
      }
      .shell-status[data-kind="error"] {
        color: var(--shell-stderr);
      }
      .shell-status[data-kind="working"] {
        color: var(--shell-prompt);
      }
      .shell-stream {
        min-height: 0;
        overflow: auto;
        padding: 14px 16px 18px;
        font: 13px/1.55 "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      }
      .shell-empty {
        margin: 0;
        color: var(--shell-muted);
      }
      .shell-log-entry {
        display: grid;
        gap: 6px;
        margin: 0 0 16px;
      }
      .shell-log-command-row {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        white-space: pre-wrap;
      }
      .shell-log-prompt,
      .shell-compose-prompt {
        color: var(--shell-prompt);
        font-weight: 700;
        flex: 0 0 auto;
      }
      .shell-log-command {
        color: var(--shell-text);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .shell-log-stream {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--shell-stdout);
      }
      .shell-log-stream.is-stderr {
        color: var(--shell-stderr);
      }
      .shell-compose {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 12px;
        align-items: end;
        padding: 14px 16px 16px;
        border-top: 1px solid var(--shell-line);
        background: rgba(7, 17, 29, 0.94);
      }
      .shell-compose textarea {
        width: 100%;
        min-height: 56px;
        max-height: 220px;
        resize: vertical;
        border: 0;
        border-left: 2px solid transparent;
        border-radius: 8px;
        padding: 12px 14px;
        background: rgba(18, 34, 53, 0.92);
        color: var(--shell-text);
        font: inherit;
        outline: none;
      }
      @media (max-width: 980px) {
        .shell-toolbar {
          grid-template-columns: 1fr;
        }
        .shell-toolbar-actions {
          justify-content: flex-start;
        }
        .shell-options {
          position: static;
          min-width: 0;
        }
        .shell-compose {
          grid-template-columns: auto minmax(0, 1fr);
        }
        .shell-compose .shell-btn-primary {
          grid-column: 2;
          justify-self: flex-end;
        }
      }
    </style>
  </head>
  <body data-route-base="${escapeHtml(routeBase)}">
    <main>
      <section class="shell-toolbar">
        <div class="shell-toolbar-copy">
          <span class="shell-eyebrow">Command surface</span>
          <h1>Shell</h1>
        </div>
        <label class="shell-field">
          <span>Target</span>
          <select data-shell-target>
            ${renderTargetOptions(devices)}
          </select>
        </label>
        <label class="shell-field">
          <span>Working directory</span>
          <input data-shell-workdir type="text" value="" placeholder="Optional" spellcheck="false" />
        </label>
        <div class="shell-toolbar-actions">
          <button type="button" class="shell-btn shell-btn-quiet" data-shell-refresh>Refresh</button>
          <button type="button" class="shell-btn shell-btn-quiet" data-shell-clear>Clear</button>
          <details>
            <summary>Options</summary>
            <div class="shell-options">
              <label class="shell-field">
                <span>Timeout (ms)</span>
                <input data-shell-timeout type="text" inputmode="numeric" value="" placeholder="30000" />
              </label>
              <label class="shell-field">
                <span>Yield (ms)</span>
                <input data-shell-yield type="text" inputmode="numeric" value="" placeholder="2000" />
              </label>
              <label class="shell-toggle-row">
                <input data-shell-background type="checkbox" />
                <span class="shell-toggle">Run in background</span>
              </label>
            </div>
          </details>
        </div>
      </section>

      <section class="shell-stage">
        <div class="shell-status" data-shell-status></div>
        <section class="shell-stream" data-shell-stream></section>
        <form class="shell-compose" data-shell-form>
          <span class="shell-compose-prompt">gsv$</span>
          <textarea data-shell-command spellcheck="false" placeholder="Type command and press Enter. Shift+Enter for newline."></textarea>
          <button type="submit" class="shell-btn shell-btn-primary" data-shell-submit>Run</button>
        </form>
      </section>
    </main>
    <script id="shell-bootstrap" type="application/json">${escapeHtml(JSON.stringify(initialState))}</script>
    <script type="module" src="${escapeHtml(`${routeBase.replace(/\/$/, "")}/app.js`)}"></script>
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

  const url = new URL(request.url);
  const routeBase = appFrame.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/shell";
  const assetPath = `${routeBase.replace(/\/$/, "")}/app.js`;
  if (url.pathname === assetPath) {
    return new Response(SHELL_APP_SCRIPT, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method === "POST") {
    try {
      const body = await request.json();
      const command = String(body?.command ?? "").trim();
      if (!command) {
        return Response.json({ ok: false, error: "Command is required." }, { status: 400 });
      }

      const target = normalizeTarget(body?.target ?? "gsv");
      const args = { command };
      if (target !== "gsv") {
        args.target = target;
      }
      const workdir = String(body?.workdir ?? "").trim();
      if (workdir) {
        args.workdir = workdir;
      }
      const timeout = parseOptionalPositiveInt(body?.timeout ?? "");
      if (timeout !== null) {
        args.timeout = timeout;
      }
      const background = body?.background === true;
      if (background) {
        args.background = true;
        const yieldMs = parseOptionalPositiveInt(body?.yieldMs ?? "");
        if (yieldMs !== null) {
          args.yieldMs = yieldMs;
        }
      }

      const startedAt = Date.now();
      const payload = await kernel.request("shell.exec", args);
      const entry = normalizeTranscriptEntry(payload, startedAt, target, command);
      return Response.json({ ok: true, entry });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  }

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let devices = [];
  try {
    const listing = await kernel.request("sys.device.list", {});
    devices = asDeviceList(listing);
    devices.sort((left, right) => String(left?.deviceId ?? left?.id ?? "").localeCompare(String(right?.deviceId ?? right?.id ?? "")));
  } catch {
    devices = [];
  }

  return new Response(renderPage(routeBase, devices), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default { fetch: handleFetch };
