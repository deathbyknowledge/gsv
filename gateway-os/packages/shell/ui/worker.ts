const SHELL_APP_SCRIPT = String.raw`
import { init, Terminal, FitAddon } from 'https://cdn.jsdelivr.net/npm/ghostty-web@0.4.0/+esm';

const routeBase = document.body.dataset.routeBase || '/apps/shell';
const streamNode = document.querySelector('[data-shell-terminal]');
const statusNode = document.querySelector('[data-shell-status]');
const targetSelect = document.querySelector('[data-shell-target]');
const workdirInput = document.querySelector('[data-shell-workdir]');
const timeoutInput = document.querySelector('[data-shell-timeout]');
const yieldInput = document.querySelector('[data-shell-yield]');
const backgroundInput = document.querySelector('[data-shell-background]');

let terminal = null;
let fitAddon = null;

let username = localStorage.getItem('gsv.ui.gateway.username') || 'user';
let currentLine = '';
let history = [];
let historyCursor = null;
let historyDraft = '';
let running = false;

function setStatus(kind) {
  if (!statusNode) return;
  statusNode.dataset.kind = kind;
}

function currentTarget() {
  return targetSelect && targetSelect.value ? targetSelect.value : 'gsv';
}

function currentPath() {
  const value = workdirInput && workdirInput.value ? workdirInput.value.trim() : '';
  return value || '~';
}

function promptText() {
  return username + '@' + currentTarget() + ':' + currentPath() + ' $ ';
}

function writePrompt() {
  terminal.write(promptText());
}

function syncCurrentLine() {
  terminal.write('\r\x1b[2K');
  terminal.write(promptText() + currentLine);
}

function pushHistory(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return;
  if (history[history.length - 1] !== trimmed) {
    history.push(trimmed);
  }
  if (history.length > 200) {
    history = history.slice(-200);
  }
  historyCursor = null;
  historyDraft = '';
}

function navigateHistory(direction) {
  if (history.length === 0) return;
  if (historyCursor === null) {
    historyDraft = currentLine;
    historyCursor = history.length;
  }
  const nextIndex = historyCursor + direction;
  if (nextIndex < 0) {
    historyCursor = 0;
  } else if (nextIndex > history.length) {
    historyCursor = history.length;
  } else {
    historyCursor = nextIndex;
  }
  currentLine = historyCursor === history.length ? historyDraft : (history[historyCursor] || '');
  syncCurrentLine();
}

function clearTerminal() {
  terminal.reset();
  currentLine = '';
  writePrompt();
}

async function runCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || running) {
    return;
  }

  pushHistory(trimmed);
  running = true;
  setStatus('working');

  terminal.write('\r\n');

  try {
    const response = await fetch(routeBase, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        target: currentTarget(),
        command: trimmed,
        workdir: workdirInput ? workdirInput.value : '',
        timeout: timeoutInput ? timeoutInput.value : '',
        yieldMs: yieldInput ? yieldInput.value : '',
        background: backgroundInput ? backgroundInput.checked : false,
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || ('Request failed with ' + response.status));
    }

    const entry = data.entry || {};
    if (entry.stdout && String(entry.stdout).length > 0) {
      terminal.write(String(entry.stdout).replaceAll('\n', '\r\n'));
      if (!String(entry.stdout).endsWith('\n')) {
        terminal.write('\r\n');
      }
    }
    if (entry.stderr && String(entry.stderr).length > 0) {
      terminal.write('\x1b[38;2;255;182;173m' + String(entry.stderr).replaceAll('\n', '\r\n') + '\x1b[0m');
      if (!String(entry.stderr).endsWith('\n')) {
        terminal.write('\r\n');
      }
    }
    setStatus('ready');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminal.write('\x1b[38;2;255;182;173m' + message.replaceAll('\n', '\r\n') + '\x1b[0m\r\n');
    setStatus('error');
  } finally {
    running = false;
    currentLine = '';
    writePrompt();
  }
}

await init();
terminal = new Terminal({
  fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
  fontSize: 13,
  theme: {
    background: '#07111d',
    foreground: '#e3edf7',
    cursor: '#7fc6ff',
    black: '#07111d',
    red: '#ff9d8f',
    green: '#9dd3a8',
    yellow: '#e4d39a',
    blue: '#7fc6ff',
    magenta: '#c4a6ff',
    cyan: '#88d4ff',
    white: '#e3edf7',
    brightBlack: '#5f7388',
    brightRed: '#ffb6ad',
    brightGreen: '#b9e6c0',
    brightYellow: '#f0e1ad',
    brightBlue: '#a9dcff',
    brightMagenta: '#d7c0ff',
    brightCyan: '#b1e8ff',
    brightWhite: '#f6fbff',
  },
  cursorBlink: true,
  cursorStyle: 'bar',
  convertEol: true,
});
fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(streamNode);
fitAddon.fit();
terminal.focus();
writePrompt();
setStatus('ready');

terminal.onData((data) => {
  if (running) {
    return;
  }

  switch (data) {
    case '\r':
      void runCommand(currentLine);
      return;
    case '\u007f':
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        terminal.write('\b \b');
      }
      return;
    case '\u001b[A':
      navigateHistory(-1);
      return;
    case '\u001b[B':
      navigateHistory(1);
      return;
    case '\u0003':
      currentLine = '';
      terminal.write('^C\r\n');
      writePrompt();
      return;
    default:
      break;
  }

  if (data === '\n') {
    return;
  }

  currentLine += data;
  terminal.write(data);
});

for (const node of [targetSelect, workdirInput, timeoutInput, yieldInput, backgroundInput]) {
  if (!node) continue;
  node.addEventListener('change', () => {
    if (!running && currentLine.length === 0) {
      syncCurrentLine();
    }
  });
}

window.addEventListener('resize', () => {
  if (fitAddon) {
    fitAddon.fit();
  }
  terminal.focus();
});
`;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
  const trimmed = String(raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : 'gsv';
}

function asRecord(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value;
}

function asString(value) {
  return typeof value === 'string' ? value : null;
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseOptionalPositiveInt(raw) {
  const trimmed = String(raw ?? '').trim();
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
    stdout: '',
    stderr: '',
  };

  if (!record) {
    entry.stdout = prettyJson(payload);
    return entry;
  }

  const explicitOk = asBoolean(record.ok);
  const statusText = (asString(record.status) ?? '').toLowerCase();
  const exitCode = asNumber(record.exitCode);
  const stdout =
    asString(record.stdout) ??
    ((statusText === 'completed' || statusText === 'failed') ? asString(record.output) : null) ??
    '';
  const stderr = asString(record.stderr) ?? '';
  const errorText = asString(record.error);

  entry.stdout = stdout;
  entry.stderr = stderr;

  const backgrounded =
    asBoolean(record.backgrounded) === true ||
    (statusText === 'running' && asString(record.sessionId) !== null);

  if (backgrounded) {
    entry.stdout = asString(record.output) ?? 'Started in background.';
    entry.stderr = '';
    return entry;
  }

  if (explicitOk === false || statusText === 'failed' || errorText) {
    entry.stderr = errorText ?? entry.stderr;
    return entry;
  }

  if (exitCode !== null && exitCode !== 0 && entry.stderr.trim().length === 0) {
    entry.stderr = `exit ${exitCode}`;
  }

  return entry;
}

function renderTargetOptions(devices) {
  const options = ['<option value="gsv">Kernel (gsv)</option>'];
  for (const device of devices) {
    const deviceId = String(device?.deviceId ?? device?.id ?? '').trim();
    if (!deviceId) {
      continue;
    }
    const online = typeof device?.online === 'boolean' ? device.online : true;
    const suffix = online ? ' · online' : ' · offline';
    options.push(`<option value="${escapeHtml(deviceId)}">${escapeHtml(deviceId + suffix)}</option>`);
  }
  return options.join('');
}

function renderPage(routeBase, devices) {
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
      main {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 100vh;
        background: rgba(7, 17, 29, 0.98);
      }
      .shell-toolbar {
        display: grid;
        grid-template-columns: minmax(180px, 220px) minmax(220px, 1fr) auto auto;
        gap: 10px;
        align-items: end;
        padding: 10px 12px 8px;
        border-bottom: 1px solid rgba(42, 50, 56, 0.08);
        background: transparent;
      }
      .shell-field span,
      .shell-toggle {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #61737b;
      }
      .shell-field {
        display: grid;
        gap: 4px;
      }
      .shell-field input,
      .shell-field select {
        width: 100%;
        min-height: 34px;
        border: 0;
        border: 1px solid transparent;
        border-radius: 4px;
        padding: 0 10px;
        background: rgba(255, 255, 255, 0.78);
        color: #1f2d33;
        font: inherit;
        outline: none;
        transition: border-color 120ms ease, background 120ms ease;
      }
      .shell-field input:focus,
      .shell-field select:focus {
        border-color: rgba(26, 75, 132, 0.24);
        background: rgba(255, 255, 255, 0.96);
      }
      .shell-toolbar-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        justify-content: flex-end;
        flex-wrap: wrap;
      }
      .shell-status-indicator {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 999px;
        background: transparent;
      }
      .shell-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--shell-muted);
        box-shadow: 0 0 0 3px rgba(143, 163, 184, 0.16);
      }
      .shell-status-indicator[data-kind="working"] .shell-status-dot {
        background: var(--shell-prompt);
        box-shadow: 0 0 0 3px rgba(127, 198, 255, 0.18);
      }
      .shell-status-indicator[data-kind="error"] .shell-status-dot {
        background: var(--shell-stderr);
        box-shadow: 0 0 0 3px rgba(255, 182, 173, 0.16);
      }
      .shell-status-indicator[data-kind="ready"] .shell-status-dot {
        background: #9dd3a8;
        box-shadow: 0 0 0 3px rgba(157, 211, 168, 0.16);
      }
      .shell-btn,
      .shell-toolbar details summary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 34px;
        min-width: 34px;
        padding: 0 10px;
        border-radius: 6px;
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
        background: rgba(233, 239, 246, 0.76);
        color: #1f2d33;
      }
      .shell-toolbar details summary {
        list-style: none;
        padding: 0;
        font-size: 16px;
      }
      .shell-toolbar details summary::-webkit-details-marker {
        display: none;
      }
      .shell-toolbar details {
        position: relative;
      }
      .shell-options {
        position: absolute;
        right: 0;
        top: 100%;
        margin-top: 10px;
        z-index: 10;
        min-width: 280px;
        display: grid;
        gap: 10px;
        padding: 12px;
        border-radius: 12px;
        background: rgba(247, 249, 252, 0.96);
        box-shadow: 0 20px 40px rgba(38, 42, 47, 0.12);
        border: 1px solid rgba(42, 50, 56, 0.08);
      }
      .shell-toggle-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .shell-stage {
        display: grid;
        grid-template-rows: minmax(0, 1fr);
        min-height: 0;
      }
      .shell-terminal-wrap {
        min-height: 0;
        padding: 2px;
      }
      .shell-terminal {
        width: 100%;
        height: 100%;
        overflow: hidden;
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
      }
    </style>
  </head>
  <body data-route-base="${escapeHtml(routeBase)}">
    <main>
      <section class="shell-toolbar">
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
          <div class="shell-status-indicator" data-shell-status data-kind="ready" aria-label="Shell status" title="Shell ready">
            <span class="shell-status-dot" aria-hidden="true"></span>
          </div>
          <details>
            <summary aria-label="Shell options" title="Shell options">⚙</summary>
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
        <div class="shell-terminal-wrap">
          <div class="shell-terminal" data-shell-terminal></div>
        </div>
      </section>
    </main>
    <script type="module" src="${escapeHtml(`${routeBase.replace(/\/$/, '')}/app.js`)}"></script>
  </body>
</html>`;
}

export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};
  const appFrame = props.appFrame;
  const kernel = props.kernel;
  if (!appFrame || !kernel) {
    return new Response('App frame missing', { status: 500 });
  }

  const url = new URL(request.url);
  const routeBase = appFrame.routeBase ?? env.PACKAGE_ROUTE_BASE ?? '/apps/shell';
  const assetPath = `${routeBase.replace(/\/$/, '')}/app.js`;
  if (url.pathname === assetPath) {
    return new Response(SHELL_APP_SCRIPT, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }
  if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
    return new Response('Not Found', { status: 404 });
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const command = String(body?.command ?? '').trim();
      if (!command) {
        return Response.json({ ok: false, error: 'Command is required.' }, { status: 400 });
      }

      const target = normalizeTarget(body?.target ?? 'gsv');
      const args = { command };
      if (target !== 'gsv') {
        args.target = target;
      }
      const workdir = String(body?.workdir ?? '').trim();
      if (workdir) {
        args.workdir = workdir;
      }
      const timeout = parseOptionalPositiveInt(body?.timeout ?? '');
      if (timeout !== null) {
        args.timeout = timeout;
      }
      const background = body?.background === true;
      if (background) {
        args.background = true;
        const yieldMs = parseOptionalPositiveInt(body?.yieldMs ?? '');
        if (yieldMs !== null) {
          args.yieldMs = yieldMs;
        }
      }

      const startedAt = Date.now();
      const payload = await kernel.request('shell.exec', args);
      const entry = normalizeTranscriptEntry(payload, startedAt, target, command);
      return Response.json({ ok: true, entry });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  }

  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let devices = [];
  try {
    const listing = await kernel.request('sys.device.list', {});
    devices = asDeviceList(listing);
    devices.sort((left, right) => String(left?.deviceId ?? left?.id ?? '').localeCompare(String(right?.deviceId ?? right?.id ?? '')));
  } catch {
    devices = [];
  }

  return new Response(renderPage(routeBase, devices), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default { fetch: handleFetch };
