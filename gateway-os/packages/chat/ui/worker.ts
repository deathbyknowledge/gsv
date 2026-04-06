function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderClientScript(routeBase) {
  return `      const ROUTE_BASE = ${JSON.stringify(routeBase)};
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

      function asBoolean(value) {
        return typeof value === "boolean" ? value : null;
      }

      function asNumber(value) {
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      }

      function safeText(value) {
        if (typeof value === "string") {
          return value;
        }
        if (value === null || value === undefined) {
          return "";
        }
        return String(value);
      }

      function maybeParseJsonString(value) {
        const trimmed = value.trim();
        if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
          return value;
        }
        try {
          return JSON.parse(trimmed);
        } catch {
          return value;
        }
      }

      function normalizeToolOutput(value) {
        if (typeof value !== "string") {
          return value;
        }
        return maybeParseJsonString(value);
      }

      function truncateInline(value, maxLength = 80) {
        const compact = String(value ?? "").replace(/\s+/g, " ").trim();
        if (compact.length <= maxLength) {
          return compact;
        }
        return compact.slice(0, maxLength) + "...";
      }

      function truncateBlock(value, maxLength = 1800) {
        const text = String(value ?? "");
        if (text.length <= maxLength) {
          return text;
        }
        return text.slice(0, maxLength) + "\n...[truncated]";
      }

      function basenamePath(path) {
        const normalized = String(path ?? "").replace(/\/+$/g, "");
        if (!normalized) {
          return String(path ?? "");
        }
        const segments = normalized.split("/");
        return segments[segments.length - 1] || normalized;
      }

      function inferToolSyscall(toolName, syscall) {
        if (typeof syscall === "string" && syscall.trim()) {
          return syscall.trim();
        }
        switch (toolName) {
          case "Read":
            return "fs.read";
          case "Search":
            return "fs.search";
          case "Shell":
            return "shell.exec";
          case "Write":
            return "fs.write";
          case "Edit":
            return "fs.edit";
          case "Delete":
            return "fs.delete";
          default:
            return null;
        }
      }

      function resolveToolTarget(args) {
        const record = asRecord(args);
        const raw = asString(record?.target)?.trim() ?? "";
        if (!raw || raw === "gsv" || raw === "gateway" || raw === "<init>" || raw === "init" || raw === "local") {
          return "gsv";
        }
        if (raw.startsWith("device:")) {
          return raw.slice("device:".length) || raw;
        }
        if (raw.startsWith("driver:")) {
          return raw.slice("driver:".length) || raw;
        }
        return raw;
      }

      function describeToolCard(toolName, args, syscall) {
        const record = asRecord(args);
        const path = asString(record?.path);
        const target = resolveToolTarget(args);

        if (toolName === "Shell" || syscall === "shell.exec") {
          const command = asString(record?.command);
          const workdir = asString(record?.workdir);
          return {
            title: command ? "Run " + truncateInline(command) : "Run command",
            subtitle: workdir ? "workdir " + truncateInline(workdir, 36) : "",
            target,
          };
        }
        if (toolName === "Read" || syscall === "fs.read") {
          return { title: path ? "Read " + basenamePath(path) : "Read file", subtitle: path ?? "", target };
        }
        if (toolName === "Search" || syscall === "fs.search") {
          const pattern = asString(record?.pattern);
          return {
            title: pattern ? "Search " + truncateInline(pattern, 42) : "Search workspace",
            subtitle: path ?? "",
            target,
          };
        }
        if (toolName === "Write" || syscall === "fs.write") {
          return { title: path ? "Write " + basenamePath(path) : "Write file", subtitle: path ?? "", target };
        }
        if (toolName === "Edit" || syscall === "fs.edit") {
          return { title: path ? "Edit " + basenamePath(path) : "Edit file", subtitle: path ?? "", target };
        }
        if (toolName === "Delete" || syscall === "fs.delete") {
          return { title: path ? "Delete " + basenamePath(path) : "Delete file", subtitle: path ?? "", target };
        }
        return { title: toolName, subtitle: "", target };
      }

      function renderToolMetaRows(rows) {
        const filtered = rows.filter((row) => row[1] !== undefined && row[1] !== null && String(row[1]).length > 0);
        if (filtered.length === 0) {
          return "";
        }
        return '<div class="tool-meta-grid">' + filtered.map(([label, value]) => (
          '<div class="tool-meta-row"><span class="tool-meta-label">' + escapeHtmlClient(label) + '</span><span class="tool-meta-value">' + escapeHtmlClient(safeText(value)) + '</span></div>'
        )).join("") + "</div>";
      }

      function renderToolPreview(toolName, syscall, output, ok, error) {
        const normalized = normalizeToolOutput(output);
        const record = asRecord(normalized);
        const outputError = asString(record?.error);
        if (!ok || record?.ok === false) {
          return '<p class="tool-preview-line is-error">' + escapeHtmlClient(error ?? outputError ?? "Tool call failed.") + "</p>";
        }

        if (toolName === "Shell" || syscall === "shell.exec") {
          const stdout = asString(record?.stdout);
          const stderr = asString(record?.stderr);
          if (stdout && stdout.trim()) {
            return '<pre class="tool-preview-pre">' + escapeHtmlClient(truncateBlock(stdout, 800)) + "</pre>";
          }
          if (stderr && stderr.trim()) {
            return '<pre class="tool-preview-pre">' + escapeHtmlClient(truncateBlock(stderr, 800)) + "</pre>";
          }
          return '<p class="tool-preview-line">Command completed.</p>';
        }

        if (toolName === "Read" || syscall === "fs.read") {
          const directories = Array.isArray(record?.directories) ? record.directories : [];
          const files = Array.isArray(record?.files) ? record.files : [];
          if (directories.length || files.length) {
            const preview = [
              ...directories.slice(0, 8).map((value) => "dir: " + safeText(value)),
              ...files.slice(0, 8).map((value) => "file: " + safeText(value)),
            ].join("\n");
            return '<p class="tool-preview-line">Listed ' + escapeHtmlClient(String(directories.length)) + ' dirs and ' + escapeHtmlClient(String(files.length)) + ' files.</p>' +
              (preview ? '<pre class="tool-preview-pre">' + escapeHtmlClient(preview) + "</pre>" : "");
          }
          if (typeof record?.content === "string") {
            return '<pre class="tool-preview-pre">' + escapeHtmlClient(truncateBlock(record.content, 800)) + "</pre>";
          }
          return '<p class="tool-preview-line">Read completed.</p>';
        }

        if (toolName === "Search" || syscall === "fs.search") {
          const matches = Array.isArray(record?.matches) ? record.matches : [];
          const count = asNumber(record?.count) ?? matches.length;
          const preview = matches.slice(0, 10).map((item) => {
            const match = asRecord(item);
            if (!match) return safeText(item);
            return basenamePath(safeText(match.path)) + ":" + safeText(match.line) + ": " + safeText(match.content);
          }).join("\n");
          return '<p class="tool-preview-line">' + escapeHtmlClient(String(count)) + ' matches.</p>' +
            (preview ? '<pre class="tool-preview-pre">' + escapeHtmlClient(preview) + "</pre>" : "");
        }

        if (toolName === "Write" || syscall === "fs.write") {
          return '<p class="tool-preview-line">Write completed.</p>';
        }
        if (toolName === "Edit" || syscall === "fs.edit") {
          return '<p class="tool-preview-line">Edit completed.</p>';
        }
        if (toolName === "Delete" || syscall === "fs.delete") {
          return '<p class="tool-preview-line">Delete completed.</p>';
        }

        if (typeof normalized === "string") {
          return '<pre class="tool-preview-pre">' + escapeHtmlClient(truncateBlock(normalized, 800)) + "</pre>";
        }
        return '<pre class="tool-preview-pre">' + escapeHtmlClient(truncateBlock(prettyJson(normalized), 800)) + "</pre>";
      }

      function renderToolDetails(toolName, syscall, output, ok, error, args, callId) {
        const normalized = normalizeToolOutput(output);
        const record = asRecord(normalized);
        const outputError = asString(record?.error);
        const rows = [];

        if (toolName === "Shell" || syscall === "shell.exec") {
          rows.push(["pid", record?.pid], ["exit", record?.exitCode], ["backgrounded", record?.backgrounded === true ? "true" : null]);
        } else if (toolName === "Read" || syscall === "fs.read") {
          rows.push(["path", record?.path ?? asRecord(args)?.path], ["size", record?.size], ["dirs", Array.isArray(record?.directories) ? record.directories.length : null], ["files", Array.isArray(record?.files) ? record.files.length : null]);
        } else if (toolName === "Search" || syscall === "fs.search") {
          rows.push(["count", record?.count], ["truncated", record?.truncated === true ? "true" : null]);
        } else if (toolName === "Write" || syscall === "fs.write") {
          rows.push(["path", record?.path ?? asRecord(args)?.path], ["bytes", record?.size]);
        } else if (toolName === "Edit" || syscall === "fs.edit") {
          rows.push(["path", record?.path ?? asRecord(args)?.path], ["replacements", record?.replacements]);
        } else if (toolName === "Delete" || syscall === "fs.delete") {
          rows.push(["path", record?.path ?? asRecord(args)?.path]);
        }

        let body = renderToolMetaRows([["call", callId], ["syscall", syscall], ...rows]);
        if (!ok || record?.ok === false) {
          body += '<p class="tool-error">' + escapeHtmlClient(error ?? outputError ?? "Tool call failed.") + "</p>";
        }
        body += '<div class="tool-detail-block"><pre>' + escapeHtmlClient(truncateBlock(prettyJson(args), 2400)) + "</pre></div>";

        if (toolName === "Shell" || syscall === "shell.exec") {
          const stdout = asString(record?.stdout);
          const stderr = asString(record?.stderr);
          if (stdout && stdout.trim()) {
            body += '<div class="tool-detail-block"><pre>' + escapeHtmlClient(truncateBlock(stdout, 4000)) + "</pre></div>";
          }
          if (stderr && stderr.trim()) {
            body += '<div class="tool-detail-block"><pre>' + escapeHtmlClient(truncateBlock(stderr, 4000)) + "</pre></div>";
          }
          return body;
        }

        if (toolName === "Read" || syscall === "fs.read") {
          if (typeof record?.content === "string") {
            body += '<div class="tool-detail-block"><pre>' + escapeHtmlClient(truncateBlock(record.content, 4000)) + "</pre></div>";
          } else if (Array.isArray(record?.directories) || Array.isArray(record?.files)) {
            const listing = [
              ...(Array.isArray(record?.directories) ? record.directories.map((value) => "dir: " + safeText(value)) : []),
              ...(Array.isArray(record?.files) ? record.files.map((value) => "file: " + safeText(value)) : []),
            ].join("\n");
            if (listing) {
              body += '<div class="tool-detail-block"><pre>' + escapeHtmlClient(truncateBlock(listing, 4000)) + "</pre></div>";
            }
          }
          return body;
        }

        if (toolName === "Search" || syscall === "fs.search") {
          const matches = Array.isArray(record?.matches) ? record.matches : [];
          if (matches.length > 0) {
            const listing = matches.map((item) => {
              const match = asRecord(item);
              if (!match) return safeText(item);
              return safeText(match.path) + ":" + safeText(match.line) + ": " + safeText(match.content);
            }).join("\n");
            body += '<div class="tool-detail-block"><pre>' + escapeHtmlClient(truncateBlock(listing, 4000)) + "</pre></div>";
          }
          return body;
        }

        if (normalized !== undefined) {
          body += '<div class="tool-detail-block"><pre>' + escapeHtmlClient(truncateBlock(typeof normalized === "string" ? normalized : prettyJson(normalized), 4000)) + "</pre></div>";
        }
        return body;
      }

      function renderToolRow(row) {
        const syscall = inferToolSyscall(row.toolName, row.syscall);
        const card = describeToolCard(row.toolName, row.args, syscall);
        const statusClass = row.kind === "toolCall" ? "is-pending" : (row.ok ? "is-ok" : "is-error");
        const statusLabel = row.kind === "toolCall" ? "Running" : (row.ok ? "Done" : "Error");
        const detailsBody = row.kind === "toolCall"
          ? renderToolMetaRows([["call", row.callId], ["syscall", syscall]]) +
            '<div class="tool-detail-block"><pre>' + escapeHtmlClient(truncateBlock(prettyJson(row.args), 2400)) + "</pre></div>"
          : renderToolDetails(row.toolName, syscall, row.output, row.ok, row.error, row.args, row.callId);
        return '<article class="tool-card ' + statusClass + '">' +
          '<div class="tool-card-head">' +
            '<div><h3 class="tool-card-title">' + escapeHtmlClient(card.title) + '</h3>' +
            (card.subtitle ? '<p class="tool-card-subtitle">' + escapeHtmlClient(card.subtitle) + '</p>' : '') +
            '</div>' +
            '<div class="tool-status ' + statusClass + '">' + escapeHtmlClient(statusLabel) + '<span class="tool-target">' + escapeHtmlClient(card.target) + '</span></div>' +
          '</div>' +
          '<div class="tool-preview">' + (
            row.kind === "toolCall"
              ? '<p class="tool-preview-line">Waiting for result.</p>'
              : renderToolPreview(row.toolName, syscall, row.output, row.ok, row.error)
          ) + '</div>' +
          '<details class="tool-details"><summary>' + escapeHtmlClient(row.kind === "toolCall" ? "Input" : "Details") + '</summary>' +
            detailsBody +
          '</details>' +
        '</article>';
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
            return { toolName: name, callId, args: call.arguments ?? call.args ?? {}, syscall: inferToolSyscall(name, asString(call.syscall)) };
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
          syscall: inferToolSyscall(toolName, asString(record.syscall)),
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
          if (row.kind === "toolCall" || row.kind === "toolResult") {
            return renderToolRow(row);
          }
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
              rows.push({ kind: "message", role: "assistant", text: parsed.text, timestamp });
            }
            for (const toolCall of parsed.toolCalls) {
              rows.push({
                kind: "toolCall",
                toolName: toolCall.toolName,
                callId: toolCall.callId,
                args: toolCall.args,
                syscall: toolCall.syscall,
                output: null,
                ok: false,
                error: null,
                timestamp,
              });
            }
            continue;
          }
          if (entry?.role === "toolResult") {
            const parsedResult = extractToolResultHistory(entry.content);
            if (parsedResult) {
              rows.push({
                kind: "toolResult",
                toolName: parsedResult.toolName,
                callId: parsedResult.callId ?? "tool-result",
                args: {},
                syscall: parsedResult.syscall,
                output: parsedResult.output,
                ok: parsedResult.ok,
                error: parsedResult.error ?? null,
                timestamp,
              });
            } else {
              rows.push({ kind: "message", role: "system", text: formatMessageContent(entry.content), timestamp });
            }
            continue;
          }
          const role = entry?.role === "user" ? "user" : entry?.role === "assistant" ? "assistant" : "system";
          rows.push({ kind: "message", role, text: formatMessageContent(entry?.content), timestamp });
        }
        if (rows.length === 0) {
          rows.push({ kind: "message", role: "system", text: "No messages yet. Send your first prompt.", timestamp: Date.now() });
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

      async function sendMessage() {
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
        elements.composeForm?.addEventListener("submit", (event) => {
          event.preventDefault();
          void sendMessage();
        });
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

      void boot();`;
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
      .tool-card {
        justify-self: start;
        width: min(92%, 760px);
        border-radius: 18px;
        padding: 14px;
        background: rgba(255, 255, 255, 0.72);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
      }
      .tool-card.is-pending {
        background: rgba(245, 247, 250, 0.92);
      }
      .tool-card.is-ok {
        background: rgba(240, 246, 251, 0.95);
      }
      .tool-card.is-error {
        background: rgba(255, 241, 239, 0.95);
      }
      .tool-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .tool-card-title {
        margin: 0;
        font-size: 0.96rem;
        font-weight: 700;
      }
      .tool-card-subtitle {
        margin: 6px 0 0;
        color: var(--text-muted);
        font-size: 12px;
      }
      .tool-status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 9px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .tool-status.is-pending {
        background: rgba(232, 238, 243, 0.92);
        color: #59646d;
      }
      .tool-status.is-ok {
        background: rgba(218, 235, 225, 0.92);
        color: #29533e;
      }
      .tool-status.is-error {
        background: rgba(255, 226, 226, 0.92);
        color: #7a3030;
      }
      .tool-target {
        margin-left: 8px;
        color: var(--text-soft);
      }
      .tool-preview {
        margin-top: 12px;
        display: grid;
        gap: 8px;
      }
      .tool-preview-line,
      .tool-error {
        margin: 0;
        color: var(--text-muted);
      }
      .tool-preview-line.is-error,
      .tool-error {
        color: #8a3b3b;
      }
      .tool-preview-pre,
      .tool-details pre {
        margin: 0;
        padding: 12px;
        border-radius: 12px;
        background: rgba(232, 238, 243, 0.82);
        color: var(--text);
        white-space: pre-wrap;
        word-break: break-word;
        font: 12px/1.5 var(--mono);
      }
      .tool-details {
        margin-top: 12px;
      }
      .tool-details summary {
        cursor: pointer;
        color: var(--primary);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .tool-detail-block {
        margin-top: 12px;
        display: grid;
        gap: 10px;
      }
      .tool-meta-grid {
        display: grid;
        gap: 8px;
      }
      .tool-meta-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 12px;
      }
      .tool-meta-label {
        color: var(--text-soft);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 800;
      }
      .tool-meta-value {
        color: var(--text);
        text-align: right;
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

    <script type="module" src="${escapeHtml(routeBase)}?asset=app.js"></script>
  </body>
</html>`;
}

export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};
  const url = new URL(request.url);
  const routeBase = props.appFrame?.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/chat";

  if (url.searchParams.get("asset") === "app.js") {
    return new Response(renderClientScript(routeBase), {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

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
