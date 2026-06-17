import { useEffect, useMemo, useRef } from "preact/hooks";
import { useGateway } from "../../services/gateway/GatewayProvider";
import { useSession } from "../../services/session/SessionProvider";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import { usePackageApps } from "../packages/usePackageApps";
import { PresenceController } from "../presence/presenceController";
import { SessionScreens } from "../session/SessionScreens";
import { DesktopShellFrame } from "./DesktopShellFrame";
import { useDesktopAppsSync } from "./useDesktopAppsSync";
import { useDesktopRuntime } from "./useDesktopRuntime";
import { useSessionFrameBridge } from "./useSessionFrameBridge";

type StandaloneNavigator = Navigator & {
  standalone?: boolean;
};

function isStandaloneDisplay(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || (navigator as StandaloneNavigator).standalone === true;
}

export function DesktopShell() {
  const shellRef = useRef<HTMLDivElement>(null);
  const windowsLayerRef = useRef<HTMLElement>(null);
  const { client: gatewayClient, connected } = useGateway();
  const { service: sessionService, snapshot: sessionSnapshot } = useSession();
  const standalone = useMemo(isStandaloneDisplay, []);
  const presenceController = useMemo(() => new PresenceController(gatewayClient), [gatewayClient]);
  const packageApps = usePackageApps({
    gatewayClient,
    enabled: connected,
  });
  const { runtimeRef, runtimeRevision, shellRootNode } = useDesktopRuntime({
    shellRef,
    windowsLayerRef,
    gatewayClient,
    standalone,
  });

  useSessionFrameBridge({
    shellRootNode,
    sessionService,
    snapshot: sessionSnapshot,
  });
  useDesktopAppsSync({
    runtimeRef,
    runtimeRevision,
    apps: packageApps.data,
    connected,
    appLoadFailed: packageApps.isError,
    sessionPhase: sessionSnapshot.phase,
  });
  useEffect(() => () => presenceController.destroy(), [presenceController]);

  return (
    <>
      <div class="app-shell-root">
        <DesktopShellFrame
          shellRef={shellRef}
          windowsLayerRef={windowsLayerRef}
          presenceController={presenceController}
          standalone={standalone}
        >
          <SessionScreens session={sessionService} snapshot={sessionSnapshot} />
        </DesktopShellFrame>
      </div>
      {shellRootNode ? <NotificationsPanel rootNode={shellRootNode} /> : null}
    </>
  );
}
