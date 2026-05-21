import "./styles.css";
import { createAppRuntime } from "./apps-runtime";
import { createBrowserTargetProvider } from "./browser-target";
import { createGatewayClient } from "./gateway-client";
import { createLauncher } from "./launcher";
import { createNotificationsPanel } from "./notifications-panel";
import { packageToAppManifests } from "./package-apps";
import { createPresenceControl } from "./presence";
import { createSessionService } from "./session-service";
import { createSessionUi } from "./session-ui";
import { renderDesktopShell } from "./shell-template";
import { createWindowManager } from "./window-manager";
import type { PkgListResult } from "@gsv/protocol/syscalls/packages";

type StandaloneNavigator = Navigator & {
  standalone?: boolean;
};

function isStandaloneDisplay(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || (navigator as StandaloneNavigator).standalone === true;
}

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

const standalone = isStandaloneDisplay();
document.documentElement.classList.toggle("is-standalone", standalone);
shellEl.classList.toggle("is-standalone", standalone);

const gatewayClient = createGatewayClient();
const sessionService = createSessionService(gatewayClient);
const appRuntime = createAppRuntime(gatewayClient);
const windowManager = createWindowManager({
  layerNode: windowsLayerEl,
  appRegistry: [],
  appRuntime,
});

createBrowserTargetProvider({
  gatewayClient,
  windowManager,
});

createNotificationsPanel({
  rootNode: shellEl,
  gatewayClient,
});

createPresenceControl({
  rootNode: shellEl,
  gatewayClient,
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
    const payload = await gatewayClient.call<PkgListResult>("pkg.list", {});
    const packages = Array.isArray(payload.packages) ? payload.packages : [];
    const apps = packages.flatMap(packageToAppManifests);
    windowManager.setAppRegistry(apps);
    launcher.setApps(apps);
  } catch {
    windowManager.setAppRegistry([]);
    launcher.setApps([]);
  }
}

gatewayClient.onStatus((status) => {
  if (status.state === "connected") {
    void refreshDesktopApps();
    return;
  }

  launcher.setApps([]);
  windowManager.setAppRegistry([]);
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
