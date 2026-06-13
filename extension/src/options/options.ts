import "./options.css";
import type { ExtensionConfig } from "../shared/config";

type StatusResponse = {
  ok: boolean;
  config?: ExtensionConfig;
  status?: {
    state: string;
    connectionId: string | null;
    message: string | null;
  };
  error?: string;
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("Missing #app");
}

app.innerHTML = `
  <h1>GSV Browser Target</h1>
  <p>Expose this browser profile to GSV as a Unix-looking target.</p>
  <form>
    <label>
      Gateway WebSocket URL
      <input name="gatewayUrl" type="url" placeholder="ws://localhost:8787/ws">
    </label>
    <label>
      Username
      <input name="username" type="text" autocomplete="username">
    </label>
    <label>
      Driver token
      <input name="token" type="password" autocomplete="off">
    </label>
    <label>
      Device id
      <input name="deviceId" type="text" placeholder="browser:chrome">
    </label>
    <label class="row">
      <input name="autoConnect" type="checkbox">
      Auto-connect when Chrome starts
    </label>
    <div class="actions">
      <button type="submit">Save</button>
      <button class="secondary" type="button" data-action="connect">Connect</button>
      <button class="secondary" type="button" data-action="disconnect">Disconnect</button>
      <button class="secondary" type="button" data-action="refresh">Refresh</button>
    </div>
  </form>
  <div class="status" data-status>Loading...</div>
`;

const form = app.querySelector<HTMLFormElement>("form");
const statusNode = app.querySelector<HTMLElement>("[data-status]");
if (!form || !statusNode) {
  throw new Error("Options markup is incomplete");
}
const formEl = form;
const statusEl = statusNode;

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});

app.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const action = target.dataset.action;
  if (action === "connect") {
    void send("connect");
  } else if (action === "disconnect") {
    void send("disconnect");
  } else if (action === "refresh") {
    void refresh();
  }
});

void refresh();

async function refresh(): Promise<void> {
  const response = await sendMessage<StatusResponse>({ type: "status" });
  if (!response.ok) {
    renderStatus(response);
    return;
  }
  if (response.config) {
    setFormConfig(response.config);
  }
  renderStatus(response);
}

async function save(): Promise<void> {
  const config = getFormConfig();
  const response = await sendMessage<StatusResponse>({ type: "save-config", config });
  if (response.config) {
    setFormConfig(response.config);
  }
  renderStatus(response);
}

async function send(type: "connect" | "disconnect"): Promise<void> {
  const response = await sendMessage<StatusResponse>({ type });
  renderStatus(response);
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

function renderStatus(response: StatusResponse): void {
  statusEl.textContent = response.ok
    ? [
        `state: ${response.status?.state ?? "unknown"}`,
        `connection: ${response.status?.connectionId ?? "-"}`,
        `message: ${response.status?.message ?? "-"}`,
      ].join("\n")
    : `error: ${response.error ?? "unknown error"}`;
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

async function sendMessage<T>(message: unknown): Promise<T> {
  return await chrome.runtime.sendMessage(message) as T;
}
