import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createAppRuntime } from "../../../apps-runtime";
import { createLauncher } from "../../../launcher";
import { createPresenceControl } from "../../../presence";
import { createWindowManager, type WindowManager } from "../../../window-manager";
import type { AppManifest } from "../../../apps";
import type { SessionService, SessionSnapshot } from "../../../session-service";
import { useGateway } from "../../services/gateway/GatewayProvider";
import { useSession } from "../../services/session/SessionProvider";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { usePackageApps } from "../packages/usePackageApps";
import { SessionScreens } from "../session/SessionScreens";
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

function syncSessionFrame(
  shellNode: HTMLElement,
  snapshot: SessionSnapshot,
): void {
  const ready = snapshot.phase === "ready";
  const desktopRootNode = shellNode.querySelector<HTMLElement>("[data-desktop-root]");
  const lockNode = shellNode.querySelector<HTMLButtonElement>("[data-session-lock]");
  const mobileHomeUsernameNode = shellNode.querySelector<HTMLElement>("[data-mobile-home-username]");
  const mobileHomeDateNode = shellNode.querySelector<HTMLElement>("[data-mobile-home-date]");

  if (desktopRootNode) {
    desktopRootNode.hidden = !ready;
  }
  if (lockNode) {
    lockNode.disabled = !ready;
  }
  if (mobileHomeUsernameNode) {
    mobileHomeUsernameNode.textContent = snapshot.username || "operator";
  }
  if (mobileHomeDateNode) {
    mobileHomeDateNode.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(new Date());
  }
}

function bindSessionLock(
  shellNode: HTMLElement,
  sessionService: SessionService,
): () => void {
  const lockNode = shellNode.querySelector<HTMLButtonElement>("[data-session-lock]");
  if (!lockNode) {
    return () => {};
  }

  const onLockClick = (): void => {
    sessionService.lock();
  };

  lockNode.addEventListener("click", onLockClick);
  return () => {
    lockNode.removeEventListener("click", onLockClick);
  };
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
    const unbindSessionLock = bindSessionLock(shellEl, sessionService);

    runtimeRef.current = {
      windowManager,
      launcher,
    };
    setShellRootNode(shellEl);

    void sessionService.start();

    return () => {
      runtimeRef.current = null;
      unbindSessionLock();
      launcher.destroy();
      presenceControl.destroy();
      windowManager.destroy();
      document.documentElement.classList.remove("is-standalone");
    };
  }, [gatewayClient, sessionService, standalone]);

  useEffect(() => {
    if (!shellRootNode) {
      return;
    }
    syncSessionFrame(shellRootNode, sessionSnapshot);
  }, [shellRootNode, sessionSnapshot]);

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
        >
          <SessionScreens session={sessionService} snapshot={sessionSnapshot} />
        </DesktopShellFrame>
      </div>
      {shellRootNode ? <NotificationsPanel rootNode={shellRootNode} /> : null}
    </>
  );
}
