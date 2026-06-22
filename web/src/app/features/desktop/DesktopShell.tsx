import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useGateway } from "../../services/gateway/GatewayProvider";
import { useSession } from "../../services/session/SessionProvider";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import type { NotificationAnchor, NotificationSurface } from "../notifications/types";
import { usePackageApps } from "../packages/usePackageApps";
import { PresenceController } from "../presence/presenceController";
import { SessionScreens } from "../session/SessionScreens";
import { GsvShell } from "../gsv-shell/GsvShell";
import { useDesktopAppsSync } from "./useDesktopAppsSync";
import { useDesktopRuntime } from "./useDesktopRuntime";

type StandaloneNavigator = Navigator & {
  standalone?: boolean;
};

function isStandaloneDisplay(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || (navigator as StandaloneNavigator).standalone === true;
}

function formatMobileHomeDate(): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date());
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
  const mobileHomeDate = useMemo(formatMobileHomeDate, []);
  const presenceController = useMemo(() => new PresenceController(gatewayClient), [gatewayClient]);
  const packageApps = usePackageApps({
    gatewayClient,
    enabled: connected,
  });
  const { runtimeRef, runtimeRevision } = useDesktopRuntime({
    shellRef,
    windowsLayerRef,
    gatewayClient,
    standalone,
  });

  useEffect(() => {
    void sessionService.start();
  }, [sessionService]);
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
  const desktopVisible = sessionSnapshot.phase === "ready";
  const sessionUsername = sessionSnapshot.username || "operator";
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
  const lockSession = useCallback((): void => {
    sessionService.lock();
  }, [sessionService]);
  const openCommandPalette = useCallback((): void => {
    runtimeRef.current?.launcher.openCommandPalette();
  }, [runtimeRef]);

  return (
    <>
      <div class="app-shell-root">
        <div class={`gsv-native-shell${standalone ? " is-standalone" : ""}`} ref={shellRef}>
          <SessionScreens session={sessionService} snapshot={sessionSnapshot} />
          <GsvShell
            windowsLayerRef={windowsLayerRef}
            presenceController={presenceController}
            notificationOpenSurface={notificationOpenSurface}
            notificationUnreadCount={notificationUnreadCount}
            onNotificationsToggle={toggleNotifications}
            desktopVisible={desktopVisible}
            sessionUsername={sessionUsername}
            mobileHomeDate={mobileHomeDate}
            onLockSession={lockSession}
            onOpenCommandPalette={openCommandPalette}
          />
        </div>
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
