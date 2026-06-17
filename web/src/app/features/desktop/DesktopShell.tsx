import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGateway } from "../../services/gateway/GatewayProvider";
import { useSession } from "../../services/session/SessionProvider";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import type { NotificationAnchor, NotificationSurface } from "../notifications/types";
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
  const [notificationPanel, setNotificationPanel] = useState<{
    open: boolean;
    anchor: NotificationAnchor | null;
  }>({ open: false, anchor: null });
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
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
  const notificationOpenSurface = notificationPanel.open
    ? notificationPanel.anchor?.surface ?? null
    : null;
  const toggleNotifications = useCallback((surface: NotificationSurface, node: HTMLButtonElement): void => {
    setNotificationPanel((current) => {
      const sameAnchor = current.anchor?.surface === surface && current.anchor.node === node;
      if (current.open && sameAnchor) {
        return { ...current, open: false };
      }
      return { open: true, anchor: { surface, node } };
    });
  }, []);
  const closeNotifications = useCallback((): void => {
    setNotificationPanel((current) => ({ ...current, open: false }));
  }, []);
  const openNotifications = useCallback((): void => {
    setNotificationPanel((current) => ({ ...current, open: true }));
  }, []);

  return (
    <>
      <div class="app-shell-root">
        <DesktopShellFrame
          shellRef={shellRef}
          windowsLayerRef={windowsLayerRef}
          presenceController={presenceController}
          notificationOpenSurface={notificationOpenSurface}
          notificationUnreadCount={notificationUnreadCount}
          onNotificationsToggle={toggleNotifications}
          standalone={standalone}
        >
          <SessionScreens session={sessionService} snapshot={sessionSnapshot} />
        </DesktopShellFrame>
      </div>
      <NotificationsPanel
        anchor={notificationPanel.anchor}
        open={notificationPanel.open}
        onClose={closeNotifications}
        onOpen={openNotifications}
        onUnreadCountChange={setNotificationUnreadCount}
      />
    </>
  );
}
