import type { AppManifest } from "./apps";
import type { AppInstance, AppRuntimeContext, AppRuntimeRegistry } from "./app-runtime";
import { createComponentAppInstance } from "./app-sdk";
import { ensureBuiltinComponentAppsRegistered } from "./builtin-component-apps";
import { ensureChatAppRegistered } from "./apps/chat";
import { ensureDevicesAppRegistered } from "./apps/devices";
import { ensureFilesAppRegistered } from "./apps/files";
import { ensureProcessManagerAppRegistered } from "./apps/process-manager";
import { ensureShellAppRegistered } from "./apps/shell";
import type { AppWindowSession, GatewayClient } from "./gateway-client";
import { getActiveThreadContext } from "./thread-context";

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
      const workspace = context.session.workspace?.workspaceId ?? "none";
      const backend = context.session.backend.kind === "dynamic-worker"
        ? `${context.session.backend.kind}:${context.session.backend.state}`
        : context.session.backend.kind;
      container.innerHTML = `
        <section class="app-grid">
          <p class="eyebrow">Legacy Runtime</p>
          <h1>${escapeHtml(context.manifest.name)}</h1>
          <p>${escapeHtml(context.manifest.description)}</p>
          <div class="app-tag-row">
            <span class="app-tag">route ${escapeHtml(context.manifest.entrypoint.route)}</span>
            <span class="app-tag">permissions ${escapeHtml(permissions)}</span>
            <span class="app-tag">syscalls ${escapeHtml(syscalls)}</span>
            <span class="app-tag">workspace ${escapeHtml(workspace)}</span>
            <span class="app-tag">backend ${escapeHtml(backend)}</span>
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

function createLocalWindowSession(manifest: AppManifest, windowId: string): AppWindowSession {
  return {
    sessionId: `local:${windowId}`,
    appId: manifest.id,
    host: {
      kind: "window",
      instanceId: windowId,
    },
    surface: {
      kind: "renderer",
      name: "desktop",
    },
    ownerUid: null,
    thread: null,
    workspace: null,
    backend: {
      kind: "none",
      state: "not-required",
      bindings: [],
    },
  };
}

export function createAppRuntime(gatewayClient: GatewayClient): AppRuntimeRegistry {
  ensureBuiltinComponentAppsRegistered();
  ensureChatAppRegistered();
  ensureFilesAppRegistered();
  ensureShellAppRegistered();
  ensureDevicesAppRegistered();
  ensureProcessManagerAppRegistered();

  return {
    openWindowSession: async (manifest, windowId) => {
      if (!gatewayClient.isConnected()) {
        return createLocalWindowSession(manifest, windowId);
      }

      const threadContext = getActiveThreadContext();
      const result = await gatewayClient.openAppSession({
        appId: manifest.id,
        host: {
          kind: "window",
          instanceId: windowId,
        },
        surface: {
          kind: "renderer",
          name: "desktop",
        },
        target: threadContext
          ? {
              thread: {
                pid: threadContext.pid,
                cwd: threadContext.cwd,
                workspaceId: threadContext.workspaceId,
              },
            }
          : undefined,
      });

      return result.session;
    },
    createInstance: (manifest) => {
      if (manifest.entrypoint.kind === "component") {
        return createComponentAppInstance(manifest, gatewayClient);
      }

      return createLegacyPlaceholder(manifest);
    },
  };
}
