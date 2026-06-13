import "./sidepanel.css";
import {
  connectionText,
  escapeHtml,
  renderActivityEntry,
  sendUiMessage,
  timeAgo,
  truncateMiddle,
} from "../shared/ui-client";
import type { ExtensionUiState, RuntimeResponse } from "../shared/ui-state";

type ViewId = "activity" | "sensitive" | "artifacts" | "network" | "runtime";

const views: Array<{ id: ViewId; label: string }> = [
  { id: "activity", label: "Activity" },
  { id: "sensitive", label: "Sensitive" },
  { id: "artifacts", label: "Artifacts" },
  { id: "network", label: "Network" },
  { id: "runtime", label: "Runtime" },
];

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("Missing #app");
}
const appEl = app;

let currentState: ExtensionUiState | null = null;
let activeView: ViewId = "activity";
let busyAction: string | null = null;
let lastError: string | null = null;

appEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const viewButton = target.closest<HTMLButtonElement>("button[data-view]");
  if (viewButton?.dataset.view && isViewId(viewButton.dataset.view)) {
    activeView = viewButton.dataset.view;
    render();
    return;
  }
  const actionButton = target.closest<HTMLButtonElement>("button[data-action]");
  if (actionButton?.dataset.action) {
    void runAction(actionButton.dataset.action);
  }
});

void refresh();
setInterval(() => {
  void refresh(false);
}, 2_000);

async function refresh(showLoading = true): Promise<void> {
  if (showLoading && !currentState) {
    appEl.innerHTML = `<div class="panel"><p class="loading">Loading...</p></div>`;
  }
  handleResponse(await sendUiMessage({ type: "status" }));
}

async function runAction(action: string): Promise<void> {
  busyAction = action;
  render();
  try {
    let response: RuntimeResponse;
    if (action === "connect") {
      response = await sendUiMessage({ type: "connect" });
    } else if (action === "disconnect") {
      response = await sendUiMessage({ type: "disconnect" });
    } else if (action === "stop-all") {
      response = await sendUiMessage({ type: "stop-all" });
    } else if (action === "options") {
      await chrome.runtime.openOptionsPage();
      response = await sendUiMessage({ type: "status" });
    } else if (action === "refresh") {
      response = await sendUiMessage({ type: "status" });
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
    handleResponse(response);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    busyAction = null;
    render();
  }
}

function handleResponse(response: RuntimeResponse): void {
  if (response.ok) {
    currentState = response.state;
    lastError = null;
  } else {
    currentState = response.state ?? currentState;
    lastError = response.error;
  }
  render();
}

function render(): void {
  const state = currentState;
  if (!state) {
    appEl.innerHTML = `<div class="panel"><p class="loading">Loading...</p></div>`;
    return;
  }

  appEl.innerHTML = `
    <section class="panel">
      ${renderHeader(state)}
      ${lastError ? `<div class="error">${escapeHtml(lastError)}</div>` : ""}
      <nav class="tabs" aria-label="Panel views">
        ${views.map((view) => `
          <button data-view="${escapeHtml(view.id)}" class="${activeView === view.id ? "active" : ""}">
            ${escapeHtml(view.label)}
          </button>
        `).join("")}
      </nav>
      <section class="content">
        ${renderView(state)}
      </section>
    </section>
  `;
}

function renderHeader(state: ExtensionUiState): string {
  const connected = state.connection.state === "connected";
  const mainAction = connected ? "disconnect" : "connect";
  const mainLabel = connected ? "Disconnect" : "Reconnect";
  return `
    <header class="header">
      <div class="identity">
        <div class="status status--${escapeHtml(state.connection.state)}">
          <span class="dot"></span>
          <span>${escapeHtml(connectionText(state))}</span>
        </div>
        <div class="target" title="${escapeHtml(state.config.gatewayUrl)}">${escapeHtml(state.targetId)}</div>
      </div>
      <div class="header-actions">
        <button data-action="stop-all" class="danger" ${busyAttr("stop-all")}>Stop All</button>
        <button data-action="${escapeHtml(mainAction)}" ${busyAttr(mainAction)}>${escapeHtml(mainLabel)}</button>
        <button data-action="options" ${busyAttr("options")}>Options</button>
      </div>
    </header>
  `;
}

function renderView(state: ExtensionUiState): string {
  switch (activeView) {
    case "activity":
      return renderActivity(state);
    case "sensitive":
      return renderSensitive(state);
    case "artifacts":
      return renderArtifacts(state);
    case "network":
      return renderNetwork(state);
    case "runtime":
      return renderRuntime(state);
  }
}

function renderActivity(state: ExtensionUiState): string {
  const entries = state.activity.slice(0, 48);
  return `
    <div class="metrics">
      ${metric("Events", state.activity.length)}
      ${metric("Errors", state.activity.filter((entry) => entry.status === "error").length)}
      ${metric("Last", timeAgo(state.activity[0]?.at ?? null))}
    </div>
    <ul class="activity-list">
      ${entries.length > 0 ? entries.map(renderActivityEntry).join("") : "<li class=\"empty\">No events yet</li>"}
    </ul>
  `;
}

function renderSensitive(state: ExtensionUiState): string {
  const debuggerTabs = state.sensitive.debuggerTabs.length > 0
    ? state.sensitive.debuggerTabs.map((tabId) => `<code>tab ${escapeHtml(tabId)}</code>`).join("")
    : "<span class=\"muted\">none</span>";
  return `
    <div class="metrics">
      ${metric("Network", state.sensitive.networkCaptures)}
      ${metric("Debugger", state.sensitive.debuggerTabs.length)}
      ${metric("Last", timeAgo(state.sensitive.lastSensitiveAt))}
    </div>
    <div class="rows">
      ${row("Connection", connectionText(state), state.connection.message ?? state.connection.connectionId ?? "-")}
      ${row("Debugger tabs", debuggerTabs, "Held by page js or network capture")}
      ${row("Network captures", String(state.sensitive.networkCaptures), "Persistent captures keep debugger attached")}
      ${row("Stop path", "<button data-action=\"stop-all\" class=\"danger inline\">Stop All</button>", "Disconnects and releases browser handles")}
    </div>
  `;
}

function renderArtifacts(state: ExtensionUiState): string {
  return `
    <div class="metrics">
      ${metric("Files", state.artifact.files)}
      ${metric("Screenshots", state.artifact.screenshots)}
      ${metric("Network", state.artifact.networkSessions)}
    </div>
    <div class="path-grid">
      ${pathRow("/home/browser/screenshots", "PNG captures from page screenshot")}
      ${pathRow("/home/browser/network/sessions", "Persisted request metadata and bodies")}
      ${pathRow("/home/browser", "Long-lived writable target storage")}
      ${pathRow("/tmp", "Scratch writable target storage")}
    </div>
  `;
}

function renderNetwork(state: ExtensionUiState): string {
  const captures = state.network.captures;
  return `
    <div class="metrics">
      ${metric("Captures", captures.length)}
      ${metric("Requests", captures.reduce((sum, capture) => sum + capture.requestCount, 0))}
      ${metric("Events", captures.reduce((sum, capture) => sum + capture.eventCount, 0))}
    </div>
    <div class="capture-list">
      ${captures.length > 0 ? captures.map((capture) => `
        <div class="capture">
          <div>
            <strong>tab ${escapeHtml(capture.tabId)}</strong>
            <span>${escapeHtml(timeAgo(capture.startedAt))} / ${escapeHtml(capture.persist ? "persist" : "memory")} / ${escapeHtml(capture.bodies ? "bodies" : "headers")}</span>
          </div>
          <div class="numbers">
            <span>${escapeHtml(capture.requestCount)} req</span>
            <span>${escapeHtml(capture.eventCount)} events</span>
          </div>
          ${capture.sessionPath ? `<code title="${escapeHtml(capture.sessionPath)}">${escapeHtml(truncateMiddle(capture.sessionPath, 44))}</code>` : ""}
        </div>
      `).join("") : "<p class=\"empty\">No active captures</p>"}
    </div>
    <div class="command-grid">
      ${command("network start --tab <id> --persist --bodies")}
      ${command("network status")}
      ${command("network events --limit 50")}
      ${command("network export har --path /home/browser/network/latest.har")}
      ${command("network stop")}
    </div>
  `;
}

function renderRuntime(state: ExtensionUiState): string {
  const safeConfig = {
    gateway: state.gatewayHost,
    username: state.config.username || "-",
    token: state.config.token ? "set" : "missing",
    autoConnect: state.config.autoConnect,
    connectionId: state.connection.connectionId ?? "-",
    message: state.connection.message ?? "-",
    updated: state.updatedAt,
  };
  return `
    <div class="metrics">
      ${metric("State", connectionText(state))}
      ${metric("Target", state.targetId)}
      ${metric("Updated", timeAgo(state.updatedAt))}
    </div>
    <pre class="runtime-json">${escapeHtml(JSON.stringify(safeConfig, null, 2))}</pre>
    <div class="footer-actions">
      <button data-action="refresh" ${busyAttr("refresh")}>Refresh</button>
      <button data-action="options" ${busyAttr("options")}>Options</button>
    </div>
  `;
}

function metric(label: string, value: string | number): string {
  return `
    <div class="metric">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function row(label: string, value: string, detail: string): string {
  return `
    <div class="row">
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
      <em>${escapeHtml(detail)}</em>
    </div>
  `;
}

function pathRow(path: string, detail: string): string {
  return `
    <div class="path-row">
      <code>${escapeHtml(path)}</code>
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
}

function command(value: string): string {
  return `<code class="command">${escapeHtml(value)}</code>`;
}

function busyAttr(action: string): string {
  return busyAction === action ? "disabled" : "";
}

function isViewId(value: string): value is ViewId {
  return views.some((view) => view.id === value);
}
