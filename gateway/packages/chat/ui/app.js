const PAGE_PATHNAME = window.location.pathname;
const ROUTE_BASE = PAGE_PATHNAME.endsWith("/index.html")
  ? PAGE_PATHNAME.slice(0, -"/index.html".length)
  : PAGE_PATHNAME.replace(/\/$/, "");
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
  const record = asRecord(value);
  if (record) {
    const text = asString(record.text) || "";
    const media = Array.isArray(record.media) ? record.media : [];
    if (media.length > 0) {
      const lines = [];
      if (text.trim()) {
        lines.push(text);
      }
      for (const item of media) {
        lines.push(describeAttachment(item));
      }
      return lines.join("\n");
    }
  }
  return typeof value === "string" ? value : prettyJson(value);
}

function renderMarkdownHtml(value) {
  const source = String(value ?? "");
  const markedApi = window.marked;
  const purifier = window.DOMPurify;
  if (!markedApi || typeof markedApi.parse !== "function" || !purifier || typeof purifier.sanitize !== "function") {
    return escapeHtmlClient(source);
  }
  const html = markedApi.parse(source, {
    async: false,
    breaks: true,
    gfm: true,
  });
  return purifier.sanitize(typeof html === "string" ? html : String(html));
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
  return text.slice(0, maxLength) + "\\n...[truncated]";
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
      ].join("\\n");
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
    }).join("\\n");
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
      ].join("\\n");
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
      }).join("\\n");
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
    .split("\\n")
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
    return { text: typeof content === "string" ? content : formatMessageContent(content), thinking: [], toolCalls: [] };
  }
  const text = typeof record.text === "string" ? record.text : (typeof content === "string" ? content : "");
  const rawThinking = Array.isArray(record.thinking) ? record.thinking : [];
  const thinking = rawThinking
    .map((item) => {
      const block = asRecord(item);
      if (!block) {
        return null;
      }
      const text = asString(block.thinking);
      return text && text.trim() ? text.trim() : null;
    })
    .filter(Boolean);
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
  return { text, thinking, toolCalls };
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
    callId:
      typeof record.toolCallId === "string"
        ? record.toolCallId
        : (typeof record.callId === "string" ? record.callId : (typeof record.id === "string" ? record.id : null)),
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
    sendMessage: (message, pid, media) => rpc("sendMessage", { message, pid, media }),
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
  attachmentInput: document.getElementById("chat-attachments"),
  attachmentList: document.getElementById("chat-attachments-list"),
  chatInput: document.getElementById("chat-input"),
  composeStatus: document.getElementById("compose-status"),
  sendButton: document.getElementById("send-button"),
  stopRun: document.getElementById("stop-run"),
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
let currentUsername = null;
let pendingAssistantState = null;
let pendingAttachments = [];
let abortBusy = false;
let suppressNextAbortedComplete = false;

function getActivePid() {
  return activeThreadContext?.pid || null;
}

function isNearBottom(node, thresholdPx = 72) {
  const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
  return remaining <= thresholdPx;
}

function setLogRows(rows, options = {}) {
  logRows = rows;
  renderLog(options);
}

function appendSystemRow(text) {
  logRows = logRows.concat([{ role: "system", text: String(text || ""), timestamp: Date.now() }]);
  renderLog({ autoScroll: true });
}

function inferAttachmentKind(mimeType, filename) {
  const normalized = safeText(mimeType).split(";")[0].trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  const lowerName = safeText(filename).toLowerCase();
  if (lowerName.endsWith(".png") || lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg") || lowerName.endsWith(".gif") || lowerName.endsWith(".webp")) return "image";
  if (lowerName.endsWith(".mp3") || lowerName.endsWith(".wav") || lowerName.endsWith(".ogg") || lowerName.endsWith(".m4a")) return "audio";
  if (lowerName.endsWith(".mp4") || lowerName.endsWith(".mov") || lowerName.endsWith(".webm")) return "video";
  return "document";
}

function formatAttachmentSize(size) {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / (1024 * 1024)).toFixed(1) + " MB";
}

function describeAttachment(value) {
  const record = asRecord(value);
  if (!record) return "Attached media";
  const type = asString(record.type) || "media";
  const filename = asString(record.filename);
  const mimeType = asString(record.mimeType);
  const size = asNumber(record.size);
  const parts = ["Attached " + type];
  if (filename) parts.push('"' + filename + '"');
  if (mimeType) parts.push("[" + mimeType + "]");
  const sizeLabel = formatAttachmentSize(size);
  if (sizeLabel) parts.push(sizeLabel);
  return parts.join(" ");
}

function renderAttachmentList() {
  if (!elements.attachmentList) return;
  elements.attachmentList.innerHTML = pendingAttachments.map((item, index) => (
    '<span class="composer-attachment-chip">' +
      '<span class="composer-attachment-name">' + escapeHtmlClient(item.filename || "attachment") + '</span>' +
      '<button type="button" class="composer-attachment-remove" data-attachment-remove="' + index + '" aria-label="Remove attachment">×</button>' +
    '</span>'
  )).join("");
}

function clearPendingAttachments() {
  pendingAttachments = [];
  if (elements.attachmentInput) {
    elements.attachmentInput.value = "";
  }
  renderAttachmentList();
}

async function readAttachmentFile(file) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });

  return {
    type: inferAttachmentKind(file.type, file.name),
    mimeType: file.type || "application/octet-stream",
    data,
    filename: file.name || undefined,
    size: typeof file.size === "number" ? file.size : undefined,
  };
}

function extractThinkingBlocks(value) {
  const record = asRecord(value);
  const rawThinking = Array.isArray(record?.thinking) ? record.thinking : [];
  return rawThinking
    .map((item) => {
      if (typeof item === "string") {
        const text = item.trim();
        return text || null;
      }
      const block = asRecord(item);
      if (!block) {
        return null;
      }
      const text = asString(block.thinking) ?? asString(block.text);
      return text && text.trim() ? text.trim() : null;
    })
    .filter(Boolean);
}

function applyAssistantSignal(payload) {
  const record = asRecord(payload);
  const pid = asString(record?.pid);
  if (pid && pid !== getActivePid()) {
    return;
  }
  const text = asString(record?.text) ?? "";
  const thinking = extractThinkingBlocks(record);
  if (!text.trim() && thinking.length === 0) {
    return;
  }
  const runId = asString(record?.runId);
  const nextRows = logRows.slice();
  const nextRow = {
    kind: "message",
    role: "assistant",
    text,
    thinking,
    timestamp: Date.now(),
    runId: runId ?? null,
  };
  const lastRow = nextRows[nextRows.length - 1];
  if (
    lastRow &&
    lastRow.kind === "message" &&
    lastRow.role === "assistant" &&
    runId &&
    lastRow.runId === runId
  ) {
    nextRows[nextRows.length - 1] = nextRow;
  } else {
    nextRows.push(nextRow);
  }
  setLogRows(nextRows, { autoScroll: true });
}

function findToolRowIndex(rows, callId) {
  if (!callId) {
    return -1;
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if ((row.kind === "toolCall" || row.kind === "toolResult") && row.callId === callId) {
      return index;
    }
  }
  return -1;
}

function applyToolCallSignal(payload) {
  const record = asRecord(payload);
  const pid = asString(record?.pid);
  if (pid && pid !== getActivePid()) {
    return;
  }
  const callId = asString(record?.callId);
  if (!callId) {
    return;
  }
  const toolName = asString(record?.name) || "Tool";
  const syscall = asString(record?.syscall);
  const args = record?.args ?? {};
  const runId = asString(record?.runId);
  const nextRows = logRows.slice();
  const index = findToolRowIndex(nextRows, callId);
  const nextRow = {
    kind: "toolCall",
    toolName,
    callId,
    args,
    syscall,
    timestamp: Date.now(),
    runId: runId ?? null,
  };
  if (index >= 0) {
    const priorRow = nextRows[index];
    if (priorRow.kind === "toolResult") {
      nextRows[index] = {
        kind: "toolResult",
        toolName,
        callId,
        args,
        syscall: syscall ?? priorRow.syscall,
        output: priorRow.output,
        ok: priorRow.ok,
        error: priorRow.error ?? null,
        timestamp: priorRow.timestamp,
        runId: runId ?? priorRow.runId ?? null,
      };
    } else {
      nextRows[index] = nextRow;
    }
  } else {
    nextRows.push(nextRow);
  }
  setLogRows(nextRows, { autoScroll: true });
}

function applyToolResultSignal(payload) {
  const record = asRecord(payload);
  const pid = asString(record?.pid);
  if (pid && pid !== getActivePid()) {
    return;
  }
  const callId = asString(record?.callId);
  if (!callId) {
    return;
  }
  const toolName = asString(record?.name) || "Tool";
  const syscall = asString(record?.syscall);
  const ok = asBoolean(record?.ok);
  const runId = asString(record?.runId);
  const nextRows = logRows.slice();
  const index = findToolRowIndex(nextRows, callId);
  const priorArgs = index >= 0 && (nextRows[index].kind === "toolCall" || nextRows[index].kind === "toolResult")
    ? nextRows[index].args
    : {};
  const nextRow = {
    kind: "toolResult",
    toolName,
    callId,
    args: priorArgs ?? {},
    syscall,
    output: record?.output,
    ok: ok !== false,
    error: asString(record?.error) ?? null,
    timestamp: Date.now(),
    runId: runId ?? null,
  };
  if (index >= 0) {
    const priorRow = nextRows[index];
    nextRows[index] = {
      ...nextRow,
      args: priorRow.args ?? nextRow.args,
      syscall: nextRow.syscall ?? priorRow.syscall,
      runId: nextRow.runId ?? priorRow.runId ?? null,
    };
  } else {
    nextRows.push(nextRow);
  }
  setLogRows(nextRows, { autoScroll: true });
}

function labelForRole(role) {
  if (role === "user") return currentUsername || "You";
  if (role === "assistant") return "Assistant";
  return "System";
}

function activeThreadEntry() {
  const activeWorkspaceId = activeThreadContext?.workspaceId || null;
  if (!activeWorkspaceId) {
    return null;
  }
  return recentThreads.find((entry) => entry.workspaceId === activeWorkspaceId) || null;
}

function activeThreadTitle() {
  const entry = activeThreadEntry();
  const label = typeof entry?.label === "string" ? entry.label.trim() : "";
  return label || "Conversation";
}

function renderLog(options = {}) {
  if (!elements.chatLog) {
    return;
  }
  const shouldScroll = options.forceBottom === true
    ? true
    : (options.autoScroll === true ? isNearBottom(elements.chatLog) : false);
  const rowsHtml = logRows.map((row) => {
    if (row.kind === "toolCall" || row.kind === "toolResult") {
      return renderToolRow(row);
    }
    const role = row.role === "user" ? "user" : row.role === "assistant" ? "assistant" : "system";
    const timestamp = row.timestamp ? formatTimestamp(row.timestamp) : "";
    const thinking = Array.isArray(row.thinking) ? row.thinking.filter(Boolean) : [];
    const thinkingHtml = thinking.length > 0
      ? '<details class="message-thinking"><summary>Reasoning</summary><div class="message-thinking-body">' + escapeHtmlClient(thinking.join("\n\n")) + '</div></details>'
      : "";
    const mediaHtml = Array.isArray(row.media) && row.media.length > 0
      ? '<div class="message-media">' + row.media.map((item) => (
        '<span class="message-media-chip">' + escapeHtmlClient(describeAttachment(item)) + '</span>'
      )).join("") + '</div>'
      : "";
    const bodyHtml = role === "assistant"
      ? '<div class="message-body message-markdown">' + renderMarkdownHtml(row.text) + '</div>'
      : '<pre class="message-body">' + escapeHtmlClient(row.text) + '</pre>';
    return '<article class="message message-' + escapeHtmlClient(role) + '">' +
      '<div class="message-head"><span>' + escapeHtmlClient(labelForRole(role)) + '</span><span>' + escapeHtmlClient(timestamp) + '</span></div>' +
      thinkingHtml +
      bodyHtml +
      mediaHtml +
    '</article>';
  }).join("");
  const pendingHtml = pendingAssistantState
    ? '<article class="message-pending"><span class="thinking-indicator" aria-hidden="true"></span><span>' + escapeHtmlClient(pendingAssistantState === "tool" ? "Working..." : "Thinking...") + '</span></article>'
    : "";
  elements.chatLog.innerHTML = rowsHtml + pendingHtml;
  if (shouldScroll) {
    elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  }
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
  currentUsername = typeof status.username === "string" && status.username.trim() ? status.username.trim() : null;
  if (elements.connectionPill) {
    elements.connectionPill.textContent = "";
    elements.connectionPill.title = status.state;
    elements.connectionPill.setAttribute("aria-label", status.state);
    elements.connectionPill.className = 'pill is-' + status.state;
  }
  if (elements.composeStatus) {
    if (hostError) {
      elements.composeStatus.textContent = hostError;
    } else if (abortBusy) {
      elements.composeStatus.textContent = "Stopping active run...";
    } else if (messageBusy) {
      elements.composeStatus.textContent = "Run in progress. Responses will refresh as signals arrive.";
    } else if (pendingAssistantState) {
      elements.composeStatus.textContent = "Run active. Send to queue another message or stop it.";
    } else if (activeThreadContext) {
      elements.composeStatus.textContent = "Attached to active thread.";
    } else {
      elements.composeStatus.textContent = status.state === "connected" ? "Send a message to start a new thread." : (status.message || "Waiting for desktop host.");
    }
  }
  if (elements.activeThreadTitle) {
    elements.activeThreadTitle.textContent = activeThreadContext
      ? activeThreadTitle()
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
  if (elements.attachmentInput) {
    elements.attachmentInput.disabled = !interactive || messageBusy;
  }
  if (elements.sendButton) {
    const hasText = elements.chatInput && elements.chatInput.value.trim().length > 0;
    const hasAttachments = pendingAttachments.length > 0;
    elements.sendButton.disabled = !interactive || messageBusy || (!hasText && !hasAttachments);
  }
  if (elements.stopRun) {
    const hasActiveRun = Boolean(getActivePid()) && (messageBusy || pendingAssistantState !== null);
    elements.stopRun.disabled = !interactive || abortBusy || !hasActiveRun;
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
      if ((parsed.text && parsed.text.trim()) || parsed.thinking.length > 0) {
        rows.push({ kind: "message", role: "assistant", text: parsed.text, thinking: parsed.thinking, timestamp });
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
        const callId = parsedResult.callId ?? "tool-result";
        const priorCallIndex = rows.findIndex((row) => row.kind === "toolCall" && row.callId === callId);
        if (priorCallIndex >= 0) {
          const priorCall = rows[priorCallIndex];
          rows[priorCallIndex] = {
            kind: "toolResult",
            toolName: parsedResult.toolName,
            callId,
            args: priorCall.args,
            syscall: parsedResult.syscall ?? priorCall.syscall,
            output: parsedResult.output,
            ok: parsedResult.ok,
            error: parsedResult.error ?? null,
            timestamp,
          };
        } else {
          rows.push({
            kind: "toolResult",
            toolName: parsedResult.toolName,
            callId,
            args: {},
            syscall: parsedResult.syscall,
            output: parsedResult.output,
            ok: parsedResult.ok,
            error: parsedResult.error ?? null,
            timestamp,
          });
        }
      } else {
        rows.push({ kind: "message", role: "system", text: formatMessageContent(entry.content), timestamp });
      }
      continue;
    }
    const role = entry?.role === "user" ? "user" : entry?.role === "assistant" ? "assistant" : "system";
    const contentRecord = asRecord(entry?.content);
    const media = Array.isArray(contentRecord?.media) ? contentRecord.media : [];
    const text = contentRecord ? (asString(contentRecord.text) || formatMessageContent(entry?.content)) : formatMessageContent(entry?.content);
    rows.push({ kind: "message", role, text, media, timestamp });
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
    setLogRows([{ role: "system", text: "No thread selected. Send a message to start a new thread.", timestamp: Date.now() }], { forceBottom: true });
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
      setLogRows([{ role: "system", text: "history error: " + result.error, timestamp: Date.now() }], { forceBottom: true });
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
  pendingAssistantState = null;
  setLogRows(rows, { forceBottom: true });
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

function scheduleRefresh(options = {}) {
  const refreshHistory = options.history === true;
  const refreshThreads = options.threads === true;
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
  }
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    if (refreshThreads) {
      void loadThreads();
    }
    if (refreshHistory) {
      void loadHistory();
    }
  }, 250);
}

function setPendingAssistantState(nextState) {
  pendingAssistantState = nextState;
  renderLog({ autoScroll: true });
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
  pendingAssistantState = null;
  setLogRows([{ role: "system", text: "No thread selected. Send a message to start a new thread.", timestamp: Date.now() }], { forceBottom: true });
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
  const attachments = pendingAttachments.slice();
  if (!message && attachments.length === 0) {
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
    currentRows.push({ role: "user", text: message, media: attachments, timestamp: Date.now() });
    setLogRows(currentRows, { autoScroll: true });
    elements.chatInput.value = "";
    clearPendingAttachments();
    renderStatus();
    const result = await client.sendMessage(message, pid || undefined, attachments);
    if (!result.ok) {
      appendSystemRow("send failed: " + result.error);
      return;
    }
    setPendingAssistantState("thinking");
    if (result.queued) {
      appendSystemRow("message queued while process is busy");
    }
  } catch (error) {
    appendSystemRow("send failed: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    messageBusy = false;
    renderStatus();
  }
}

async function abortActiveRun() {
  if (!client || !client.isConnected()) {
    appendSystemRow("session is locked");
    return;
  }
  const pid = getActivePid();
  if (!pid || abortBusy) {
    return;
  }

  abortBusy = true;
  renderStatus();
  try {
    const result = await client.call("proc.abort", { pid });
    if (!result || result.ok !== true) {
      appendSystemRow("stop failed");
      return;
    }

    if (result.aborted) {
      if (result.continuedQueuedRunId) {
        suppressNextAbortedComplete = true;
        setPendingAssistantState("thinking");
      } else {
        setPendingAssistantState(null);
        appendSystemRow("run interrupted");
      }
    }
  } catch (error) {
    appendSystemRow("stop failed: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    abortBusy = false;
    renderStatus();
  }
}

function openCompanion(appId) {
  if (!activeThreadContext) {
    return;
  }
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: OPEN_APP_EVENT,
        detail: { appId, threadContext: activeThreadContext },
      }, window.location.origin);
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
      const detail = asRecord((event).detail);
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
  elements.stopRun?.addEventListener("click", () => { void abortActiveRun(); });
  elements.composeForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });
  elements.attachmentList?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const rawIndex = target.getAttribute("data-attachment-remove");
    if (rawIndex === null) return;
    const index = Number(rawIndex);
    if (!Number.isFinite(index)) return;
    pendingAttachments = pendingAttachments.filter((_, itemIndex) => itemIndex !== index);
    renderAttachmentList();
    renderStatus();
  });
  elements.attachmentInput?.addEventListener("change", () => {
    const files = Array.from(elements.attachmentInput?.files || []);
    if (files.length === 0) {
      renderStatus();
      return;
    }
    void Promise.all(files.map((file) => readAttachmentFile(file)))
      .then((attachments) => {
        pendingAttachments = pendingAttachments.concat(attachments);
        renderAttachmentList();
        renderStatus();
      })
      .catch((error) => {
        appendSystemRow("attachment read failed: " + (error instanceof Error ? error.message : String(error)));
      });
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
  setLogRows([{ role: "system", text: "Waiting for desktop host.", timestamp: Date.now() }], { forceBottom: true });
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
    client.onSignal((signal, payload) => {
      if (signal === "chat.tool_call") {
        setPendingAssistantState("tool");
        applyToolCallSignal(payload);
      } else if (signal === "chat.tool_result" || signal === "chat.text") {
        if (signal === "chat.text") {
          applyAssistantSignal(payload);
          setPendingAssistantState(null);
        } else {
          applyToolResultSignal(payload);
          setPendingAssistantState("thinking");
        }
      } else if (signal === "chat.complete") {
        const payloadRecord = asRecord(payload);
        if (payloadRecord?.aborted === true && suppressNextAbortedComplete) {
          suppressNextAbortedComplete = false;
        } else {
          suppressNextAbortedComplete = false;
          setPendingAssistantState(null);
        }
      } else if (signal === "chat.error" || signal === "process.exit") {
        suppressNextAbortedComplete = false;
        setPendingAssistantState(null);
        scheduleRefresh({ threads: true });
      }
    });
    renderStatus();
    if (activeThreadContext) {
      await loadHistory();
    } else {
      setLogRows([{ role: "system", text: "No thread selected. Send a message to start a new thread.", timestamp: Date.now() }], { forceBottom: true });
    }
    await loadThreads();
  } catch (error) {
    hostError = error instanceof Error ? error.message : String(error);
    setLogRows([{ role: "system", text: "HOST bridge unavailable. Open Chat from the desktop shell.", timestamp: Date.now() }], { forceBottom: true });
    renderStatus();
  }
}

void boot();
