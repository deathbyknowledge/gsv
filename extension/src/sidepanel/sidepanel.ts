import "./sidepanel.css";
import {
  connectionText,
  escapeHtml,
  formatDuration,
  sendUiMessage,
  timeAgo,
  truncateMiddle,
} from "../shared/ui-client";
import type { ActivityEntry, ExtensionUiState, RuntimeResponse } from "../shared/ui-state";

type ViewId = "overview" | "activity" | "data" | "advanced";

const views: Array<{ id: ViewId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "data", label: "Data" },
  { id: "advanced", label: "Advanced" },
];

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("Missing #app");
}
const appEl = app;

let currentState: ExtensionUiState | null = null;
let activeView: ViewId = "overview";
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
      <main class="content">
        ${renderView(state)}
      </main>
    </section>
  `;
}

function renderHeader(state: ExtensionUiState): string {
  const connected = state.connection.state === "connected";
  const mainAction = connected ? "disconnect" : "connect";
  const mainLabel = connected ? "Disconnect" : state.connection.state === "connecting" ? "Connecting" : "Connect";
  return `
    <header class="header">
      <div class="title-block">
        <strong>GSV Browser Target</strong>
        <span title="${escapeHtml(state.config.gatewayUrl)}">${escapeHtml(state.targetId)}</span>
      </div>
      <div class="header-right">
        <div class="status status--${escapeHtml(state.connection.state)}">
          <span class="dot"></span>
          <span>${escapeHtml(connectionText(state))}</span>
        </div>
        <button data-action="${escapeHtml(mainAction)}" ${busyAttr(mainAction)}>${escapeHtml(mainLabel)}</button>
      </div>
    </header>
  `;
}

function renderView(state: ExtensionUiState): string {
  switch (activeView) {
    case "overview":
      return renderOverview(state);
    case "activity":
      return renderActivity(state);
    case "data":
      return renderData(state);
    case "advanced":
      return renderAdvanced(state);
  }
}

function renderOverview(state: ExtensionUiState): string {
  const latest = latestAgentEvent(state);
  return `
    <section class="hero hero--${escapeHtml(stateTone(state))}">
      <div>
        <span>${escapeHtml(stateEyebrow(state))}</span>
        <h1>${escapeHtml(stateHeadline(state))}</h1>
        <p>${escapeHtml(stateDescription(state))}</p>
      </div>
      <div class="hero-actions">
        <button data-action="stop-all" class="danger" ${busyAttr("stop-all")}>Stop All</button>
        <button data-action="options" ${busyAttr("options")}>Settings</button>
      </div>
    </section>

    <section class="summary-grid">
      ${summaryCard("Connection", connectionText(state), state.connection.message ?? state.connection.connectionId ?? state.gatewayHost)}
      ${summaryCard("Live browser access", liveAccessText(state), liveAccessDetail(state))}
      ${summaryCard("Last action", latest ? friendlyEventLabel(latest) : "None", latest ? timeAgo(latest.at) : "No events")}
      ${summaryCard("Saved data", savedFilesText(state), `${state.artifact.networkSessions} network sessions`)}
    </section>

    <section class="section">
      <header class="section-title">
        <h2>Recent Activity</h2>
        <button data-view="activity">View all</button>
      </header>
      <div class="event-list">
        ${state.activity.length > 0 ? state.activity.slice(0, 6).map(renderEventRow).join("") : "<p class=\"empty\">No activity yet</p>"}
      </div>
    </section>
  `;
}

function renderActivity(state: ExtensionUiState): string {
  const agentEvents = state.activity.filter((entry) => entry.kind !== "connection");
  return `
    <section class="summary-grid">
      ${summaryCard("Agent actions", agentEvents.length, "This session")}
      ${summaryCard("Errors", state.activity.filter((entry) => entry.status === "error").length, "Failed calls")}
      ${summaryCard("Last activity", timeAgo(state.activity[0]?.at ?? null), state.activity[0]?.label ?? "None")}
    </section>
    <section class="section">
      <header class="section-title">
        <h2>Activity</h2>
        <button data-action="refresh" ${busyAttr("refresh")}>Refresh</button>
      </header>
      <div class="event-list event-list--full">
        ${state.activity.length > 0 ? state.activity.slice(0, 64).map(renderEventRow).join("") : "<p class=\"empty\">No activity yet</p>"}
      </div>
    </section>
  `;
}

function renderData(state: ExtensionUiState): string {
  return `
    <section class="summary-grid">
      ${summaryCard("Files", state.artifact.files, "Created in target storage")}
      ${summaryCard("Screenshots", state.artifact.screenshots, "/home/browser/screenshots")}
      ${summaryCard("Network captures", state.network.captures.length, activeCaptureDetail(state))}
    </section>

    <section class="section">
      <header class="section-title">
        <h2>Active Captures</h2>
      </header>
      <div class="capture-list">
        ${state.network.captures.length > 0 ? state.network.captures.map(renderCapture).join("") : "<p class=\"empty\">No active captures</p>"}
      </div>
    </section>

    <section class="section">
      <header class="section-title">
        <h2>Target Storage</h2>
      </header>
      <div class="path-list">
        ${pathRow("/home/browser/screenshots", "Screenshots")}
        ${pathRow("/home/browser/network/sessions", "Network capture files")}
        ${pathRow("/home/browser", "Persistent browser target files")}
        ${pathRow("/tmp", "Temporary files")}
      </div>
    </section>
  `;
}

function renderAdvanced(state: ExtensionUiState): string {
  return `
    <section class="summary-grid">
      ${summaryCard("Target id", state.targetId, state.gatewayHost)}
      ${summaryCard("Auto-connect", state.config.autoConnect ? "On" : "Off", "Startup behavior")}
      ${summaryCard("Token", state.config.token ? "Set" : "Missing", state.config.username || "No username")}
    </section>

    <section class="section">
      <header class="section-title">
        <h2>Session</h2>
        <button data-action="refresh" ${busyAttr("refresh")}>Refresh</button>
      </header>
      <div class="detail-list">
        ${detailRow("Connection id", state.connection.connectionId ?? "-")}
        ${detailRow("Gateway", state.gatewayHost)}
        ${detailRow("Message", state.connection.message ?? "-")}
        ${detailRow("Updated", state.updatedAt)}
        ${detailRow("Debugger tabs", state.sensitive.debuggerTabs.length > 0 ? state.sensitive.debuggerTabs.join(", ") : "None")}
      </div>
    </section>
  `;
}

function renderEventRow(entry: ActivityEntry): string {
  const duration = formatDuration(entry.durationMs);
  return `
    <article class="event event--${escapeHtml(entry.status)}">
      <div class="event-main">
        <strong>${escapeHtml(friendlyEventLabel(entry))}</strong>
        <span title="${escapeHtml(entry.detail)}">${escapeHtml(friendlyEventDetail(entry))}</span>
      </div>
      <div class="event-meta">
        <span title="${escapeHtml(entry.at)}">${escapeHtml(timeAgo(entry.at))}</span>
        ${duration ? `<span>${escapeHtml(duration)}</span>` : ""}
      </div>
    </article>
  `;
}

function renderCapture(capture: ExtensionUiState["network"]["captures"][number]): string {
  return `
    <article class="capture">
      <div>
        <strong>Tab ${escapeHtml(capture.tabId)}</strong>
        <span>${escapeHtml(`${capture.requestCount} requests, ${capture.eventCount} events`)}</span>
      </div>
      <div>
        <span>${escapeHtml(capture.persist ? "Persisting" : "In memory")}</span>
        <span>${escapeHtml(capture.bodies ? "Bodies on" : "Headers only")}</span>
      </div>
      ${capture.sessionPath ? `<code title="${escapeHtml(capture.sessionPath)}">${escapeHtml(truncateMiddle(capture.sessionPath, 54))}</code>` : ""}
    </article>
  `;
}

function summaryCard(label: string, value: string | number, detail: string): string {
  return `
    <article class="summary-card">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
      <em title="${escapeHtml(detail)}">${escapeHtml(detail)}</em>
    </article>
  `;
}

function pathRow(path: string, label: string): string {
  return `
    <div class="path-row">
      <strong>${escapeHtml(label)}</strong>
      <code>${escapeHtml(path)}</code>
    </div>
  `;
}

function detailRow(label: string, value: string): string {
  return `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function stateEyebrow(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "Active";
  }
  return state.connection.state === "connected" ? "Ready" : "Offline";
}

function stateHeadline(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "Agent access is live";
  }
  if (state.connection.state === "connected") {
    return "Ready for agent requests";
  }
  if (state.connection.state === "connecting") {
    return "Connecting";
  }
  return "Disconnected";
}

function stateDescription(state: ExtensionUiState): string {
  const liveCount = liveAccessCount(state);
  if (liveCount > 0) {
    return `${liveCount} browser handle${liveCount === 1 ? "" : "s"} active.`;
  }
  if (state.connection.state === "connected") {
    return "No live browser handles.";
  }
  return state.connection.message || "No active GSV connection.";
}

function stateTone(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "active";
  }
  return state.connection.state;
}

function liveAccessCount(state: ExtensionUiState): number {
  return state.sensitive.networkCaptures + state.sensitive.debuggerTabs.length;
}

function liveAccessText(state: ExtensionUiState): string {
  const liveCount = liveAccessCount(state);
  return liveCount === 0 ? "None" : `${liveCount} active`;
}

function liveAccessDetail(state: ExtensionUiState): string {
  const parts: string[] = [];
  if (state.sensitive.networkCaptures > 0) {
    parts.push(`${state.sensitive.networkCaptures} network`);
  }
  if (state.sensitive.debuggerTabs.length > 0) {
    parts.push(`${state.sensitive.debuggerTabs.length} debugger`);
  }
  return parts.length > 0 ? parts.join(", ") : "Idle";
}

function savedFilesText(state: ExtensionUiState): string {
  if (state.artifact.files === 0) {
    return "None";
  }
  return `${state.artifact.files} files`;
}

function activeCaptureDetail(state: ExtensionUiState): string {
  const requests = state.network.captures.reduce((sum, capture) => sum + capture.requestCount, 0);
  return requests === 1 ? "1 request" : `${requests} requests`;
}

function latestAgentEvent(state: ExtensionUiState): ActivityEntry | null {
  return state.activity.find((entry) => entry.kind !== "connection") ?? state.activity[0] ?? null;
}

function friendlyEventLabel(entry: ActivityEntry): string {
  if (entry.label === "page screenshot") {
    return "Saved screenshot";
  }
  if (entry.label === "page js") {
    return "Ran page script";
  }
  if (entry.label === "page text") {
    return "Read page text";
  }
  if (entry.label === "page snapshot") {
    return "Captured page snapshot";
  }
  if (entry.label.startsWith("network ")) {
    return `Network ${entry.label.replace("network ", "")}`;
  }
  if (entry.label.startsWith("fs.")) {
    return "File operation";
  }
  if (entry.kind === "connection") {
    return connectionEventLabel(entry);
  }
  return entry.label;
}

function friendlyEventDetail(entry: ActivityEntry): string {
  if (entry.status === "error") {
    return `Failed: ${entry.detail}`;
  }
  if (!entry.detail || entry.detail === "(no path)") {
    return "Completed";
  }
  return entry.detail;
}

function connectionEventLabel(entry: ActivityEntry): string {
  if (entry.label === "connected") {
    return "Connected";
  }
  if (entry.label === "disconnected") {
    return "Disconnected";
  }
  if (entry.label === "connecting") {
    return "Connecting";
  }
  return entry.label;
}

function busyAttr(action: string): string {
  return busyAction === action ? "disabled" : "";
}

function isViewId(value: string): value is ViewId {
  return views.some((view) => view.id === value);
}
