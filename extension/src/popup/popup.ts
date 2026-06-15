import "./popup.css";
import { connectionText, escapeHtml, sendUiMessage, timeAgo } from "../shared/ui-client";
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
  const button = target.closest<HTMLButtonElement>("button[data-action]");
  const action = button?.dataset.action;
  if (action) {
    void runAction(action);
  }
});

void refresh();
setInterval(() => {
  void refresh(false);
}, 2_000);

async function refresh(showLoading = true): Promise<void> {
  if (showLoading && !currentState) {
    appEl.innerHTML = `<div class="popup"><p class="loading">Loading...</p></div>`;
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
    } else if (action === "side-panel") {
      const window = await chrome.windows.getCurrent();
      response = await sendUiMessage({ type: "open-side-panel", windowId: window.id });
    } else if (action === "options") {
      await chrome.runtime.openOptionsPage();
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
    appEl.innerHTML = `<div class="popup"><p class="loading">Loading...</p></div>`;
    return;
  }

  const connected = state.connection.state === "connected";
  const mainAction = connected ? "disconnect" : "connect";
  const mainLabel = connected ? "Disconnect" : state.connection.state === "connecting" ? "Connecting" : "Connect";
  const latest = latestAgentEvent(state);

  appEl.innerHTML = `
    <section class="popup">
      <header class="top">
        <div>
          <span class="kicker">Browser target</span>
          <div class="product">GSV</div>
        </div>
        <div class="status status--${escapeHtml(state.connection.state)}">
          <span class="dot"></span>
          <span>${escapeHtml(connectionText(state))}</span>
        </div>
      </header>

      <section class="state state--${escapeHtml(stateTone(state))}">
        <span>${escapeHtml(stateEyebrow(state))}</span>
        <h1>${escapeHtml(stateHeadline(state))}</h1>
        <p title="${escapeHtml(state.config.gatewayUrl)}">${escapeHtml(stateDescription(state))}</p>
      </section>

      <section class="last" aria-label="Last agent action">
        <span class="mark mark--${escapeHtml(eventTone(latest))}"></span>
        <div>
          <span class="kicker">Last agent action</span>
        ${latest ? `
          <strong>${escapeHtml(friendlyEventLabel(latest))}</strong>
          <p title="${escapeHtml(latest.detail)}">${escapeHtml(friendlyEventDetail(latest))}</p>
          <time title="${escapeHtml(latest.at)}">${escapeHtml(timeAgo(latest.at))}</time>
        ` : `
          <strong>No activity yet</strong>
          <p>Agents have not used this browser target in this session.</p>
        `}
        </div>
      </section>

      <div class="facts">
        ${fact("Auto-connect", state.config.autoConnect ? "On" : "Off", state.config.autoConnect ? "Startup + reconnect" : "Manual")}
        ${fact("Live access", liveAccessText(state))}
        ${fact("Saved files", savedFilesText(state))}
      </div>

      ${lastError ? `<div class="error">${escapeHtml(lastError)}</div>` : ""}

      <footer class="actions">
        <button data-action="side-panel" class="primary" ${busyAttr("side-panel")}>Open Monitor</button>
        <button data-action="stop-all" class="danger" ${busyAttr("stop-all")}>Stop All</button>
        <button data-action="${escapeHtml(mainAction)}" ${busyAttr(mainAction)}>${escapeHtml(mainLabel)}</button>
        <button data-action="options" class="quiet" ${busyAttr("options")}>Settings</button>
      </footer>
    </section>
  `;
}

function stateEyebrow(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "Active browser access";
  }
  return state.connection.state === "connected" ? "Ready" : "Not connected";
}

function stateHeadline(state: ExtensionUiState): string {
  if (liveAccessCount(state) > 0) {
    return "An agent is using browser capabilities";
  }
  if (state.connection.state === "connected") {
    return "Agents can use this browser";
  }
  if (state.connection.state === "connecting") {
    return "Connecting to GSV";
  }
  return "Browser target is offline";
}

function stateDescription(state: ExtensionUiState): string {
  const liveCount = liveAccessCount(state);
  if (liveCount > 0) {
    return `${liveCount} live browser handle${liveCount === 1 ? "" : "s"} active.`;
  }
  if (state.connection.state === "connected") {
    return "Ready and waiting for agent requests.";
  }
  return state.connection.message || `${state.targetId} is not connected.`;
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
  const parts: string[] = [];
  if (state.sensitive.networkCaptures > 0) {
    parts.push(`${state.sensitive.networkCaptures} network`);
  }
  if (state.sensitive.debuggerTabs.length > 0) {
    parts.push(`${state.sensitive.debuggerTabs.length} tab`);
  }
  return parts.length > 0 ? parts.join(", ") : "None";
}

function savedFilesText(state: ExtensionUiState): string {
  if (state.artifact.files === 0) {
    return "None";
  }
  const screenshots = state.artifact.screenshots === 1 ? "1 screenshot" : `${state.artifact.screenshots} screenshots`;
  return `${state.artifact.files} total, ${screenshots}`;
}

function latestAgentEvent(state: ExtensionUiState): ActivityEntry | null {
  return state.activity.find((entry) => entry.kind !== "connection") ?? state.activity[0] ?? null;
}

function friendlyEventLabel(entry: ActivityEntry): string {
  if (entry.label === "page screenshot") {
    return "Saved a screenshot";
  }
  if (entry.label === "page js") {
    return "Ran a page script";
  }
  if (entry.label === "page text") {
    return "Read page text";
  }
  if (entry.label.startsWith("network ")) {
    return `Network ${entry.label.replace("network ", "")}`;
  }
  if (entry.label.startsWith("fs.")) {
    return "Updated browser files";
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
    return "Connected to GSV";
  }
  if (entry.label === "disconnected") {
    return "Disconnected from GSV";
  }
  return entry.label;
}

function eventTone(entry: ActivityEntry | null): string {
  if (!entry) {
    return "neutral";
  }
  if (entry.status === "error") {
    return "danger";
  }
  if (entry.status === "active") {
    return "warning";
  }
  if (entry.kind === "connection" && entry.label !== "connected") {
    return "neutral";
  }
  return "good";
}

function fact(label: string, value: string, detail = ""): string {
  return `
    <div class="fact">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </div>
  `;
}

function busyAttr(action: string): string {
  return busyAction === action ? "disabled" : "";
}
