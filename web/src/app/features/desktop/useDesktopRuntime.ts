import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { createAppRuntime } from "../../../apps-runtime";
import { createPresenceControl } from "../../../presence";
import type { GatewayClient } from "../../../gateway-client";
import { createLauncher } from "./runtime/launcher";
import { createWindowManager, type WindowManager } from "./runtime/windowManager";

export type DesktopRuntime = {
  windowManager: WindowManager;
  launcher: ReturnType<typeof createLauncher>;
};

type UseDesktopRuntimeOptions = {
  shellRef: RefObject<HTMLDivElement>;
  windowsLayerRef: RefObject<HTMLElement>;
  gatewayClient: GatewayClient;
  standalone: boolean;
};

type UseDesktopRuntimeResult = {
  runtimeRef: RefObject<DesktopRuntime | null>;
  runtimeRevision: number;
  shellRootNode: HTMLElement | null;
};

export function useDesktopRuntime({
  shellRef,
  windowsLayerRef,
  gatewayClient,
  standalone,
}: UseDesktopRuntimeOptions): UseDesktopRuntimeResult {
  const runtimeRef = useRef<DesktopRuntime | null>(null);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const [shellRootNode, setShellRootNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const shellEl = shellRef.current;
    const windowsLayerEl = windowsLayerRef.current;

    if (!shellEl || !windowsLayerEl) {
      throw new Error("Shell markup is incomplete");
    }

    document.documentElement.classList.toggle("is-standalone", standalone);

    const appRuntime = createAppRuntime(gatewayClient);
    const windowManager = createWindowManager({
      layerNode: windowsLayerEl,
      appRegistry: [],
      appRuntime,
    });
    const presenceControl = createPresenceControl({
      rootNode: shellEl,
      gatewayClient,
    });
    const launcher = createLauncher({
      rootNode: shellEl,
      windowManager,
    });
    const nextRuntime = {
      windowManager,
      launcher,
    };

    runtimeRef.current = nextRuntime;
    setRuntimeRevision((revision) => revision + 1);
    setShellRootNode(shellEl);

    return () => {
      runtimeRef.current = null;
      launcher.destroy();
      presenceControl.destroy();
      windowManager.destroy();
      document.documentElement.classList.remove("is-standalone");
    };
  }, [gatewayClient, shellRef, standalone, windowsLayerRef]);

  return {
    runtimeRef,
    runtimeRevision,
    shellRootNode,
  };
}
