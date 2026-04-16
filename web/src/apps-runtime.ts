import type { AppManifest } from "./apps";
import type { AppInstance, AppRuntimeRegistry } from "./app-runtime";
import type { GatewayClientLike } from "./gateway-client";
import { attachHostBridge } from "./host-bridge";

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

function createWebAppInstance(manifest: AppManifest, gatewayClient: GatewayClientLike): AppInstance {
  let bridge: ReturnType<typeof attachHostBridge> | null = null;

  return {
    mount: (container, context) => {
      const iframe = document.createElement("iframe");
      const iframeUrl = new URL(canonicalizeAppRoute(context.route), window.location.origin);
      iframeUrl.searchParams.set("windowId", context.windowId);
      iframe.src = iframeUrl.pathname + iframeUrl.search + iframeUrl.hash;
      iframe.title = manifest.name;
      iframe.loading = "eager";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      iframe.style.display = "block";
      iframe.setAttribute("allow", "clipboard-read; clipboard-write");

      bridge?.destroy();
      bridge = attachHostBridge(iframe, gatewayClient);
      container.replaceChildren(iframe);
    },
    terminate: () => {
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
