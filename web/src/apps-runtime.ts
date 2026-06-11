import type { AppManifest } from "./apps";
import type { AppInstance, AppRuntimeRegistry } from "./app-runtime";
import { createAppLaunchLoader, type AppLaunchLoader } from "./app-loading";
import type { GatewayClientLike } from "./gateway-client";
import { attachHostBridge } from "./host-bridge";
import type { AppLaunchResult, AppOpenArgs } from "@gsv/protocol/syscalls/apps";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function createUnsupportedAppInstance(manifest: AppManifest): AppInstance {
  return {
    mount: (container) => {
      container.innerHTML = `
        <section class="app-grid">
          <p class="eyebrow">Unsupported runtime</p>
          <h1>${escapeHtml(manifest.name)}</h1>
          <p>${escapeHtml(manifest.description)}</p>
          <div class="app-tag-row">
            <span class="app-tag">route ${escapeHtml(manifest.entrypoint.route)}</span>
            <span class="app-tag">kind ${escapeHtml(manifest.entrypoint.kind)}</span>
          </div>
        </section>
      `;
    },
    terminate: () => {
      void manifest;
    },
  };
}

function canonicalizeAppRoute(route: string): string {
  const url = new URL(route, window.location.origin);
  if (/^\/apps\/[^/]+$/.test(url.pathname)) {
    url.pathname = `${url.pathname}/`;
  }
  return `${url.pathname}${url.search}${url.hash}`;
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

function appOpenArgsFromRoute(route: string, windowId: string): AppOpenArgs {
  const url = new URL(canonicalizeAppRoute(route), window.location.origin);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "apps" || parts[1] === "sessions") {
    throw new Error(`Unsupported app route: ${route}`);
  }

  const suffixParts = parts.slice(2);
  return {
    packageName: parts[1],
    clientId: windowId,
    suffix: suffixParts.length > 0 ? `/${suffixParts.join("/")}` : "/",
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
  return state === null || (state !== "loading" && state !== "ready" && state !== "error");
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

function createWebAppInstance(manifest: AppManifest, gatewayClient: GatewayClientLike): AppInstance {
  let bridge: ReturnType<typeof attachHostBridge> | null = null;
  let focusController: ReturnType<typeof attachIframeInteractionFocus> | null = null;
  let runtimeStatusController: ReturnType<typeof attachIframeRuntimeStatus> | null = null;
  let activeLoader: AppLaunchLoader | null = null;
  let mountGeneration = 0;
  let activeSessionId: string | null = null;
  let activeClientId: string | null = null;

  const closeSession = (sessionId: string): void => {
    void gatewayClient.call("app.close", { sessionId }).catch(() => {
      // The server may already have expired the session or the host may be disconnecting.
    });
  };

  const detachClient = (sessionId: string, clientId: string): void => {
    void gatewayClient.call("app.detach", { sessionId, clientId }).catch(() => {
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
        appName: manifest.name,
        route: context.route,
        seed: `${manifest.id}:${context.windowId}:${context.route}`,
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
        launch = await gatewayClient.call<AppLaunchResult>(
          "app.open",
          appOpenArgsFromRoute(context.route, context.windowId),
        );
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
      iframe.title = manifest.name;
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
      loader.attachIframe(iframe);
      iframe.src = launch.launchUrl;
    },
    terminate: () => {
      mountGeneration += 1;
      detachActiveClient();
      activeLoader?.destroy();
      activeLoader = null;
      destroyActiveFrameControllers();
      void manifest;
    },
  };
}

export function createAppRuntime(gatewayClient: GatewayClientLike): AppRuntimeRegistry {
  return {
    createInstance: (manifest) => {
      if (manifest.entrypoint.kind === "web") {
        return createWebAppInstance(manifest, gatewayClient);
      }

      return createUnsupportedAppInstance(manifest);
    },
  };
}
