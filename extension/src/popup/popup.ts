import "./popup.css";
import { connectionText, escapeHtml, sendUiMessage, timeAgo } from "../shared/ui-client";
import type { ExtensionUiState, RuntimeResponse } from "../shared/ui-state";

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
    appEl.innerHTML = `<section class="popup"><p class="loading">Loading target...</p></section>`;
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
    } else if (action === "grant-media-capture") {
      response = await sendUiMessage({ type: "grant-media-capture" });
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
    appEl.innerHTML = `<section class="popup"><p class="loading">Loading target...</p></section>`;
    return;
  }

  const connected = state.connection.state === "connected";
  const liveCount = liveAccessCount(state);
  const mainAction = connected ? "disconnect" : "connect";
  const mainLabel = connected ? "Disconnect" : state.connection.state === "connecting" ? "Connecting" : "Connect";

  appEl.innerHTML = `
    <section class="popup">
      <header class="topline">
        <div>
          <span class="eyebrow">GSV Browser Target</span>
          <strong>${escapeHtml(state.targetId)}</strong>
        </div>
        <span class="status status--${escapeHtml(state.connection.state)}">${escapeHtml(connectionText(state))}</span>
      </header>

      <section class="plate plate--${escapeHtml(stateTone(state))}">
        <span class="plate-label">${escapeHtml(state.connection.state)}</span>
        <h1>${escapeHtml(headline(state))}</h1>
        <p title="${escapeHtml(state.config.gatewayUrl)}">${escapeHtml(detail(state))}</p>
      </section>

      ${liveCount > 0 ? `
        <section class="access">
          <strong>Agent access is live</strong>
          <span>${escapeHtml(liveAccessText(state))}</span>
        </section>
      ` : ""}

      ${state.media.captureGrant ? `
        <section class="grant">
          <strong>One recording grant ready</strong>
          <span>${escapeHtml(recordingGrantText(state))}</span>
        </section>
      ` : ""}

      ${lastError ? `<div class="error">${escapeHtml(lastError)}</div>` : ""}

      <footer class="actions">
        <button data-action="grant-media-capture" class="wide" ${busyAttr("grant-media-capture")}>Grant Recording</button>
        <button data-action="${escapeHtml(mainAction)}" class="primary" ${busyAttr(mainAction)}>${escapeHtml(mainLabel)}</button>
        <button data-action="stop-all" class="danger" ${busyAttr("stop-all")}>Stop All</button>
        <button data-action="side-panel" ${busyAttr("side-panel")}>Monitor</button>
        <button data-action="options" ${busyAttr("options")}>Settings</button>
      </footer>

      <div class="footnote">
        <span>${escapeHtml(state.gatewayHost)}</span>
        <span>${escapeHtml(lastSeen(state))}</span>
      </div>
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
    return "Agents can reach this browser through shell.exec and fs.*.";
  }
  return state.connection.message || "Connect this browser to make it available.";
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

function recordingGrantText(state: ExtensionUiState): string {
  const grant = state.media.captureGrant;
  if (!grant) {
    return "";
  }
  const label = grant.title || grant.url || `tab ${grant.tabId}`;
  return `${label} / ${timeUntil(grant.expiresAt)}`;
}

function lastSeen(state: ExtensionUiState): string {
  const latest = state.activity.find((entry) => entry.kind !== "connection") ?? state.activity[0];
  return latest ? `last ${timeAgo(latest.at)}` : "no activity";
}

function busyAttr(action: string): string {
  return busyAction === action ? "disabled" : "";
}

function timeUntil(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "expires soon";
  }
  const seconds = Math.max(0, Math.ceil((then - Date.now()) / 1000));
  if (seconds <= 0) {
    return "expired";
  }
  if (seconds < 60) {
    return `${seconds}s left`;
  }
  return `${Math.ceil(seconds / 60)}m left`;
}
