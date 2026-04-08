import "./styles.css";
import { createAppRuntime } from "./apps-runtime";
import { createGatewayClient } from "./gateway-client";
import { createLauncher } from "./launcher";
import { packageToAppManifests } from "./package-apps";
import { createSessionService } from "./session-service";
import { createSessionUi } from "./session-ui";
import { renderDesktopShell } from "./shell-template";
import { createWindowManager } from "./window-manager";
import { createWindowsPanel } from "./windows-panel";
import type { PkgListResult } from "../../gateway/src/syscalls/packages";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app mount");
}

app.innerHTML = renderDesktopShell();

const shellEl = app.querySelector<HTMLElement>(".desktop-shell");
const windowsLayerEl = app.querySelector<HTMLElement>("[data-windows-layer]");

if (!shellEl || !windowsLayerEl) {
  throw new Error("Shell markup is incomplete");
}

const gatewayClient = createGatewayClient();
const sessionService = createSessionService(gatewayClient);
const appRuntime = createAppRuntime(gatewayClient);
const windowManager = createWindowManager({
  layerNode: windowsLayerEl,
  appRegistry: [],
  appRuntime,
});

createWindowsPanel({
  rootNode: shellEl,
  windowManager,
});

const launcher = createLauncher({
  rootNode: shellEl,
  windowManager,
});

async function refreshDesktopApps(): Promise<void> {
  if (!gatewayClient.isConnected()) {
    launcher.setApps([]);
    return;
  }

  try {
    const payload = await gatewayClient.request<PkgListResult>("pkg.list", {});
    const packages = Array.isArray(payload.packages) ? payload.packages : [];
    launcher.setApps(packages.flatMap(packageToAppManifests));
  } catch {
    launcher.setApps([]);
  }
}

gatewayClient.onStatus((status) => {
  if (status.state === "connected") {
    void refreshDesktopApps();
    return;
  }

  launcher.setApps([]);
});

gatewayClient.onSignal((signal) => {
  if (signal === "pkg.changed") {
    void refreshDesktopApps();
  }
});

createSessionUi({
  rootNode: shellEl,
  session: sessionService,
});

void sessionService.start();
