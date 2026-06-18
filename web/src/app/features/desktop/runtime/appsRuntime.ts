import type { GSVClient } from "@humansandmachines/gsv/client";
import type { AppLaunchResult, AppOpenArgs } from "@humansandmachines/gsv/protocol";
import type { DesktopApp } from "../domain/desktopApp";
import { createAppLaunchLoader, type AppLaunchLoader } from "./appLoading";
import type { AppInstance, AppRuntimeRegistry } from "./appRuntime";
import { attachHostBridge } from "./host/hostBridge";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function createUnsupportedAppInstance(app: DesktopApp): AppInstance {
  return {
    mount: (container) => {
      container.innerHTML = `
        <section class="app-grid">
          <p class="eyebrow">Unsupported runtime</p>
          <h1>${escapeHtml(app.name)}</h1>
          <p>${escapeHtml(app.description)}</p>
          <div class="app-tag-row">
            <span class="app-tag">route ${escapeHtml(app.routeBase)}</span>
            <span class="app-tag">kind ${escapeHtml(app.launch.kind)}</span>
          </div>
        </section>
      `;
    },
    terminate: () => {
      void app;
    },
  };
}

function canonicalizeDesktopRoute(route: string): string {
  const url = new URL(route, window.location.origin);
  if (/^\/apps\/[^/]+$/.test(url.pathname)) {
    url.pathname = `${url.pathname}/`;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function normalizeRouteBasePath(routeBase: string): string {
  const url = new URL(routeBase, window.location.origin);
  return url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appOpenArgsFromRoute(app: DesktopApp, route: string, windowId: string): AppOpenArgs {
  if (app.launch.kind !== "package") {
    throw new Error(`Unsupported app launch target: ${app.id}`);
  }

  const url = new URL(canonicalizeDesktopRoute(route), window.location.origin);
  const routeBasePath = normalizeRouteBasePath(app.routeBase);
  if (url.pathname !== routeBasePath.slice(0, -1) && !url.pathname.startsWith(routeBasePath)) {
    throw new Error(`Unsupported app route: ${route}`);
  }

  const suffixPath = url.pathname === routeBasePath.slice(0, -1)
    ? "/"
    : `/${url.pathname.slice(routeBasePath.length)}`;
  return {
    packageName: app.launch.packageName,
    entrypointName: app.launch.entrypointName,
    clientId: windowId,
    suffix: suffixPath,
    search: url.search,
    hash: url.hash,
  };
}

function attachIframeInteractionFocus(iframe: HTMLIFrameElement, requestFocus: () => void): { destroy: () => void } {
  let activeDocument: Document | null = null;

  const onInteraction = (): void => {
    requestFocus();
  };

  const detachDocument = (): void => {
    if (!activeDocument) {
      return;
    }

    activeDocument.removeEventListener("pointerdown", onInteraction, true);
    activeDocument.removeEventListener("focusin", onInteraction, true);
    activeDocument = null;
  };

  const attachDocument = (): void => {
    detachDocument();

    let frameDocument: Document | null = null;
    try {
      frameDocument = iframe.contentDocument;
    } catch {
      return;
    }

    if (!frameDocument) {
      return;
    }

    activeDocument = frameDocument;
    activeDocument.addEventListener("pointerdown", onInteraction, true);
    activeDocument.addEventListener("focusin", onInteraction, true);
  };

  iframe.addEventListener("load", attachDocument);
  attachDocument();

  return {
    destroy: () => {
      iframe.removeEventListener("load", attachDocument);
      detachDocument();
    },
  };
}

function appSessionLaunchEndpoint(sessionId: string): string {
  return `/apps/sessions/${encodeURIComponent(sessionId)}/launch`;
}

const RUNTIME_STATUS_FALLBACK_MS = 3000;

function shouldUseRuntimeStatusFallback(state: string | null): boolean {
  return state === null || state === "booting" || state === "connected";
}

function attachIframeRuntimeStatus(
  iframe: HTMLIFrameElement,
  loader: AppLaunchLoader,
): { destroy: () => void } {
  let fallbackTimer: number | null = null;
  let loaded = false;
  let latestRuntimeState: string | null = null;

  const clearFallbackTimer = (): void => {
    if (fallbackTimer === null) {
      return;
    }
    window.clearTimeout(fallbackTimer);
    fallbackTimer = null;
  };

  const scheduleFallbackTimer = (): void => {
    clearFallbackTimer();
    fallbackTimer = window.setTimeout(() => {
      fallbackTimer = null;
      loader.complete();
    }, RUNTIME_STATUS_FALLBACK_MS);
  };

  const onLoad = (): void => {
    loaded = true;
    if (!shouldUseRuntimeStatusFallback(latestRuntimeState)) {
      return;
    }
    if (latestRuntimeState === null) {
      loader.setPhase("runtime", "Starting app runtime");
    }
    scheduleFallbackTimer();
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.origin !== window.location.origin || event.source !== iframe.contentWindow) {
      return;
    }
    const record = asRecord(event.data);
    if (!record || record.type !== "gsv-app-runtime-status") {
      return;
    }
    const state = asString(record.state);
    if (!state) {
      return;
    }
    latestRuntimeState = state;
    clearFallbackTimer();
    loader.setRuntimeStatus(state, asString(record.message) ?? undefined);
    if (loaded && shouldUseRuntimeStatusFallback(latestRuntimeState)) {
      scheduleFallbackTimer();
    }
  };

  iframe.addEventListener("load", onLoad, { once: true });
  window.addEventListener("message", onMessage);

  return {
    destroy: () => {
      clearFallbackTimer();
      iframe.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
    },
  };
}

async function establishAppLaunchSession(launch: AppLaunchResult): Promise<void> {
  const response = await fetch(appSessionLaunchEndpoint(launch.sessionId), {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ token: launch.launchToken }),
  });
  if (response.ok) {
    return;
  }
  const message = await response.text().catch(() => "");
  throw new Error(message || `Failed to launch app session (${response.status})`);
}

type AppRuntimeGsvClient = Pick<GSVClient, "app" | "onStatus">;

function createPackageAppInstance(app: DesktopApp, gatewayClient: AppRuntimeGsvClient): AppInstance {
  let bridge: ReturnType<typeof attachHostBridge> | null = null;
  let focusController: ReturnType<typeof attachIframeInteractionFocus> | null = null;
  let runtimeStatusController: ReturnType<typeof attachIframeRuntimeStatus> | null = null;
  let activeLoader: AppLaunchLoader | null = null;
  let mountGeneration = 0;
  let activeSessionId: string | null = null;
  let activeClientId: string | null = null;

  const closeSession = (sessionId: string): void => {
    void gatewayClient.app.close({ sessionId }).catch(() => {
      // The server may already have expired the session or the host may be disconnecting.
    });
  };

  const detachClient = (sessionId: string, clientId: string): void => {
    void gatewayClient.app.detach({ sessionId, clientId }).catch(() => {
      // The server may already have expired the session or the host may be disconnecting.
    });
  };

  const detachActiveClient = (): void => {
    const sessionId = activeSessionId;
    const clientId = activeClientId;
    activeSessionId = null;
    activeClientId = null;
    if (sessionId && clientId) {
      detachClient(sessionId, clientId);
    }
  };

  const destroyActiveFrameControllers = (): void => {
    runtimeStatusController?.destroy();
    runtimeStatusController = null;
    focusController?.destroy();
    focusController = null;
    bridge?.destroy();
    bridge = null;
  };

  return {
    mount: async (container, context) => {
      const generation = ++mountGeneration;
      activeLoader?.destroy();
      activeLoader = null;
      detachActiveClient();
      destroyActiveFrameControllers();
      const loader = createAppLaunchLoader({
        appName: app.name,
        route: context.route,
        seed: `${app.id}:${context.windowId}:${context.route}`,
      });
      activeLoader = loader;
      loader.setPhase("session", "Allocating app session");
      container.replaceChildren(loader.element);

      const destroyLoader = (): void => {
        loader.destroy();
        if (activeLoader === loader) {
          activeLoader = null;
        }
      };

      let launch: AppLaunchResult;
      try {
        launch = await gatewayClient.app.open(appOpenArgsFromRoute(app, context.route, context.windowId));
      } catch (error) {
        loader.fail(toErrorMessage(error));
        throw error;
      }
      if (generation !== mountGeneration) {
        destroyLoader();
        closeSession(launch.sessionId);
        return;
      }
      try {
        loader.setPhase("session", "Authorizing launch token");
        await establishAppLaunchSession(launch);
      } catch (error) {
        loader.fail(toErrorMessage(error));
        closeSession(launch.sessionId);
        throw error;
      }
      if (generation !== mountGeneration) {
        destroyLoader();
        closeSession(launch.sessionId);
        return;
      }

      activeSessionId = launch.sessionId;
      activeClientId = launch.clientId;

      const iframe = document.createElement("iframe");
      iframe.title = app.name;
      iframe.loading = "eager";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      iframe.style.display = "block";
      iframe.setAttribute("allow", "clipboard-read; clipboard-write");

      destroyActiveFrameControllers();
      loader.setPhase("frame", "Preparing secure frame");
      runtimeStatusController = attachIframeRuntimeStatus(iframe, loader);
      focusController = attachIframeInteractionFocus(iframe, context.requestFocus);
      bridge = attachHostBridge(iframe, gatewayClient, {
        setTitle: context.setTitle,
        setBadge: context.setBadge,
        setDirty: context.setDirty,
        requestNewWindow: context.requestNewWindow,
      });
      iframe.src = launch.launchUrl;
      loader.attachIframe(iframe);
    },
    terminate: () => {
      mountGeneration += 1;
      detachActiveClient();
      activeLoader?.destroy();
      activeLoader = null;
      destroyActiveFrameControllers();
      void app;
    },
  };
}

export function createAppRuntime(gatewayClient: AppRuntimeGsvClient): AppRuntimeRegistry {
  return {
    createInstance: (app) => {
      if (app.launch.kind === "package") {
        return createPackageAppInstance(app, gatewayClient);
      }

      return createUnsupportedAppInstance(app);
    },
  };
}
