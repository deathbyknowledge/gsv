import "./options.css";
import { normalizeGatewayUrl, type ExtensionConfig } from "../shared/config";
import {
  connectionText,
  escapeHtml,
  sendUiMessage,
  timeAgo,
} from "../shared/ui-client";
import type { ExtensionUiState, RuntimeResponse } from "../shared/ui-state";

type ConfigField = keyof ExtensionConfig;
type FieldErrors = Partial<Record<ConfigField, string>>;

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("Missing #app");
}
const appEl = app;

let currentState: ExtensionUiState | null = null;
let busyAction: string | null = null;
let formDirty = false;
let loadedInitialConfig = false;
let tokenVisible = false;
let validationErrors: FieldErrors = {};
let notice: { kind: "info" | "error"; message: string } | null = null;

appEl.innerHTML = `
  <header class="page-header">
    <div>
      <span class="eyebrow">GSV Browser Target</span>
      <h1>GSV</h1>
      <p>Share this browser with GSV as a Unix-shaped target.</p>
    </div>
    <div class="status" data-connection-status>
      <span>Loading</span>
    </div>
  </header>

  <div class="settings-layout">
    <form class="panel connection-panel" novalidate>
      <header class="section-header">
        <div>
          <span class="eyebrow">Connection</span>
          <h2>Connect this browser</h2>
        </div>
      </header>

      <div class="form-grid">
        <label class="field" data-field="gatewayUrl">
          <span>Gateway WebSocket URL</span>
          <input name="gatewayUrl" type="text" placeholder="gsv.example.com or localhost:8787" autocomplete="off">
          <small data-error-for="gatewayUrl"></small>
        </label>

        <label class="field" data-field="username">
          <span>Username</span>
          <input name="username" type="text" autocomplete="username">
          <small data-error-for="username"></small>
        </label>

        <label class="field" data-field="token">
          <span>Driver token</span>
          <span class="input-action">
            <input name="token" type="password" autocomplete="off">
            <button type="button" data-action="toggle-token">Show</button>
          </span>
          <small data-error-for="token"></small>
        </label>

        <label class="field" data-field="deviceId">
          <span>Device id</span>
          <span class="input-action">
            <input name="deviceId" type="text" placeholder="rearden:brave" autocomplete="off">
            <button type="button" data-action="generate-device-id">Generate</button>
            <button type="button" data-action="copy-device-id">Copy</button>
          </span>
          <small data-error-for="deviceId"></small>
        </label>

        <label class="check-row">
          <input name="autoConnect" type="checkbox">
          <span>Auto-connect when Chrome starts</span>
        </label>
      </div>

      <div class="actions">
        <button type="submit" class="primary">Save</button>
        <button type="button" data-action="connect">Connect</button>
        <button type="button" class="danger" data-action="stop-all">Stop All</button>
      </div>
    </form>

    <aside class="panel status-panel">
      <header class="section-header">
        <div>
          <span class="eyebrow">Current state</span>
          <h2>Status</h2>
        </div>
      </header>
      <div class="state-summary" data-state-summary>Loading...</div>
      <dl class="detail-list" data-runtime-details></dl>
      <div class="actions compact-actions">
        <button type="button" data-action="open-monitor">Monitor</button>
        <button type="button" data-action="disconnect">Disconnect</button>
      </div>
    </aside>

    <details class="panel advanced-panel">
      <summary>Advanced</summary>
      <div class="advanced-body">
        <section>
          <span class="eyebrow">Diagnostics</span>
          <dl class="detail-list" data-diagnostics></dl>
        </section>
        <div class="header-actions">
          <button type="button" data-action="refresh">Refresh</button>
          <button type="button" data-action="copy-diagnostics">Copy</button>
          <button type="button" class="danger" data-action="clear-diagnostics">Clear</button>
        </div>
      </div>
    </details>

    <div class="notice" data-notice hidden></div>
  </div>
`;

const form = appEl.querySelector<HTMLFormElement>("form");
const connectionStatus = appEl.querySelector<HTMLElement>("[data-connection-status]");
const stateSummary = appEl.querySelector<HTMLElement>("[data-state-summary]");
const runtimeDetails = appEl.querySelector<HTMLElement>("[data-runtime-details]");
const diagnosticsDetails = appEl.querySelector<HTMLElement>("[data-diagnostics]");
const noticeEl = appEl.querySelector<HTMLElement>("[data-notice]");

if (!form || !connectionStatus || !stateSummary || !runtimeDetails || !diagnosticsDetails || !noticeEl) {
  throw new Error("Options markup is incomplete");
}

const formEl = form;
const connectionStatusEl = connectionStatus;
const stateSummaryEl = stateSummary;
const runtimeDetailsEl = runtimeDetails;
const diagnosticsDetailsEl = diagnosticsDetails;
const noticeNode = noticeEl;

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveConfigFromForm();
});

formEl.addEventListener("input", () => {
  formDirty = true;
  validationErrors = validateConfig(getFormConfig());
  renderValidation();
});

formEl.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.name === "gatewayUrl") {
    const normalized = normalizeGatewayUrl(target.value);
    if (normalized) {
      target.value = normalized;
      formDirty = true;
      validationErrors = validateConfig(getFormConfig());
      renderValidation();
    }
  }
});

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

void refresh({ applyConfig: true });
setInterval(() => {
  void refresh({ silent: true });
}, 3_000);

async function runAction(action: string): Promise<void> {
  switch (action) {
    case "connect":
      await saveConfigFromForm({ connect: true });
      return;
    case "disconnect":
      await sendRuntimeAction("disconnect", () => sendUiMessage({ type: "disconnect" }));
      return;
    case "stop-all":
      await sendRuntimeAction("stop-all", () => sendUiMessage({ type: "stop-all" }));
      return;
    case "open-monitor":
      await sendRuntimeAction("open-monitor", openMonitor);
      return;
    case "refresh":
      await refresh({ applyConfig: !formDirty });
      setNotice("info", "Refreshed");
      return;
    case "clear-diagnostics":
      await clearDiagnostics();
      return;
    case "copy-diagnostics":
      await copyDiagnostics();
      return;
    case "toggle-token":
      toggleTokenVisibility();
      return;
    case "generate-device-id":
      await generateDeviceId();
      formDirty = true;
      validationErrors = validateConfig(getFormConfig());
      renderValidation();
      return;
    case "copy-device-id":
      await copyText(getInput("deviceId"), "Copied device id");
      return;
    default:
      setNotice("error", `Unknown action: ${action}`);
  }
}

async function saveConfigFromForm(options: { connect?: boolean } = {}): Promise<void> {
  const config = getFormConfig();
  validationErrors = validateConfig(config);
  renderValidation();
  if (Object.keys(validationErrors).length > 0) {
    setNotice("error", "Fix the highlighted settings before saving.");
    return;
  }

  await withBusy(options.connect ? "connect" : "save", async () => {
    let response = await sendUiMessage({ type: "save-config", config });
    handleResponse(response, { applyConfig: true });
    if (!response.ok) {
      return;
    }
    formDirty = false;
    setNotice("info", options.connect ? "Saved settings" : "Saved settings");

    if (options.connect) {
      if (response.state.connection.state === "connected" || response.state.connection.state === "connecting") {
        setNotice("info", response.state.connection.state === "connected" ? "Connected" : "Connecting");
        return;
      }
      response = await sendUiMessage({ type: "connect" });
      handleResponse(response);
      setNotice(response.ok ? "info" : "error", response.ok ? "Connected" : response.error);
    }
  });
}

async function sendRuntimeAction(
  action: string,
  run: () => Promise<RuntimeResponse>,
): Promise<void> {
  await withBusy(action, async () => {
    const response = await run();
    handleResponse(response);
    setNotice(response.ok ? "info" : "error", response.ok ? actionLabel(action) : response.error);
  });
}

async function refresh(options: { applyConfig?: boolean; silent?: boolean } = {}): Promise<void> {
  try {
    const response = await sendUiMessage({ type: "status" });
    handleResponse(response, { applyConfig: options.applyConfig });
  } catch (error) {
    if (!options.silent) {
      setNotice("error", errorMessage(error));
    }
  }
}

async function openMonitor(): Promise<RuntimeResponse> {
  const currentWindow = await chrome.windows.getCurrent();
  return await sendUiMessage({ type: "open-side-panel", windowId: currentWindow.id });
}

async function clearDiagnostics(): Promise<void> {
  if (!confirm("Clear local activity, diagnostics, and artifact history for this browser target?")) {
    return;
  }
  await withBusy("clear-diagnostics", async () => {
    const response = await sendUiMessage({ type: "clear-diagnostics" });
    handleResponse(response);
    setNotice(response.ok ? "info" : "error", response.ok ? "Cleared diagnostics" : response.error);
  });
}

async function copyDiagnostics(): Promise<void> {
  if (!currentState) {
    await refresh({ silent: true });
  }
  if (!currentState) {
    setNotice("error", "Diagnostics are not loaded yet.");
    return;
  }
  const { config: _config, ...state } = currentState;
  await copyText(JSON.stringify(state, null, 2), "Copied diagnostics");
}

async function withBusy(action: string, run: () => Promise<void>): Promise<void> {
  busyAction = action;
  renderBusyState();
  try {
    await run();
  } catch (error) {
    setNotice("error", errorMessage(error));
  } finally {
    busyAction = null;
    renderBusyState();
  }
}

function handleResponse(
  response: RuntimeResponse,
  options: { applyConfig?: boolean } = {},
): void {
  if (response.ok) {
    currentState = response.state;
  } else {
    currentState = response.state ?? currentState;
    setNotice("error", response.error);
  }

  if (currentState && (options.applyConfig || !loadedInitialConfig)) {
    setFormConfig(currentState.config);
    validationErrors = validateConfig(currentState.config);
    renderValidation();
    loadedInitialConfig = true;
    formDirty = false;
  }

  renderState();
}

function renderState(): void {
  const state = currentState;
  renderBusyState();
  renderNotice();
  if (!state) {
    connectionStatusEl.className = "status";
    connectionStatusEl.innerHTML = `<span class="dot"></span><span>Loading</span>`;
    stateSummaryEl.textContent = "Loading...";
    runtimeDetailsEl.innerHTML = "";
    diagnosticsDetailsEl.innerHTML = "";
    return;
  }

  connectionStatusEl.className = `status status--${escapeHtml(state.connection.state)}`;
  connectionStatusEl.innerHTML = `
    <span>${escapeHtml(connectionText(state))}</span>
  `;
  stateSummaryEl.innerHTML = `
    <strong>${escapeHtml(stateHeadline(state))}</strong>
    <span title="${escapeHtml(state.connection.message ?? state.config.gatewayUrl)}">${escapeHtml(stateSummaryDetail(state))}</span>
  `;
  runtimeDetailsEl.innerHTML = [
    detailRow("Target id", state.targetId),
    detailRow("Gateway", state.gatewayHost),
    detailRow("Live access", liveAccessText(state)),
    detailRow("Auto-connect", state.config.autoConnect ? "On" : "Off"),
  ].join("");
  diagnosticsDetailsEl.innerHTML = [
    detailRow("Connection id", state.connection.connectionId ?? "-"),
    detailRow("Message", state.connection.message ?? "-"),
    detailRow("Last connect attempt", formatTimestamp(state.diagnostics.lastConnectAttemptAt)),
    detailRow("Last connected", formatTimestamp(state.diagnostics.lastConnectedAt)),
    detailRow("Last disconnected", formatTimestamp(state.diagnostics.lastDisconnectedAt)),
    detailRow("Last connection id", state.diagnostics.lastSuccessfulConnectionId ?? "-"),
    detailRow("Last connection error", state.diagnostics.lastConnectionError ?? "-"),
    detailRow("Last error", state.diagnostics.lastError ?? "-"),
    detailRow("Activity entries", String(state.diagnostics.activityCount)),
    detailRow("Artifact paths", String(state.diagnostics.artifactPathCount)),
  ].join("");
}

function renderBusyState(): void {
  const disabled = Boolean(busyAction);
  const submit = formEl.querySelector<HTMLButtonElement>("button[type='submit']");
  if (submit) {
    submit.disabled = disabled;
    submit.textContent = busyAction === "save" ? "Saving" : "Save";
  }
  for (const button of Array.from(appEl.querySelectorAll<HTMLButtonElement>("button[data-action]"))) {
    const action = button.dataset.action ?? "";
    const keepEnabled = action === "toggle-token" || action === "generate-device-id" || action === "copy-device-id";
    button.disabled = disabled && !keepEnabled;
    if (action === "toggle-token") {
      button.textContent = tokenVisible ? "Hide" : "Show";
    } else if (busyAction === action) {
      button.dataset.busy = "true";
    } else {
      delete button.dataset.busy;
    }
  }
}

function renderValidation(): void {
  for (const field of ["gatewayUrl", "username", "token", "deviceId"] satisfies ConfigField[]) {
    const message = validationErrors[field] ?? "";
    const fieldEl = appEl.querySelector<HTMLElement>(`[data-field="${field}"]`);
    const errorEl = appEl.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
    const input = formEl.elements.namedItem(field);
    fieldEl?.classList.toggle("field--invalid", Boolean(message));
    if (errorEl) {
      errorEl.textContent = message;
    }
    if (input instanceof HTMLInputElement) {
      input.setCustomValidity(message);
      input.toggleAttribute("aria-invalid", Boolean(message));
    }
  }
}

function renderNotice(): void {
  if (!notice) {
    noticeNode.hidden = true;
    noticeNode.textContent = "";
    noticeNode.className = "notice";
    return;
  }
  noticeNode.hidden = false;
  noticeNode.textContent = notice.message;
  noticeNode.className = `notice notice--${notice.kind}`;
}

function setNotice(kind: "info" | "error", message: string): void {
  notice = { kind, message };
  renderNotice();
}

function setFormConfig(config: ExtensionConfig): void {
  setInput("gatewayUrl", config.gatewayUrl);
  setInput("username", config.username);
  setInput("token", config.token);
  setInput("deviceId", config.deviceId);
  const autoConnect = formEl.elements.namedItem("autoConnect");
  if (autoConnect instanceof HTMLInputElement) {
    autoConnect.checked = config.autoConnect;
  }
}

function getFormConfig(): ExtensionConfig {
  return {
    gatewayUrl: getInput("gatewayUrl"),
    username: getInput("username"),
    token: getInput("token"),
    deviceId: getInput("deviceId"),
    autoConnect: getCheckbox("autoConnect"),
  };
}

function validateConfig(config: ExtensionConfig): FieldErrors {
  const errors: FieldErrors = {};
  if (!normalizeGatewayUrl(config.gatewayUrl)) {
    errors.gatewayUrl = "Enter a valid host, origin, or WebSocket URL.";
  }
  if (!config.username) {
    errors.username = "Username is required.";
  }
  if (!config.token) {
    errors.token = "Driver token is required.";
  }
  if (!config.deviceId) {
    errors.deviceId = "Device id is required.";
  } else if (/\s/.test(config.deviceId)) {
    errors.deviceId = "Device id cannot contain spaces.";
  }
  return errors;
}

function toggleTokenVisibility(): void {
  tokenVisible = !tokenVisible;
  const input = formEl.elements.namedItem("token");
  if (input instanceof HTMLInputElement) {
    input.type = tokenVisible ? "text" : "password";
  }
  renderBusyState();
}

function getInput(name: string): string {
  const input = formEl.elements.namedItem(name);
  return input instanceof HTMLInputElement ? input.value.trim() : "";
}

function setInput(name: string, value: string): void {
  const input = formEl.elements.namedItem(name);
  if (input instanceof HTMLInputElement) {
    input.value = value;
  }
}

function getCheckbox(name: string): boolean {
  const input = formEl.elements.namedItem(name);
  return input instanceof HTMLInputElement ? input.checked : false;
}

async function generateDeviceId(): Promise<void> {
  const browserName = await detectBrowserName();
  const currentHost = hostLabelFromDeviceId(getInput("deviceId"));
  const fallbackHost = currentHost ?? await fallbackHostLabel();
  const enteredHost = prompt("Computer name for this browser target", fallbackHost);
  if (enteredHost === null) {
    return;
  }
  const host = slugDevicePart(enteredHost) || fallbackHost;
  setInput("deviceId", `${host}:${browserName}`);
  setNotice("info", "Generated device id");
}

async function copyText(text: string, successMessage: string): Promise<void> {
  if (!text) {
    setNotice("error", "Nothing to copy.");
    return;
  }
  await navigator.clipboard.writeText(text);
  setNotice("info", successMessage);
}

function stateHeadline(state: ExtensionUiState): string {
  if (state.connection.state === "connected") {
    return "Ready for agent requests";
  }
  if (state.connection.state === "connecting") {
    return "Connecting to GSV";
  }
  return "Disconnected";
}

function stateSummaryDetail(state: ExtensionUiState): string {
  if (state.connection.message) {
    return state.connection.message;
  }
  if (state.connection.connectionId) {
    return state.connection.connectionId;
  }
  return `${state.targetId} at ${state.gatewayHost}`;
}

function detailRow(label: string, value: string): string {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd>
    </div>
  `;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) {
    return "-";
  }
  return `${timeAgo(iso)} · ${new Date(iso).toLocaleString()}`;
}

function actionLabel(action: string): string {
  switch (action) {
    case "disconnect":
      return "Disconnected";
    case "open-monitor":
      return "Opened monitor";
    case "stop-all":
      return "Stopped browser access";
    default:
      return "Done";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function detectBrowserName(): Promise<string> {
  const nav = navigator as Navigator & {
    brave?: { isBrave?: () => Promise<boolean> };
    userAgentData?: { brands?: Array<{ brand: string }> };
  };
  if (await nav.brave?.isBrave?.().catch(() => false)) {
    return "brave";
  }

  const ua = navigator.userAgent;
  if (/\bEdg\//.test(ua)) {
    return "edge";
  }
  if (/\bOPR\//.test(ua)) {
    return "opera";
  }
  if (/\bFirefox\//.test(ua)) {
    return "firefox";
  }
  if (/\bChrome\//.test(ua)) {
    return "chrome";
  }
  if (/\bSafari\//.test(ua)) {
    return "safari";
  }

  const brand = nav.userAgentData?.brands?.map((item) => item.brand.toLowerCase()).find((item) => {
    return item.includes("chrome") || item.includes("chromium") || item.includes("edge") || item.includes("opera");
  });
  if (brand?.includes("edge")) {
    return "edge";
  }
  if (brand?.includes("opera")) {
    return "opera";
  }
  if (brand?.includes("chrome") || brand?.includes("chromium")) {
    return "chrome";
  }
  return "browser";
}

async function fallbackHostLabel(): Promise<string> {
  const platform = await chrome.runtime.getPlatformInfo().catch(() => null);
  return slugDevicePart(platform?.os ?? navigator.platform) || "browser";
}

function hostLabelFromDeviceId(deviceId: string): string | null {
  const [host, browser] = deviceId.split(":");
  const normalized = slugDevicePart(host);
  if (!normalized || normalized === "browser" || normalized === slugDevicePart(browser)) {
    return null;
  }
  return normalized;
}

function slugDevicePart(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function liveAccessText(state: ExtensionUiState): string {
  const parts: string[] = [];
  if (state.sensitive.networkCaptures > 0) {
    parts.push(`${state.sensitive.networkCaptures} network`);
  }
  if (state.sensitive.debuggerTabs.length > 0) {
    parts.push(`${state.sensitive.debuggerTabs.length} debugger`);
  }
  return parts.length > 0 ? parts.join(" / ") : "None";
}
