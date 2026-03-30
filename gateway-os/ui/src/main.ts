import "./styles.css";
import { createAppRuntime } from "./apps-runtime";
import { APP_REGISTRY } from "./apps";
import { createGatewayClient } from "./gateway-client";
import type { AppManifest } from "./app-sdk";
import { createLauncher } from "./launcher";
import { connectEmbeddedHostClient } from "./host-bridge";
import { packageToAppManifests } from "./package-apps";
import { createSessionService } from "./session-service";
import { createSessionUi } from "./session-ui";
import { renderDesktopShell } from "./shell-template";
import { createThemeService } from "./theme-service";
import { createWindowManager } from "./window-manager";
import { createWindowsPanel } from "./windows-panel";
import type { PkgListResult } from "../../src/syscalls/packages";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app mount");
}

const themeService = createThemeService();
const embeddedAppId = new URL(window.location.href).searchParams.get("embeddedApp")?.trim() ?? "";

app.innerHTML = renderDesktopShell(themeService.initialTheme);

const shellEl = app.querySelector<HTMLElement>(".desktop-shell");
const windowsLayerEl = app.querySelector<HTMLElement>("[data-windows-layer]");

if (!shellEl || !windowsLayerEl) {
  throw new Error("Shell markup is incomplete");
}

themeService.bind({
  shellNode: shellEl,
});

if (embeddedAppId) {
  shellEl.dataset.embeddedApp = embeddedAppId;
  const desktopIconsEl = shellEl.querySelector<HTMLElement>("[data-desktop-icons]");
  const windowsToggleEl = shellEl.querySelector<HTMLElement>(".topbar-windows");
  const topbarEl = shellEl.querySelector<HTMLElement>(".topbar");
  const workspaceEl = shellEl.querySelector<HTMLElement>(".workspace");
  if (desktopIconsEl) {
    desktopIconsEl.hidden = true;
  }
  if (windowsToggleEl) {
    windowsToggleEl.hidden = true;
  }
  if (topbarEl) {
    topbarEl.hidden = true;
    topbarEl.style.display = "none";
  }
  const sessionOverlayEl = shellEl.querySelector<HTMLElement>("[data-session-overlay]");
  const sessionSectionEl = shellEl.querySelector<HTMLElement>(".topbar-session");
  if (sessionOverlayEl) {
    sessionOverlayEl.hidden = true;
  }
  if (sessionSectionEl) {
    sessionSectionEl.hidden = true;
  }
  if (workspaceEl) {
    workspaceEl.style.inset = "0";
  }

  const embeddedManifest = APP_REGISTRY.find((candidate) => {
    return candidate.id === embeddedAppId && candidate.entrypoint.kind === "component";
  });

  if (embeddedManifest) {
    windowsLayerEl.replaceChildren();
    windowsLayerEl.style.position = "relative";
    windowsLayerEl.style.inset = "0";
    windowsLayerEl.style.height = "100%";
    windowsLayerEl.style.minHeight = "0";
    windowsLayerEl.style.pointerEvents = "auto";

    const host = document.createElement("div");
    host.style.width = "100%";
    host.style.height = "100%";
    host.style.minHeight = "100%";
    host.style.overflow = "hidden";
    host.style.pointerEvents = "auto";
    windowsLayerEl.append(host);
    void mountEmbeddedApp(host, embeddedManifest);
  } else {
    windowsLayerEl.innerHTML = `<section class="session-card"><p class="eyebrow">Unknown app</p><h1>${embeddedAppId}</h1><p class="muted">This embedded app is not registered in the legacy UI bundle.</p></section>`;
  }
} else {
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

  createSessionUi({
    rootNode: shellEl,
    session: sessionService,
  });

  void sessionService.start();
}

async function mountEmbeddedApp(host: HTMLElement, manifest: AppManifest): Promise<void> {
  try {
    const hostClient = await connectEmbeddedHostClient();
    const appRuntime = createAppRuntime(hostClient);
    const instance = appRuntime.createInstance(manifest);
    await instance.mount(host, {
      windowId: `embedded:${manifest.id}`,
      manifest,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.innerHTML = `<section class="session-card"><p class="eyebrow">HOST bridge</p><h1>App failed to start</h1><p class="muted">${message}</p></section>`;
  }
}
