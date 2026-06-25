import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useSession } from "../../services/session/SessionProvider";
import { NotificationsPanel } from "../notifications/NotificationsPanel";
import type { NotificationAnchor, NotificationSurface } from "../notifications/types";
import { SessionScreens } from "../session/SessionScreens";
import { GsvShell } from "../gsv-shell/GsvShell";

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
  const { service: sessionService, snapshot: sessionSnapshot } = useSession();
  const [notificationPanel, setNotificationPanel] = useState<{
    open: boolean;
    anchor: NotificationAnchor | null;
  }>({ open: false, anchor: null });
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const standalone = useMemo(isStandaloneDisplay, []);
  const mobileHomeDate = useMemo(formatMobileHomeDate, []);

  useEffect(() => {
    void sessionService.start();
  }, [sessionService]);
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
  return (
    <>
      <div class="app-shell-root">
        <div class={`gsv-native-shell${standalone ? " is-standalone" : ""}`} ref={shellRef}>
          <SessionScreens session={sessionService} snapshot={sessionSnapshot} />
          <GsvShell
            notificationOpenSurface={notificationOpenSurface}
            notificationUnreadCount={notificationUnreadCount}
            onNotificationsToggle={toggleNotifications}
            desktopVisible={desktopVisible}
            sessionUsername={sessionUsername}
            mobileHomeDate={mobileHomeDate}
            onLockSession={lockSession}
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
