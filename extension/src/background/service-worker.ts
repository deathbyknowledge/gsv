import { configReady, loadConfig, saveConfig, type ExtensionConfig } from "../shared/config";
import { createBrowserTargetDriver } from "./driver";
import { GatewayDriverClient } from "./gateway-client";

type RuntimeMessage =
  | { type: "status" }
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "save-config"; config: ExtensionConfig };

const client = new GatewayDriverClient();
const driver = createBrowserTargetDriver(client);
client.setRequestHandler(driver.handle);

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

async function handleRuntimeMessage(message: RuntimeMessage): Promise<unknown> {
  switch (message.type) {
    case "status":
      return { ok: true, config: await loadConfig(), status: client.getStatus() };
    case "connect":
      await connectNow();
      return { ok: true, status: client.getStatus() };
    case "disconnect":
      client.disconnect();
      return { ok: true, status: client.getStatus() };
    case "save-config": {
      const config = await saveConfig(message.config);
      if (config.autoConnect && configReady(config)) {
        await connectNow(config);
      }
      return { ok: true, config, status: client.getStatus() };
    }
    default:
      return { ok: false, error: "Unknown message" };
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
