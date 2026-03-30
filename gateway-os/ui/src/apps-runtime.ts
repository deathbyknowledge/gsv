import type { AppManifest } from "./apps";
import type { AppInstance, AppRuntimeContext, AppRuntimeRegistry } from "./app-runtime";
import { createComponentAppInstance } from "./app-sdk";
import { ensureBuiltinComponentAppsRegistered } from "./builtin-component-apps";
import { ensureChatAppRegistered } from "./apps/chat";
import { ensureDevicesAppRegistered } from "./apps/devices";
import { ensureFilesAppRegistered } from "./apps/files";
import { ensureProcessManagerAppRegistered } from "./apps/process-manager";
import { ensureShellAppRegistered } from "./apps/shell";
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

function createLegacyPlaceholder(manifest: AppManifest): AppInstance {
  return {
    mount: (container, context: AppRuntimeContext) => {
      const permissions = context.manifest.permissions.join(", ") || "none";
      const syscalls = context.manifest.syscalls.join(", ") || "none";
      container.innerHTML = `
        <section class="app-grid">
          <p class="eyebrow">Legacy Runtime</p>
          <h1>${escapeHtml(context.manifest.name)}</h1>
          <p>${escapeHtml(context.manifest.description)}</p>
          <div class="app-tag-row">
            <span class="app-tag">route ${escapeHtml(context.manifest.entrypoint.route)}</span>
            <span class="app-tag">permissions ${escapeHtml(permissions)}</span>
            <span class="app-tag">syscalls ${escapeHtml(syscalls)}</span>
          </div>
          <div class="mock-grid">
            <article>
              <h2>Runtime</h2>
              <p>App is mounted with the legacy runtime adapter.</p>
            </article>
          </div>
        </section>
      `;
    },
    terminate: () => {
      void manifest;
    },
  };
}

function createWebAppInstance(manifest: AppManifest, gatewayClient: GatewayClientLike): AppInstance {
  let bridge: ReturnType<typeof attachHostBridge> | null = null;

  return {
    mount: (container) => {
      const iframe = document.createElement("iframe");
      iframe.src = manifest.entrypoint.route;
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
  ensureBuiltinComponentAppsRegistered();
  ensureChatAppRegistered();
  ensureFilesAppRegistered();
  ensureShellAppRegistered();
  ensureDevicesAppRegistered();
  ensureProcessManagerAppRegistered();

  return {
    createInstance: (manifest) => {
      if (manifest.entrypoint.kind === "component") {
        return createComponentAppInstance(manifest, gatewayClient);
      }
      if (manifest.entrypoint.kind === "web") {
        return createWebAppInstance(manifest, gatewayClient);
      }

      return createLegacyPlaceholder(manifest);
    },
  };
}
