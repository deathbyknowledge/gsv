import "./styles.css";
import { APP_REGISTRY } from "./apps";
import { createAppRuntime } from "./apps-runtime";
import { createGatewayClient } from "./gateway-client";
import { createLauncher } from "./launcher";
import { createSessionService } from "./session-service";
import { createSessionUi } from "./session-ui";
import { renderDesktopShell } from "./shell-template";
import { createThemeService } from "./theme-service";
import { createWindowManager } from "./window-manager";
import { createWindowsPanel } from "./windows-panel";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app mount");
}

const themeService = createThemeService();
const gatewayClient = createGatewayClient();
const sessionService = createSessionService(gatewayClient);
const appRuntime = createAppRuntime(gatewayClient);
app.innerHTML = renderDesktopShell(themeService.initialTheme);

const shellEl = app.querySelector<HTMLElement>(".desktop-shell");
const themeSelectEl = app.querySelector<HTMLSelectElement>("#theme-picker");
const windowsLayerEl = app.querySelector<HTMLElement>("[data-windows-layer]");

if (!shellEl || !themeSelectEl || !windowsLayerEl) {
  throw new Error("Shell markup is incomplete");
}

themeService.bind({
  shellNode: shellEl,
  themeSelectNode: themeSelectEl,
});

const windowManager = createWindowManager({
  layerNode: windowsLayerEl,
  appRegistry: APP_REGISTRY,
  appRuntime,
});

createWindowsPanel({
  rootNode: shellEl,
  windowManager,
});

createLauncher({
  rootNode: shellEl,
  windowManager,
});

createSessionUi({
  rootNode: shellEl,
  session: sessionService,
});

void sessionService.start();
