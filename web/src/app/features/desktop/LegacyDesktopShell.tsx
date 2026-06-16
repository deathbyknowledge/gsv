import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createAppRuntime } from "../../../apps-runtime";
import { createLauncher } from "../../../launcher";
import { createPresenceControl } from "../../../presence";
import { createSessionUi } from "../../../session-ui";
import { createWindowManager, type WindowManager } from "../../../window-manager";
import type { AppManifest } from "../../../apps";
import { useGateway } from "../../services/gateway/GatewayProvider";
import { useSession } from "../../services/session/SessionProvider";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { usePackageApps } from "../packages/usePackageApps";
import { DesktopShellFrame } from "./DesktopShellFrame";

type StandaloneNavigator = Navigator & {
  standalone?: boolean;
};

type LegacyDesktopRuntime = {
  windowManager: WindowManager;
  launcher: ReturnType<typeof createLauncher>;
};

function isStandaloneDisplay(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || (navigator as StandaloneNavigator).standalone === true;
}

function syncDesktopApps(
  runtime: LegacyDesktopRuntime | null,
  apps: readonly AppManifest[],
): void {
  if (!runtime) {
    return;
  }
  runtime.windowManager.setAppRegistry(apps);
  runtime.launcher.setApps(apps);
}

export function LegacyDesktopShell() {
  const shellRef = useRef<HTMLDivElement>(null);
  const windowsLayerRef = useRef<HTMLElement>(null);
  const runtimeRef = useRef<LegacyDesktopRuntime | null>(null);
  const [shellRootNode, setShellRootNode] = useState<HTMLElement | null>(null);
  const { client: gatewayClient, connected } = useGateway();
  const { service: sessionService, snapshot: sessionSnapshot } = useSession();
  const standalone = useMemo(isStandaloneDisplay, []);
  const packageApps = usePackageApps({
    gatewayClient,
    enabled: connected,
  });

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
    const sessionUi = createSessionUi({
      rootNode: shellEl,
      session: sessionService,
    });

    runtimeRef.current = {
      windowManager,
      launcher,
    };
    setShellRootNode(shellEl);

    void sessionService.start();

    return () => {
      runtimeRef.current = null;
      sessionUi.destroy();
      launcher.destroy();
      presenceControl.destroy();
      windowManager.destroy();
      document.documentElement.classList.remove("is-standalone");
    };
  }, [gatewayClient, sessionService, standalone]);

  useEffect(() => {
    if (!connected && sessionSnapshot.phase !== "ready") {
      syncDesktopApps(runtimeRef.current, []);
      return;
    }

    if (connected && packageApps.isError) {
      syncDesktopApps(runtimeRef.current, []);
      return;
    }

    if (packageApps.data) {
      syncDesktopApps(runtimeRef.current, packageApps.data);
    }
  }, [connected, packageApps.data, packageApps.isError, sessionSnapshot.phase]);

  return (
    <>
      <div class="app-shell-root">
        <DesktopShellFrame
          shellRef={shellRef}
          windowsLayerRef={windowsLayerRef}
          standalone={standalone}
        />
      </div>
      {shellRootNode ? <NotificationsPanel rootNode={shellRootNode} /> : null}
    </>
  );
}
