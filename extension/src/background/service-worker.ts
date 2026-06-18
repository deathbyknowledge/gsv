import { GSVClient } from "@humansandmachines/gsv/client";
import { configReady, loadConfig, saveConfig, type ExtensionConfig } from "../shared/config";
import {
  clearDiagnostics as clearStoredDiagnostics,
  emptyDiagnostics,
  loadDiagnostics,
  mergeDiagnostics,
  recordDiagnosticActivity,
  recordDiagnosticArtifactPaths,
  saveDiagnostics,
  type ExtensionDiagnostics,
} from "../shared/diagnostics";
import { debuggerTabs, releaseAllDebuggers } from "../shared/debugger";
import type { ActivityEntry, ExtensionUiState, RuntimeMessage, RuntimeResponse } from "../shared/ui-state";
import { networkStatus, stopNetworkCapture } from "../target/network-recorder";
import { createBrowserTargetDriver, type BrowserTargetActivity } from "./driver";

const client = new GSVClient();
const driver = client.driver({
  platform: "browser-extension",
  version: "0.2.6",
  keepalive: { intervalMs: 25_000 },
});
let diagnostics: ExtensionDiagnostics = emptyDiagnostics();
const diagnosticsReady = loadDiagnostics().then((stored) => {
  diagnostics = mergeDiagnostics(stored, diagnostics);
}).catch((error) => {
  console.warn("GSV browser target diagnostics unavailable", error);
});
let diagnosticsWrite: Promise<void> = Promise.resolve();
let lastConnectionStatus = "";
let connectPromise: Promise<void> | null = null;
let manualReconnectSuppressed = false;

const browserTarget = createBrowserTargetDriver(addActivity);
driver.implement("shell.exec", browserTarget.handle);
driver.implement("fs.*", browserTarget.handle);
client.onStatus((status) => {
  const key = `${status.state}:${status.connectionId ?? ""}:${status.message ?? ""}`;
  if (key === lastConnectionStatus) {
    return;
  }
  lastConnectionStatus = key;
  const detail = status.state === "connected"
    ? status.connectionId ?? status.message ?? "gateway"
    : status.message ?? status.connectionId ?? "gateway";
  addActivity({
    kind: "connection",
    label: status.state,
    detail,
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
        manualReconnectSuppressed = false;
        await connectNow();
        return await stateResponse();
      case "disconnect":
        manualReconnectSuppressed = true;
        driver.disconnect();
        return await stateResponse();
      case "stop-all":
        return await stopAll();
      case "clear-diagnostics":
        return await clearDiagnosticsState();
      case "save-config": {
        const config = await saveConfig(message.config);
        addActivity({
          kind: "connection",
          label: "config saved",
          detail: `${config.deviceId} (${gatewayHost(config.gatewayUrl)})`,
          status: "info",
        });
        manualReconnectSuppressed = false;
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
    const connectionRequest = message.type === "connect" || message.type === "save-config";
    addActivity({
      kind: connectionRequest ? "connection" : "error",
      label: connectionRequest ? "connect failed" : "runtime",
      detail: messageText,
      status: "error",
    });
    return { ok: false, error: messageText, state: await buildUiState() };
  }
}

async function maybeConnect(): Promise<void> {
  const config = await loadConfig();
  if (
    manualReconnectSuppressed
    || !config.autoConnect
    || !configReady(config)
    || client.getStatus().state !== "disconnected"
  ) {
    return;
  }
  await connectNow(config).catch(() => {});
}

async function connectNow(config?: ExtensionConfig): Promise<void> {
  config = config ?? await loadConfig();
  if (!configReady(config)) {
    throw new Error("Configure gateway URL, username, token, and device id first");
  }
  if (!connectPromise) {
    connectPromise = driver.connect({
      url: config.gatewayUrl,
      username: config.username,
      token: config.token,
      deviceId: config.deviceId,
    }).then(() => undefined).finally(() => {
      connectPromise = null;
    });
  }
  await connectPromise;
}

async function stopAll(): Promise<RuntimeResponse> {
  const stoppedCaptures = await stopNetworkCapture();
  const detachedTabs = await releaseAllDebuggers();
  manualReconnectSuppressed = true;
  driver.disconnect("stop all");
  addActivity({
    kind: "sensitive",
    label: "stop all",
    detail: `stopped ${stoppedCaptures.length} network capture(s), detached ${detachedTabs.length} debugger tab(s)`,
    status: "info",
  });
  return await stateResponse();
}

async function clearDiagnosticsState(): Promise<RuntimeResponse> {
  await diagnosticsReady;
  diagnostics = emptyDiagnostics();
  await clearStoredDiagnostics();
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
  await diagnosticsReady;
  const config = await loadConfig();
  const status = client.getStatus();
  const connection = {
    state: status.state,
    connectionId: status.connectionId,
    message: status.message,
  };
  const captures = networkStatus();
  const tabs = debuggerTabs();
  const activity = diagnostics.activity;
  const artifactPaths = diagnostics.artifactPaths;
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
      screenshots: artifactPaths.filter((path) => path.startsWith("/home/browser/screenshots/")).length,
      networkSessions: captures.filter((capture) => Boolean(capture.sessionPath)).length
        + artifactPaths.filter((path) => path.startsWith("/home/browser/network/sessions/")).length,
      files: artifactPaths.length,
    },
    diagnostics: {
      lastConnectAttemptAt: diagnostics.lastConnectAttemptAt,
      lastConnectedAt: diagnostics.lastConnectedAt,
      lastDisconnectedAt: diagnostics.lastDisconnectedAt,
      lastSuccessfulConnectionId: diagnostics.lastSuccessfulConnectionId,
      lastConnectionErrorAt: diagnostics.lastConnectionErrorAt,
      lastConnectionError: diagnostics.lastConnectionError,
      lastErrorAt: diagnostics.lastErrorAt,
      lastError: diagnostics.lastError,
      activityCount: diagnostics.activity.length,
      artifactPathCount: diagnostics.artifactPaths.length,
      updatedAt: diagnostics.updatedAt,
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
  diagnostics = recordDiagnosticActivity(diagnostics, entry);
  diagnostics = recordDiagnosticArtifactPaths(diagnostics, artifactPathsFromDetail(entry.detail));
  queueDiagnosticsSave();
}

function artifactPathsFromDetail(detail: string): string[] {
  const paths: string[] = [];
  for (const match of detail.matchAll(/\/(?:home\/browser|tmp)\/[^\s"',}]+/g)) {
    paths.push(match[0].replace(/[),.;:]+$/, ""));
  }
  return paths;
}

function queueDiagnosticsSave(): void {
  diagnosticsWrite = diagnosticsWrite
    .catch(() => undefined)
    .then(async () => {
      await diagnosticsReady;
      await saveDiagnostics(diagnostics);
    })
    .catch((error) => {
      console.warn("GSV browser target diagnostics save failed", error);
    });
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
