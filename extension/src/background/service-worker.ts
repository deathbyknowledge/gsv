import { configReady, loadConfig, saveConfig, type ExtensionConfig } from "../shared/config";
import { debuggerTabs, releaseAllDebuggers } from "../shared/debugger";
import type { ActivityEntry, ExtensionUiState, RuntimeMessage, RuntimeResponse } from "../shared/ui-state";
import { networkStatus, stopNetworkCapture } from "../target/network-recorder";
import { createBrowserTargetDriver, type BrowserTargetActivity } from "./driver";
import { GatewayDriverClient } from "./gateway-client";

const client = new GatewayDriverClient();
const activity: ActivityEntry[] = [];
const artifactPaths = new Set<string>();
let lastConnectionStatus = "";

const driver = createBrowserTargetDriver(client, addActivity);
client.setRequestHandler(driver.handle);
client.onStatus((status) => {
  const key = `${status.state}:${status.connectionId ?? ""}:${status.message ?? ""}`;
  if (key === lastConnectionStatus) {
    return;
  }
  lastConnectionStatus = key;
  addActivity({
    kind: "connection",
    label: status.state,
    detail: status.message ?? status.connectionId ?? "gateway",
    status: status.state === "connected" ? "ok" : status.state === "connecting" ? "active" : "info",
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void maybeConnect();
});

chrome.runtime.onStartup.addListener(() => {
  void maybeConnect();
});

chrome.alarms.create("gsv-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gsv-reconnect") {
    void maybeConnect();
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  void handleRuntimeMessage(message).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

void maybeConnect();

async function handleRuntimeMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  try {
    switch (message.type) {
      case "status":
        return await stateResponse();
      case "connect":
        await connectNow();
        return await stateResponse();
      case "disconnect":
        client.disconnect();
        return await stateResponse();
      case "stop-all":
        return await stopAll();
      case "save-config": {
        const config = await saveConfig(message.config);
        addActivity({
          kind: "connection",
          label: "config saved",
          detail: `${config.deviceId} (${gatewayHost(config.gatewayUrl)})`,
          status: "info",
        });
        if (config.autoConnect && configReady(config)) {
          await connectNow(config);
        }
        return await stateResponse();
      }
      case "open-side-panel":
        await openSidePanel(message.windowId);
        return await stateResponse();
      default:
        return { ok: false, error: "Unknown message", state: await buildUiState() };
    }
  } catch (error) {
    const messageText = errorMessage(error);
    addActivity({
      kind: "error",
      label: "runtime",
      detail: messageText,
      status: "error",
    });
    return { ok: false, error: messageText, state: await buildUiState() };
  }
}

async function maybeConnect(): Promise<void> {
  const config = await loadConfig();
  if (!config.autoConnect || !configReady(config) || client.getStatus().state === "connected") {
    return;
  }
  await connectNow(config).catch(() => {});
}

async function connectNow(config?: ExtensionConfig): Promise<void> {
  config = config ?? await loadConfig();
  if (!configReady(config)) {
    throw new Error("Configure gateway URL, username, token, and device id first");
  }
  await client.connect(config);
}

async function stopAll(): Promise<RuntimeResponse> {
  const stoppedCaptures = await stopNetworkCapture();
  const detachedTabs = await releaseAllDebuggers();
  client.disconnect("stop all");
  addActivity({
    kind: "sensitive",
    label: "stop all",
    detail: `stopped ${stoppedCaptures.length} network capture(s), detached ${detachedTabs.length} debugger tab(s)`,
    status: "info",
  });
  return await stateResponse();
}

async function openSidePanel(windowId?: number): Promise<void> {
  if (!chrome.sidePanel?.open) {
    throw new Error("chrome.sidePanel is unavailable; check the sidePanel permission.");
  }
  if (typeof windowId === "number") {
    await chrome.sidePanel.open({ windowId });
    return;
  }
  const currentWindow = await chrome.windows.getCurrent();
  if (typeof currentWindow.id !== "number") {
    throw new Error("Unable to resolve current browser window");
  }
  await chrome.sidePanel.open({ windowId: currentWindow.id });
}

async function stateResponse(): Promise<RuntimeResponse> {
  return { ok: true, state: await buildUiState() };
}

async function buildUiState(): Promise<ExtensionUiState> {
  const config = await loadConfig();
  const connection = client.getStatus();
  const captures = networkStatus();
  const tabs = debuggerTabs();
  const sensitiveActivity = activity.find((entry) => entry.kind === "sensitive" || entry.kind === "network");

  return {
    config,
    connection,
    targetId: config.deviceId,
    gatewayHost: gatewayHost(config.gatewayUrl),
    activity: activity.slice(0, 80),
    sensitive: {
      connected: connection.state === "connected",
      networkCaptures: captures.length,
      debuggerTabs: tabs,
      lastSensitiveAt: sensitiveActivity?.at ?? null,
    },
    network: {
      captures,
    },
    artifact: {
      screenshots: Array.from(artifactPaths).filter((path) => path.startsWith("/home/browser/screenshots/")).length,
      networkSessions: captures.filter((capture) => Boolean(capture.sessionPath)).length
        + Array.from(artifactPaths).filter((path) => path.startsWith("/home/browser/network/sessions/")).length,
      files: artifactPaths.size,
    },
    updatedAt: new Date().toISOString(),
  };
}

function addActivity(input: BrowserTargetActivity): void {
  const entry: ActivityEntry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...input,
  };
  activity.unshift(entry);
  if (activity.length > 80) {
    activity.splice(80);
  }
  recordArtifactPaths(entry.detail);
}

function recordArtifactPaths(detail: string): void {
  for (const match of detail.matchAll(/\/(?:home\/browser|tmp)\/[^\s"',}]+/g)) {
    artifactPaths.add(match[0].replace(/[),.;:]+$/, ""));
  }
}

function gatewayHost(gatewayUrl: string): string {
  try {
    const url = new URL(gatewayUrl);
    return url.host || gatewayUrl;
  } catch {
    return gatewayUrl || "-";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
