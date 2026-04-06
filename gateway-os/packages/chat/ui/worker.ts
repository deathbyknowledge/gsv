function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage(routeBase) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Chat</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
    <style>
      :root {
        color-scheme: light;
        --page: #eef3f7;
        --surface: rgba(247, 249, 252, 0.88);
        --surface-strong: rgba(255, 255, 255, 0.94);
        --surface-soft: rgba(232, 238, 243, 0.92);
        --text: #191c1e;
        --text-muted: rgba(25, 28, 30, 0.62);
        --text-soft: rgba(25, 28, 30, 0.46);
        --primary: #003466;
        --primary-soft: #1a4b84;
        --accent: #904b36;
        --shadow: 0 20px 40px rgba(25, 28, 30, 0.06), 0 10px 14px rgba(25, 28, 30, 0.04);
        --line: rgba(25, 28, 30, 0.08);
        --display: "Space Grotesk", "Avenir Next", sans-serif;
        --ui: "Manrope", "Segoe UI", sans-serif;
        --mono: "IBM Plex Mono", "SFMono-Regular", monospace;
      }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        font: 14px/1.55 var(--ui);
        color: var(--text);
        background:
          radial-gradient(circle at 18% 0%, rgba(255, 255, 255, 0.88) 0%, rgba(255, 255, 255, 0) 34%),
          linear-gradient(180deg, #f4f7fa 0%, var(--page) 100%);
      }
      button,
      textarea {
        font: inherit;
      }
      .chat-shell {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 300px minmax(0, 1fr);
        gap: 18px;
        padding: 18px;
      }
      .rail,
      .stage {
        min-width: 0;
        border-radius: 22px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      .rail {
        display: grid;
        grid-template-rows: auto 1fr;
        overflow: hidden;
      }
      .rail-head {
        padding: 18px 18px 14px;
        display: grid;
        gap: 14px;
      }
      .eyebrow {
        margin: 0;
        color: var(--text-soft);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .rail-title {
        margin: 0;
        font-family: var(--display);
        font-size: 1.75rem;
        line-height: 0.95;
        letter-spacing: -0.04em;
      }
      .rail-copy {
        margin: 0;
        color: var(--text-muted);
      }
      .rail-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .thread-status {
        min-height: 20px;
        margin: 0;
        color: var(--text-muted);
        font-size: 13px;
      }
      .thread-list {
        padding: 0 12px 12px;
        display: grid;
        gap: 10px;
        overflow: auto;
      }
      .thread-card {
        width: 100%;
        border: 0;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.72);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.62);
        color: inherit;
        padding: 14px;
        text-align: left;
        cursor: pointer;
        transition: transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
      }
      .thread-card:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 22px rgba(25, 28, 30, 0.07), inset 0 1px 0 rgba(255, 255, 255, 0.7);
      }
      .thread-card.is-active {
        background: rgba(235, 242, 248, 0.96);
        box-shadow: 0 16px 28px rgba(25, 28, 30, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.78);
      }
      .thread-title {
        display: block;
        font-weight: 700;
        font-size: 0.96rem;
      }
      .thread-meta {
        display: block;
        margin-top: 5px;
        color: var(--text-muted);
        font-size: 12px;
      }
      .stage {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        overflow: hidden;
      }
      .stage-head {
        padding: 20px 22px 18px;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .stage-title-wrap {
        min-width: 0;
      }
      .stage-title {
        margin: 0;
        font-family: var(--display);
        font-size: 2rem;
        line-height: 0.95;
        letter-spacing: -0.04em;
      }
      .stage-meta {
        margin: 8px 0 0;
        color: var(--text-muted);
      }
      .stage-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(232, 238, 243, 0.92);
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .pill.is-connected { color: #29533e; background: rgba(218, 235, 225, 0.92); }
      .pill.is-connecting { color: #785400; background: rgba(255, 241, 200, 0.92); }
      .pill.is-disconnected { color: #7a3030; background: rgba(255, 226, 226, 0.92); }
      .stage-body {
        min-height: 0;
        padding: 0 22px 20px;
      }
      .transcript {
        min-height: 100%;
        height: 100%;
        border-radius: 20px;
        background: var(--surface-soft);
        padding: 16px;
        display: grid;
        gap: 12px;
        overflow: auto;
      }
      .message {
        max-width: min(88%, 760px);
        border-radius: 18px;
        padding: 12px 14px;
        background: rgba(255, 255, 255, 0.78);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
      }
      .message-user {
        justify-self: end;
        background: linear-gradient(180deg, rgba(0, 52, 102, 0.12) 0%, rgba(26, 75, 132, 0.09) 100%), rgba(255, 255, 255, 0.78);
      }
      .message-assistant {
        justify-self: start;
      }
      .message-system {
        justify-self: center;
        max-width: min(94%, 760px);
        background: rgba(255, 255, 255, 0.56);
      }
      .message-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-soft);
      }
      .message-body {
        margin: 0;
        color: var(--text);
        white-space: pre-wrap;
        word-break: break-word;
        font: inherit;
      }
      .composer-wrap {
        padding: 0 22px 22px;
      }
      .composer {
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.84);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.76);
        padding: 16px;
        display: grid;
        gap: 12px;
      }
      .composer-field {
        width: 100%;
        min-height: 104px;
        resize: vertical;
        border: 0;
        border-radius: 14px;
        background: rgba(232, 238, 243, 0.78);
        color: var(--text);
        padding: 14px;
        outline: none;
      }
      .composer-field:focus {
        box-shadow: inset 3px 0 0 rgba(0, 52, 102, 0.45);
      }
      .composer-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        flex-wrap: wrap;
      }
      .composer-note {
        margin: 0;
        color: var(--text-muted);
      }
      .btn {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        cursor: pointer;
        font-weight: 700;
        transition: transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
      }
      .btn:hover { transform: translateY(-1px); }
      .btn:disabled { opacity: 0.45; cursor: default; transform: none; }
      .btn-quiet {
        background: rgba(232, 238, 243, 0.92);
        color: var(--text);
      }
      .btn-quiet:hover { background: rgba(225, 233, 239, 1); }
      .btn-primary {
        color: #f7fbff;
        background: linear-gradient(135deg, var(--primary) 0%, var(--primary-soft) 100%);
        box-shadow: 0 12px 24px rgba(0, 52, 102, 0.2);
      }
      .btn-primary:hover {
        box-shadow: 0 14px 26px rgba(0, 52, 102, 0.24);
      }
      .mono {
        font-family: var(--mono);
      }
      @media (max-width: 920px) {
        .chat-shell {
          grid-template-columns: 1fr;
          padding: 12px;
        }
        .stage-head,
        .composer-foot {
          flex-direction: column;
          align-items: stretch;
        }
        .stage-actions {
          justify-content: flex-start;
        }
      }
    </style>
  </head>
  <body>
    <main class="chat-shell">
      <aside class="rail">
        <div class="rail-head">
          <div>
            <p class="eyebrow">Workspace threads</p>
            <h1 class="rail-title">Conversations</h1>
            <p class="rail-copy">Pick up where you left off or start a new thread.</p>
          </div>
          <div class="rail-actions">
            <button type="button" class="btn btn-quiet" id="new-thread">New thread</button>
            <button type="button" class="btn btn-quiet" id="refresh-threads">Refresh</button>
          </div>
          <p class="thread-status" id="thread-status"></p>
        </div>
        <div class="thread-list" id="thread-list"></div>
      </aside>

      <section class="stage">
        <header class="stage-head">
          <div class="stage-title-wrap">
            <h1 class="stage-title" id="active-thread-title">New conversation</h1>
            <p class="stage-meta" id="active-thread-meta">Send a message to start a thread or reopen one from the left.</p>
          </div>
          <div class="stage-actions">
            <button type="button" class="btn btn-quiet" id="open-files">Files</button>
            <button type="button" class="btn btn-quiet" id="open-shell">Shell</button>
            <span class="pill is-connecting" id="connection-pill">connecting</span>
          </div>
        </header>

        <div class="stage-body">
          <section class="transcript" id="chat-log"></section>
        </div>

        <div class="composer-wrap">
          <form class="composer" id="chat-compose-form">
            <textarea class="composer-field" id="chat-input" placeholder="Ask something, continue a thread, or describe the task you want help with."></textarea>
            <div class="composer-foot">
              <p class="composer-note" id="compose-status">Waiting for desktop host.</p>
              <button type="submit" class="btn btn-primary" id="send-button">Send</button>
            </div>
          </form>
        </div>
      </section>
    </main>

    <script>
      const ROUTE_BASE = ${JSON.stringify(routeBase)};
      const WINDOW_ID = new URL(window.location.href).searchParams.get("windowId")?.trim() || "";
      const ACTIVE_THREAD_CONTEXT_KEY = "gsv.activeThreadContext.v1";
      const TARGET_CHAT_PROCESS_EVENT = "gsv:target-chat-process";
      const OPEN_APP_EVENT = "gsv:open-app";
      const PENDING_TARGETS_KEY = "__gsvPendingChatProcessTargets";
      const BRIDGE_TIMEOUT_MS = 20000;

      function asRecord(value) {
        return value && typeof value === "object" ? value : null;
      }

      function asString(value) {
        return typeof value === "string" ? value : null;
      }

      function escapeHtmlClient(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function prettyJson(value) {
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      }

      function formatMessageContent(value) {
        return typeof value === "string" ? value : prettyJson(value);
      }

      function normalizeTimestampMs(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return null;
        }
        if (value > 0 && value < 1000000000000) {
          return Math.floor(value * 1000);
        }
        return Math.floor(value);
      }

      function formatTimestamp(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return "";
        }
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }

      function formatRelativeTime(value) {
        const deltaMs = value - Date.now();
        const absDeltaMs = Math.abs(deltaMs);
        if (absDeltaMs < 60000) {
          return "just now";
        }
        const units = [["day", 86400000], ["hour", 3600000], ["minute", 60000]];
        for (const unit of units) {
          if (absDeltaMs >= unit[1]) {
            const amount = Math.round(deltaMs / unit[1]);
            return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(amount, unit[0]);
          }
        }
        return "just now";
      }

      function normalizeThreadContext(value) {
        const record = asRecord(value);
        if (!record) {
          return null;
        }
        const pid = typeof record.pid === "string" ? record.pid.trim() : "";
        const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
        const workspaceId = typeof record.workspaceId === "string" && record.workspaceId.trim().length > 0 ? record.workspaceId.trim() : null;
        if (!pid || !cwd) {
          return null;
        }
        return { pid, cwd, workspaceId };
      }

      function getActiveThreadContext() {
        try {
          const raw = window.localStorage.getItem(ACTIVE_THREAD_CONTEXT_KEY);
          if (!raw) {
            return null;
          }
          return normalizeThreadContext(JSON.parse(raw));
        } catch {
          return null;
        }
      }

      function setActiveThreadContext(context) {
        const normalized = normalizeThreadContext(context);
        try {
          if (normalized) {
            window.localStorage.setItem(ACTIVE_THREAD_CONTEXT_KEY, JSON.stringify(normalized));
          } else {
            window.localStorage.removeItem(ACTIVE_THREAD_CONTEXT_KEY);
          }
        } catch {}
        return normalized;
      }

      function deriveThreadLabel(message) {
        const firstLine = String(message ?? "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        if (!firstLine) {
          return undefined;
        }
        return firstLine.length > 72 ? firstLine.slice(0, 69) + "..." : firstLine;
      }

      function displayThreadLabel(entry) {
        const label = typeof entry?.label === "string" ? entry.label.trim() : "";
        return label || String(entry?.workspaceId ?? "thread");
      }

      function extractAssistantHistory(content) {
        const record = asRecord(content);
        if (!record) {
          return { text: typeof content === "string" ? content : formatMessageContent(content), toolCalls: [] };
        }
        const text = typeof record.text === "string" ? record.text : (typeof content === "string" ? content : "");
        const rawToolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
        const toolCalls = rawToolCalls
          .map((item, index) => {
            const call = asRecord(item);
            if (!call) {
              return null;
            }
            const name = typeof call.name === "string" ? call.name : "tool";
            const callId = typeof call.id === "string" ? call.id : (typeof call.callId === "string" ? call.callId : "hist-call-" + index);
            return { toolName: name, callId, args: call.arguments ?? call.args ?? {} };
          })
          .filter(Boolean);
        return { text, toolCalls };
      }

      function extractToolResultHistory(content) {
        const record = asRecord(content);
        if (!record) {
          return null;
        }
        const toolName = typeof record.toolName === "string" ? record.toolName : (typeof record.name === "string" ? record.name : "");
        if (!toolName) {
          return null;
        }
        return {
          toolName,
          ok: record.ok === true || record.isError !== true,
          output: record.output,
          error: typeof record.error === "string" ? record.error : null,
        };
      }

      function makeId() {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }
        return "host-" + Date.now() + "-" + Math.random().toString(16).slice(2);
      }

      function connectHostClient(timeoutMs = BRIDGE_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
          const timerId = window.setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for HOST bridge"));
          }, timeoutMs);

          function cleanup() {
            window.clearTimeout(timerId);
            window.removeEventListener("message", onMessage);
          }

          function onMessage(event) {
            if (event.origin !== window.location.origin) {
              return;
            }
            const record = asRecord(event.data);
            if (!record || record.type !== "gsv-host-connect") {
              return;
            }
            const port = event.ports[0];
            if (!(port instanceof MessagePort)) {
              cleanup();
              reject(new Error("HOST bridge did not provide a message port"));
              return;
            }
            cleanup();
            resolve(createEmbeddedHostClient(port));
          }

          window.addEventListener("message", onMessage);
        });
      }

      function createEmbeddedHostClient(port) {
        let status = {
          state: "connecting",
          url: window.location.origin,
          username: null,
          connectionId: null,
          message: "Waiting for host bridge...",
        };
        const statusListeners = new Set();
        const signalListeners = new Set();
        const pending = new Map();

        function emitStatus() {
          for (const listener of statusListeners) {
            listener(status);
          }
        }

        port.onmessage = function(event) {
          const record = asRecord(event.data);
          if (!record || typeof record.type !== "string") {
            return;
          }
          if (record.type === "status") {
            status = record.status || status;
            emitStatus();
            return;
          }
          if (record.type === "signal") {
            const signal = asString(record.signal);
            if (!signal) {
              return;
            }
            for (const listener of signalListeners) {
              listener(signal, record.payload);
            }
            return;
          }
          if (record.type === "rpc-result") {
            const id = asString(record.id);
            if (!id || !pending.has(id)) {
              return;
            }
            const pendingRequest = pending.get(id);
            pending.delete(id);
            window.clearTimeout(pendingRequest.timeoutId);
            if (record.ok === true) {
              pendingRequest.resolve(record.data);
            } else {
              pendingRequest.reject(new Error(asString(record.error) || "HOST request failed"));
            }
          }
        };
        port.start();

        function rpc(method, payload) {
          const id = makeId();
          return new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
              pending.delete(id);
              reject(new Error("HOST request timed out: " + method));
            }, BRIDGE_TIMEOUT_MS);
            pending.set(id, { resolve, reject, timeoutId });
            port.postMessage({ type: "rpc", id, method, payload });
          });
        }

        return {
          getStatus: () => status,
          isConnected: () => status.state === "connected",
          onSignal: (listener) => {
            signalListeners.add(listener);
            return () => signalListeners.delete(listener);
          },
          onStatus: (listener) => {
            statusListeners.add(listener);
            listener(status);
            return () => statusListeners.delete(listener);
          },
          call: (call, args) => rpc("call", { call, args: args || {} }),
          spawnProcess: (args) => rpc("spawnProcess", args),
          sendMessage: (message, pid) => rpc("sendMessage", { message, pid }),
          getHistory: (limit, pid, offset) => rpc("getHistory", { limit: limit || 50, pid, offset }),
        };
      }

      const elements = {
        threadList: document.getElementById("thread-list"),
        threadStatus: document.getElementById("thread-status"),
        newThread: document.getElementById("new-thread"),
        refreshThreads: document.getElementById("refresh-threads"),
        activeThreadTitle: document.getElementById("active-thread-title"),
        activeThreadMeta: document.getElementById("active-thread-meta"),
        connectionPill: document.getElementById("connection-pill"),
        chatLog: document.getElementById("chat-log"),
        composeForm: document.getElementById("chat-compose-form"),
        chatInput: document.getElementById("chat-input"),
        composeStatus: document.getElementById("compose-status"),
        sendButton: document.getElementById("send-button"),
        openFiles: document.getElementById("open-files"),
        openShell: document.getElementById("open-shell"),
      };

      let client = null;
      let activeThreadContext = getActiveThreadContext();
      let recentThreads = [];
      let logRows = [];
      let threadsLoading = false;
      let threadsError = "";
      let hostError = "";
      let refreshTimer = null;
      let messageBusy = false;

      function getActivePid() {
        return activeThreadContext?.pid || null;
      }

      function setLogRows(rows) {
        logRows = rows;
        renderLog();
      }

      function appendSystemRow(text) {
        logRows = logRows.concat([{ role: "system", text: String(text || ""), timestamp: Date.now() }]);
        renderLog();
      }

      function labelForRole(role) {
        if (role === "user") return "You";
        if (role === "assistant") return "Assistant";
        return "System";
      }

      function renderLog() {
        if (!elements.chatLog) {
          return;
        }
        elements.chatLog.innerHTML = logRows.map((row) => {
          const role = row.role === "user" ? "user" : row.role === "assistant" ? "assistant" : "system";
          const timestamp = row.timestamp ? formatTimestamp(row.timestamp) : "";
          return '<article class="message message-' + escapeHtmlClient(role) + '">' +
            '<div class="message-head"><span>' + escapeHtmlClient(labelForRole(role)) + '</span><span>' + escapeHtmlClient(timestamp) + '</span></div>' +
            '<pre class="message-body">' + escapeHtmlClient(row.text) + '</pre>' +
          '</article>';
        }).join("");
        elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
      }

      function renderThreads() {
        if (!elements.threadList || !elements.threadStatus) {
          return;
        }
        if (threadsLoading) {
          elements.threadStatus.textContent = "Refreshing threads...";
        } else if (threadsError) {
          elements.threadStatus.textContent = threadsError;
        } else if (recentThreads.length === 0) {
          elements.threadStatus.textContent = "No threads yet. Send a message to start one.";
        } else {
          elements.threadStatus.textContent = "";
        }
        const activeWorkspaceId = activeThreadContext?.workspaceId || null;
        elements.threadList.innerHTML = recentThreads.map((entry) => {
          const isActive = activeWorkspaceId && entry.workspaceId === activeWorkspaceId;
          const state = entry.activeProcess ? "Live" : "Stored";
          const helpers = entry.processCount > 1 ? " · " + entry.processCount + " agents" : "";
          return '<button type="button" class="thread-card' + (isActive ? ' is-active' : '') + '" data-workspace-id="' + escapeHtmlClient(entry.workspaceId) + '">' +
            '<span class="thread-title">' + escapeHtmlClient(displayThreadLabel(entry)) + '</span>' +
            '<span class="thread-meta">' + escapeHtmlClient(state + helpers + ' · ' + formatRelativeTime(entry.updatedAt)) + '</span>' +
          '</button>';
        }).join("");
      }

      function renderStatus() {
        const status = client ? client.getStatus() : { state: "disconnected", message: hostError || "HOST unavailable" };
        if (elements.connectionPill) {
          elements.connectionPill.textContent = status.state;
          elements.connectionPill.className = 'pill is-' + status.state;
        }
        if (elements.composeStatus) {
          if (hostError) {
            elements.composeStatus.textContent = hostError;
          } else if (messageBusy) {
            elements.composeStatus.textContent = "Run in progress. Responses will refresh as signals arrive.";
          } else if (activeThreadContext) {
            elements.composeStatus.textContent = "Attached to " + (activeThreadContext.workspaceId || activeThreadContext.pid);
          } else {
            elements.composeStatus.textContent = status.state === "connected" ? "Send a message to start a new thread." : (status.message || "Waiting for desktop host.");
          }
        }
        if (elements.activeThreadTitle) {
          elements.activeThreadTitle.textContent = activeThreadContext
            ? (activeThreadContext.workspaceId || activeThreadContext.pid)
            : "New conversation";
        }
        if (elements.activeThreadMeta) {
          elements.activeThreadMeta.textContent = activeThreadContext
            ? activeThreadContext.cwd
            : "Send a message to start a thread or reopen one from the left.";
        }
        const interactive = client && client.isConnected() && !hostError;
        if (elements.chatInput) {
          elements.chatInput.disabled = !interactive || messageBusy;
        }
        if (elements.sendButton) {
          const hasText = elements.chatInput && elements.chatInput.value.trim().length > 0;
          elements.sendButton.disabled = !interactive || messageBusy || !hasText;
        }
        if (elements.openFiles) {
          elements.openFiles.disabled = !activeThreadContext;
        }
        if (elements.openShell) {
          elements.openShell.disabled = !activeThreadContext;
        }
      }

      function flattenHistory(messages) {
        const rows = [];
        for (const entry of messages) {
          const timestamp = normalizeTimestampMs(entry?.timestamp) || Date.now();
          if (entry?.role === "assistant") {
            const parsed = extractAssistantHistory(entry.content);
            if (parsed.text && parsed.text.trim()) {
              rows.push({ role: "assistant", text: parsed.text, timestamp });
            }
            for (const toolCall of parsed.toolCalls) {
              rows.push({ role: "system", text: "tool call: " + toolCall.toolName + "\n" + prettyJson(toolCall.args), timestamp });
            }
            continue;
          }
          if (entry?.role === "toolResult") {
            const parsedResult = extractToolResultHistory(entry.content);
            if (parsedResult) {
              const suffix = parsedResult.ok ? prettyJson(parsedResult.output) : (parsedResult.error || "tool error");
              rows.push({ role: "system", text: "tool result: " + parsedResult.toolName + "\n" + suffix, timestamp });
            } else {
              rows.push({ role: "system", text: formatMessageContent(entry.content), timestamp });
            }
            continue;
          }
          const role = entry?.role === "user" ? "user" : entry?.role === "assistant" ? "assistant" : "system";
          rows.push({ role, text: formatMessageContent(entry?.content), timestamp });
        }
        if (rows.length === 0) {
          rows.push({ role: "system", text: "No messages yet. Send your first prompt.", timestamp: Date.now() });
        }
        return rows;
      }

      async function loadHistory() {
        if (!client || !client.isConnected()) {
          return;
        }
        const pid = getActivePid();
        if (!pid) {
          setLogRows([{ role: "system", text: "No thread selected. Send a message to start a new thread.", timestamp: Date.now() }]);
          renderStatus();
          return;
        }
        const merged = [];
        let offset = 0;
        let messageCount = 0;
        let truncated = false;
        for (let page = 0; page < 20; page += 1) {
          const result = await client.getHistory(200, pid, offset);
          if (!result.ok) {
            setLogRows([{ role: "system", text: "history error: " + result.error, timestamp: Date.now() }]);
            return;
          }
          merged.push(...result.messages);
          messageCount = result.messageCount;
          offset += result.messages.length;
          truncated = result.truncated === true;
          if (!truncated || result.messages.length === 0 || offset >= messageCount) {
            break;
          }
        }
        const rows = flattenHistory(merged);
        if (truncated && offset < messageCount) {
          rows.push({ role: "system", text: 'history truncated at ' + offset + '/' + messageCount + ' messages', timestamp: Date.now() });
        }
        setLogRows(rows);
        renderStatus();
      }

      async function loadThreads() {
        if (!client || !client.isConnected()) {
          renderThreads();
          return;
        }
        threadsLoading = true;
        threadsError = "";
        renderThreads();
        try {
          const payload = await client.call("sys.workspace.list", { kind: "thread", limit: 32 });
          recentThreads = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
        } catch (error) {
          recentThreads = [];
          threadsError = error instanceof Error ? error.message : String(error);
        } finally {
          threadsLoading = false;
          renderThreads();
        }
      }

      function scheduleRefresh() {
        if (refreshTimer !== null) {
          window.clearTimeout(refreshTimer);
        }
        refreshTimer = window.setTimeout(() => {
          refreshTimer = null;
          void loadThreads();
          void loadHistory();
        }, 250);
      }

      function activateThreadContext(context) {
        const normalized = setActiveThreadContext(context);
        if (!normalized) {
          return;
        }
        activeThreadContext = normalized;
        renderThreads();
        renderStatus();
        void loadHistory();
      }

      async function openThread(workspaceId) {
        if (!client || !client.isConnected()) {
          appendSystemRow("session is locked");
          return;
        }
        const entry = recentThreads.find((candidate) => candidate.workspaceId === workspaceId);
        if (!entry) {
          appendSystemRow("thread not found: " + workspaceId);
          return;
        }
        if (entry.activeProcess) {
          activateThreadContext({ pid: entry.activeProcess.pid, workspaceId: entry.workspaceId, cwd: entry.activeProcess.cwd });
          return;
        }
        try {
          const spawnResult = await client.spawnProcess({
            profile: "task",
            label: entry.label || undefined,
            workspace: { mode: "attach", workspaceId: entry.workspaceId },
          });
          if (!spawnResult.ok) {
            appendSystemRow("thread reopen failed: " + spawnResult.error);
            return;
          }
          activateThreadContext({ pid: spawnResult.pid, workspaceId: spawnResult.workspaceId, cwd: spawnResult.cwd });
          void loadThreads();
        } catch (error) {
          appendSystemRow("thread reopen failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }

      function resetToNewThread() {
        activeThreadContext = setActiveThreadContext(null);
        setLogRows([{ role: "system", text: "No thread selected. Send a message to start a new thread.", timestamp: Date.now() }]);
        renderThreads();
        renderStatus();
        elements.chatInput?.focus();
      }

      async function sendMessage(event) {
        event.preventDefault();
        if (!client || !client.isConnected()) {
          appendSystemRow("session is locked");
          return;
        }
        const message = elements.chatInput ? elements.chatInput.value.trim() : "";
        if (!message) {
          return;
        }
        messageBusy = true;
        renderStatus();
        try {
          let pid = getActivePid();
          if (!pid) {
            const spawnResult = await client.spawnProcess({
              profile: "task",
              label: deriveThreadLabel(message),
              workspace: { mode: "new", kind: "thread" },
            });
            if (!spawnResult.ok) {
              appendSystemRow("thread start failed: " + spawnResult.error);
              return;
            }
            activeThreadContext = setActiveThreadContext({ pid: spawnResult.pid, workspaceId: spawnResult.workspaceId, cwd: spawnResult.cwd });
            pid = spawnResult.pid;
            void loadThreads();
          }
          const currentRows = logRows.slice();
          currentRows.push({ role: "user", text: message, timestamp: Date.now() });
          setLogRows(currentRows);
          elements.chatInput.value = "";
          renderStatus();
          const result = await client.sendMessage(message, pid || undefined);
          if (!result.ok) {
            appendSystemRow("send failed: " + result.error);
            return;
          }
          if (result.queued) {
            appendSystemRow("message queued while process is busy");
          }
          scheduleRefresh();
        } catch (error) {
          appendSystemRow("send failed: " + (error instanceof Error ? error.message : String(error)));
        } finally {
          messageBusy = false;
          renderStatus();
        }
      }

      function openCompanion(appId) {
        if (!activeThreadContext) {
          return;
        }
        try {
          if (window.parent && window.parent !== window) {
            window.parent.dispatchEvent(new CustomEvent(OPEN_APP_EVENT, {
              detail: { appId, threadContext: activeThreadContext },
            }));
          }
        } catch {}
      }

      function adoptPendingTarget() {
        try {
          if (!WINDOW_ID || !window.parent || window.parent === window) {
            return;
          }
          const store = window.parent[PENDING_TARGETS_KEY];
          if (store instanceof Map && store.has(WINDOW_ID)) {
            const pending = normalizeThreadContext(store.get(WINDOW_ID));
            store.delete(WINDOW_ID);
            if (pending) {
              activeThreadContext = setActiveThreadContext(pending);
            }
          }
        } catch {}
      }

      function listenForTargetProcess() {
        try {
          if (!window.parent || window.parent === window) {
            return;
          }
          window.parent.addEventListener(TARGET_CHAT_PROCESS_EVENT, (event) => {
            if (!(event instanceof window.parent.CustomEvent)) {
              return;
            }
            const detail = asRecord(event.detail);
            if (!detail) {
              return;
            }
            const targetWindowId = typeof detail.windowId === "string" ? detail.windowId.trim() : "";
            if (WINDOW_ID && targetWindowId && targetWindowId !== WINDOW_ID) {
              return;
            }
            const next = normalizeThreadContext(detail);
            if (!next) {
              return;
            }
            activeThreadContext = setActiveThreadContext(next);
            renderThreads();
            renderStatus();
            void loadHistory();
          });
        } catch {}
      }

      function bindUi() {
        elements.refreshThreads?.addEventListener("click", () => { void loadThreads(); });
        elements.newThread?.addEventListener("click", () => { resetToNewThread(); });
        elements.composeForm?.addEventListener("submit", sendMessage);
        elements.chatInput?.addEventListener("input", () => renderStatus());
        elements.chatInput?.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            elements.composeForm?.requestSubmit();
          }
        });
        elements.threadList?.addEventListener("click", (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) {
            return;
          }
          const button = target.closest("[data-workspace-id]");
          if (!(button instanceof HTMLElement)) {
            return;
          }
          const workspaceId = button.dataset.workspaceId?.trim();
          if (!workspaceId) {
            return;
          }
          void openThread(workspaceId);
        });
        elements.openFiles?.addEventListener("click", () => openCompanion("files"));
        elements.openShell?.addEventListener("click", () => openCompanion("shell"));
      }

      async function boot() {
        bindUi();
        adoptPendingTarget();
        listenForTargetProcess();
        renderThreads();
        renderStatus();
        setLogRows([{ role: "system", text: "Waiting for desktop host.", timestamp: Date.now() }]);
        try {
          client = await connectHostClient();
          client.onStatus(() => {
            renderStatus();
            if (client && client.isConnected()) {
              void loadThreads();
              if (activeThreadContext) {
                void loadHistory();
              }
            }
          });
          client.onSignal((signal) => {
            if (signal === "process.exit" || signal.startsWith("chat.")) {
              scheduleRefresh();
            }
          });
          renderStatus();
          if (activeThreadContext) {
            await loadHistory();
          } else {
            setLogRows([{ role: "system", text: "No thread selected. Send a message to start a new thread.", timestamp: Date.now() }]);
          }
          await loadThreads();
        } catch (error) {
          hostError = error instanceof Error ? error.message : String(error);
          setLogRows([{ role: "system", text: "HOST bridge unavailable. Open Chat from the desktop shell.", timestamp: Date.now() }]);
          renderStatus();
        }
      }

      void boot();
    </script>
  </body>
</html>`;
}

export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};
  const url = new URL(request.url);
  const routeBase = props.appFrame?.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/chat";

  if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
    return new Response("Not Found", { status: 404 });
  }
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  return new Response(renderPage(routeBase), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default { fetch: handleFetch };
