import type { AppManifest } from "./apps";
import type { AppInstance, AppRuntimeRegistry } from "./app-runtime";
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

function createWebAppInstance(manifest: AppManifest, gatewayClient: GatewayClientLike): AppInstance {
  let bridge: ReturnType<typeof attachHostBridge> | null = null;
  let focusController: ReturnType<typeof attachIframeInteractionFocus> | null = null;
  let mountGeneration = 0;

  return {
    mount: async (container, context) => {
      const generation = ++mountGeneration;
      const launch = await gatewayClient.call<AppLaunchResult>(
        "app.open",
        appOpenArgsFromRoute(context.route, context.windowId),
      );
      if (generation !== mountGeneration) {
        return;
      }

      const iframe = document.createElement("iframe");
      iframe.src = launch.launchUrl;
      iframe.title = manifest.name;
      iframe.loading = "eager";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      iframe.style.display = "block";
      iframe.setAttribute("allow", "clipboard-read; clipboard-write");

      bridge?.destroy();
      focusController?.destroy();
      focusController = attachIframeInteractionFocus(iframe, context.requestFocus);
      bridge = attachHostBridge(iframe, gatewayClient, {
        setTitle: context.setTitle,
        setBadge: context.setBadge,
        setDirty: context.setDirty,
        requestNewWindow: context.requestNewWindow,
      });
      container.replaceChildren(iframe);
    },
    terminate: () => {
      mountGeneration += 1;
      focusController?.destroy();
      focusController = null;
      bridge?.destroy();
      bridge = null;
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
