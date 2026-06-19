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

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("Missing #app");
}
const appEl = app;

let currentState: ExtensionUiState | null = null;
let busyAction: string | null = null;
let lastError: string | null = null;

appEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
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
    appEl.innerHTML = `<section class="monitor"><p class="loading">Loading target...</p></section>`;
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
    } else if (action === "clear-diagnostics") {
      response = await sendUiMessage({ type: "clear-diagnostics" });
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
    appEl.innerHTML = `<section class="monitor"><p class="loading">Loading target...</p></section>`;
    return;
  }

  const connected = state.connection.state === "connected";
  const liveCount = liveAccessCount(state);
  const mainAction = connected ? "disconnect" : "connect";
  const mainLabel = connected ? "Disconnect" : state.connection.state === "connecting" ? "Connecting" : "Connect";

  appEl.innerHTML = `
    <section class="monitor">
      <header class="header">
        <div>
          <span class="eyebrow">GSV Browser Target</span>
          <strong>${escapeHtml(state.targetId)}</strong>
        </div>
        <span class="status status--${escapeHtml(state.connection.state)}">${escapeHtml(connectionText(state))}</span>
      </header>

      ${lastError ? `<div class="error">${escapeHtml(lastError)}</div>` : ""}

      <main class="content">
        <section class="plate plate--${escapeHtml(stateTone(state))}">
          <span class="plate-label">${escapeHtml(state.connection.state)}</span>
          <h1>${escapeHtml(headline(state))}</h1>
          <p>${escapeHtml(detail(state))}</p>
        </section>

        ${liveCount > 0 ? `
          <section class="access">
            <strong>Agent access is live</strong>
            <span>${escapeHtml(liveAccessText(state))}</span>
          </section>
        ` : ""}

        <section class="actions">
          <button data-action="${escapeHtml(mainAction)}" class="primary" ${busyAttr(mainAction)}>${escapeHtml(mainLabel)}</button>
          <button data-action="stop-all" class="danger" ${busyAttr("stop-all")}>Stop All</button>
          <button data-action="options" ${busyAttr("options")}>Settings</button>
          <button data-action="refresh" ${busyAttr("refresh")}>Refresh</button>
        </section>

        <section class="facts">
          ${fact("Gateway", state.gatewayHost)}
          ${fact("Auto-connect", state.config.autoConnect ? "On" : "Off")}
          ${fact("Debugger", state.sensitive.debuggerTabs.length > 0 ? state.sensitive.debuggerTabs.join(", ") : "None")}
          ${fact("Network", state.sensitive.networkCaptures === 0 ? "None" : String(state.sensitive.networkCaptures))}
          ${fact("Media", state.sensitive.mediaRecordings === 0 ? "None" : String(state.sensitive.mediaRecordings))}
        </section>

        <section class="activity">
          <header>
            <h2>Recent</h2>
            <span>${escapeHtml(state.activity.length === 0 ? "no events" : `${state.activity.length} events`)}</span>
          </header>
          <div class="event-list">
            ${recentAgentEvents(state).length > 0 ? recentAgentEvents(state).map(renderEventRow).join("") : "<p class=\"empty\">No agent activity yet.</p>"}
          </div>
        </section>

        <details class="advanced">
          <summary>Advanced</summary>
          <div class="details">
            ${detailRow("Connection id", state.connection.connectionId ?? "-")}
            ${detailRow("Message", state.connection.message ?? "-")}
            ${detailRow("Last connected", state.diagnostics.lastConnectedAt ?? "-")}
            ${detailRow("Last error", state.diagnostics.lastError ?? "-")}
            ${detailRow("Files", String(state.artifact.files))}
            ${detailRow("Screenshots", String(state.artifact.screenshots))}
            ${detailRow("Network sessions", String(state.artifact.networkSessions))}
            ${detailRow("Diagnostics", state.diagnostics.updatedAt ?? "-")}
          </div>
          <button data-action="clear-diagnostics" class="danger text-button" ${busyAttr("clear-diagnostics")}>Clear Diagnostics</button>
        </details>
      </main>
    </section>
  `;
}

function headline(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "Agent using this browser";
  }
  if (state.connection.state === "connected") {
    return "Ready";
  }
  if (state.connection.state === "connecting") {
    return "Connecting";
  }
  return "Offline";
}

function detail(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "Use Stop All to release active browser capture.";
  }
  if (state.connection.state === "connected") {
    return "This browser is available as a Unix-shaped GSV target.";
  }
  return state.connection.message || "Connect to make this browser available.";
}

function stateTone(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "active";
  }
  return state.connection.state;
}

function liveAccessCount(state: ExtensionUiState): number {
  return state.sensitive.networkCaptures
    + state.sensitive.mediaRecordings
    + state.sensitive.debuggerTabs.length;
}

function liveAccessText(state: ExtensionUiState): string {
  const parts: string[] = [];
  if (state.sensitive.networkCaptures > 0) {
    parts.push(`${state.sensitive.networkCaptures} network capture${state.sensitive.networkCaptures === 1 ? "" : "s"}`);
  }
  if (state.sensitive.mediaRecordings > 0) {
    parts.push(`${state.sensitive.mediaRecordings} media recording${state.sensitive.mediaRecordings === 1 ? "" : "s"}`);
  }
  if (state.sensitive.debuggerTabs.length > 0) {
    parts.push(`${state.sensitive.debuggerTabs.length} debugger tab${state.sensitive.debuggerTabs.length === 1 ? "" : "s"}`);
  }
  return parts.join(" / ");
}

function recentAgentEvents(state: ExtensionUiState): ActivityEntry[] {
  return state.activity.filter((entry) => entry.kind !== "connection").slice(0, 3);
}

function renderEventRow(entry: ActivityEntry): string {
  const duration = formatDuration(entry.durationMs);
  const meta = [timeAgo(entry.at), duration].filter(Boolean).join(" / ");
  return `
    <article class="event event--${escapeHtml(entry.status)}">
      <strong>${escapeHtml(friendlyEventLabel(entry))}</strong>
      <span title="${escapeHtml(entry.detail)}">${escapeHtml(friendlyEventDetail(entry))}</span>
      <time title="${escapeHtml(entry.at)}">${escapeHtml(meta)}</time>
    </article>
  `;
}

function friendlyEventLabel(entry: ActivityEntry): string {
  if (entry.label === "page screenshot") {
    return "Screenshot";
  }
  if (entry.label === "page js") {
    return "Page script";
  }
  if (entry.label === "page text") {
    return "Page text";
  }
  if (entry.label.startsWith("network ")) {
    return `Network ${entry.label.replace("network ", "")}`;
  }
  if (entry.label.startsWith("fs.")) {
    return "File operation";
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
  return truncateMiddle(entry.detail, 80);
}

function fact(label: string, value: string): string {
  return `
    <div class="fact">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
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

function busyAttr(action: string): string {
  return busyAction === action ? "disabled" : "";
}
