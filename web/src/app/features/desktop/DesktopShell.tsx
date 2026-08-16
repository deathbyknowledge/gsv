import { useCallback, useMemo, useRef } from "preact/hooks";
import { useSession } from "../../services/session/SessionProvider";
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
  const standalone = useMemo(isStandaloneDisplay, []);
  const mobileHomeDate = useMemo(formatMobileHomeDate, []);

  const desktopVisible = sessionSnapshot.phase === "ready";
  const sessionUsername = sessionSnapshot.username || "operator";
  const lockSession = useCallback((): void => {
    sessionService.lock();
  }, [sessionService]);
  return (
    <div class="app-shell-root">
      <div class={`gsv-native-shell${standalone ? " is-standalone" : ""}`} ref={shellRef}>
        <SessionScreens session={sessionService} snapshot={sessionSnapshot} />
        <GsvShell
          desktopVisible={desktopVisible}
          sessionUsername={sessionUsername}
          mobileHomeDate={mobileHomeDate}
          onLockSession={lockSession}
        />
      </div>
    </div>
  );
}
