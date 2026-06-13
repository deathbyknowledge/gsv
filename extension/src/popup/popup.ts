import "./popup.css";
import { connectionText, escapeHtml, renderActivityEntry, sendUiMessage, timeAgo } from "../shared/ui-client";
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
  if (!action) {
    return;
  }
  void runAction(action);
});

void refresh();
setInterval(() => {
  void refresh(false);
}, 2_000);

async function refresh(showLoading = true): Promise<void> {
  if (showLoading && !currentState) {
    appEl.innerHTML = `<div class="shell"><p class="loading">Loading...</p></div>`;
  }
  const response = await sendUiMessage({ type: "status" });
  handleResponse(response);
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
    appEl.innerHTML = `<div class="shell"><p class="loading">Loading...</p></div>`;
    return;
  }

  const connected = state.connection.state === "connected";
  const activeSensitive = state.sensitive.networkCaptures > 0 || state.sensitive.debuggerTabs.length > 0;
  const activity = state.activity.slice(0, 4);
  const mainAction = connected ? "disconnect" : "connect";
  const mainLabel = connected ? "Disconnect" : state.connection.state === "connecting" ? "Connecting" : "Reconnect";

  appEl.innerHTML = `
    <section class="shell">
      <header class="top">
        <div class="status status--${escapeHtml(state.connection.state)}">
          <span class="dot"></span>
          <span>${escapeHtml(connectionText(state))}</span>
        </div>
        <div class="target" title="${escapeHtml(state.config.gatewayUrl)}">${escapeHtml(state.targetId)}</div>
      </header>

      <div class="snapshot">
        <div>
          <span class="label">last event</span>
          <strong>${escapeHtml(state.activity[0]?.label ?? "none")}</strong>
          <span title="${escapeHtml(state.activity[0]?.at ?? "")}">${escapeHtml(timeAgo(state.activity[0]?.at ?? null))}</span>
        </div>
        <div>
          <span class="label">sensitive</span>
          <strong>${escapeHtml(String(state.sensitive.networkCaptures + state.sensitive.debuggerTabs.length))}</strong>
          <span>${escapeHtml(activeSensitive ? "active handles" : "idle")}</span>
        </div>
        <div>
          <span class="label">artifacts</span>
          <strong>${escapeHtml(String(state.artifact.files))}</strong>
          <span>${escapeHtml(`${state.artifact.screenshots} screenshots`)}</span>
        </div>
      </div>

      <ul class="activity">
        ${activity.length > 0 ? activity.map(renderActivityEntry).join("") : "<li class=\"empty\">No events yet</li>"}
      </ul>

      ${lastError ? `<div class="error">${escapeHtml(lastError)}</div>` : ""}

      <footer class="actions">
        <button data-action="stop-all" class="danger" ${busyAttr("stop-all")}>Stop All</button>
        <button data-action="${escapeHtml(mainAction)}" ${busyAttr(mainAction)}>${escapeHtml(mainLabel)}</button>
        <button data-action="side-panel" ${busyAttr("side-panel")}>Panel</button>
        <button data-action="options" class="quiet" ${busyAttr("options")}>Options</button>
      </footer>
    </section>
  `;
}

function busyAttr(action: string): string {
  return busyAction === action ? "disabled" : "";
}
