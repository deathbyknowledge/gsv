import { useCallback, useEffect, useMemo, useRef } from "preact/hooks";
import { useSession } from "../../services/session/SessionProvider";
import { SessionScreens } from "../session/SessionScreens";
import { GsvShell } from "../gsv-shell/GsvShell";
import { TextClientShell } from "../text-client/TextClientShell";

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
  const standalone = useMemo(isStandaloneDisplay, []);
  const mobileHomeDate = useMemo(formatMobileHomeDate, []);
  // `/` is the text client. Every existing deep link remains owned by the
  // classic operational shell, including links it pushes without remounting.
  const classicShell = window.location.pathname !== "/";

  useEffect(() => {
    void sessionService.start();
  }, [sessionService]);
  const desktopVisible = sessionSnapshot.phase === "ready";
  const sessionUsername = sessionSnapshot.username || "operator";
  const lockSession = useCallback((): void => {
    sessionService.lock();
  }, [sessionService]);
  return (
    <div class="app-shell-root">
      <div class={`gsv-native-shell${standalone ? " is-standalone" : ""}`} ref={shellRef}>
        <SessionScreens session={sessionService} snapshot={sessionSnapshot} />
        {classicShell ? (
          <GsvShell
            desktopVisible={desktopVisible}
            sessionUsername={sessionUsername}
            mobileHomeDate={mobileHomeDate}
            onLockSession={lockSession}
          />
        ) : desktopVisible ? (
          <TextClientShell username={sessionUsername} onLock={lockSession} />
        ) : null}
      </div>
    </div>
  );
}
