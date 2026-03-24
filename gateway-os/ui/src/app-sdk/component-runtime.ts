import type { AppInstance, AppRuntimeContext } from "../app-runtime";
import type { GatewayClient } from "../gateway-client";
import type { AppManifest } from "./manifest";
import { createScopedKernelClient } from "./kernel-client";
import { createThemeClient } from "./theme";

export type AppElementContext = AppRuntimeContext & {
  kernel: ReturnType<typeof createScopedKernelClient>;
  theme: ReturnType<typeof createThemeClient>;
};

export type GsvAppElement = HTMLElement & {
  gsvFullBleed?: boolean;
  gsvMount?: (context: AppElementContext) => void | Promise<void>;
  gsvOnSignal?: (signal: string, payload: unknown) => void | Promise<void>;
  gsvSuspend?: () => void | Promise<void>;
  gsvResume?: () => void | Promise<void>;
  gsvUnmount?: () => void | Promise<void>;
};

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

async function maybeAwait(result: unknown): Promise<void> {
  if (isPromiseLike(result)) {
    await result;
  }
}

function assertComponentManifest(manifest: AppManifest): asserts manifest is AppManifest & {
  entrypoint: { kind: "component"; tagName: `${string}-${string}`; route: string };
} {
  if (manifest.entrypoint.kind !== "component") {
    throw new Error(`App "${manifest.id}" is not a component entrypoint`);
  }
}

export function createComponentAppInstance(
  manifest: AppManifest,
  gatewayClient: GatewayClient,
): AppInstance {
  assertComponentManifest(manifest);

  let element: GsvAppElement | null = null;
  let context: AppElementContext | null = null;
  let unsubscribeSignals: (() => void) | null = null;

  return {
    mount: async (container, runtimeContext) => {
      unsubscribeSignals?.();
      unsubscribeSignals = null;
      container.classList.remove("window-content-full-bleed");

      const node = document.createElement(manifest.entrypoint.tagName) as GsvAppElement;
      node.classList.add("gsv-app-element");
      if (node.gsvFullBleed === true || node.hasAttribute("data-gsv-full-bleed")) {
        container.classList.add("window-content-full-bleed");
      }
      container.replaceChildren(node);

      element = node;
      context = {
        ...runtimeContext,
        kernel: createScopedKernelClient(gatewayClient, manifest),
        theme: createThemeClient(),
      };

      unsubscribeSignals = context.kernel.onSignal((signal, payload) => {
        const target = element;
        if (!target?.gsvOnSignal) {
          return;
        }

        void maybeAwait(target.gsvOnSignal(signal, payload)).catch((error) => {
          console.error(`App "${manifest.id}" gsvOnSignal failed`, error);
        });
      });

      await maybeAwait(node.gsvMount?.(context));
    },
    suspend: async () => {
      await maybeAwait(element?.gsvSuspend?.());
    },
    resume: async () => {
      await maybeAwait(element?.gsvResume?.());
    },
    terminate: async () => {
      unsubscribeSignals?.();
      unsubscribeSignals = null;
      const target = element;
      element = null;
      context = null;
      await maybeAwait(target?.gsvUnmount?.());
    },
  };
}
