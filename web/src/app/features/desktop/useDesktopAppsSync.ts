import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";
import type { DesktopApp } from "./domain/desktopApp";
import type { SessionSnapshot } from "../../services/session/sessionService";
import type { DesktopRuntime } from "./useDesktopRuntime";

type UseDesktopAppsSyncOptions = {
  runtimeRef: RefObject<DesktopRuntime | null>;
  runtimeRevision: number;
  apps: readonly DesktopApp[] | undefined;
  connected: boolean;
  appLoadFailed: boolean;
  sessionPhase: SessionSnapshot["phase"];
};

function syncDesktopApps(
  runtimeRef: RefObject<DesktopRuntime | null>,
  apps: readonly DesktopApp[],
): void {
  const runtime = runtimeRef.current;
  if (!runtime) {
    return;
  }
  runtime.windowManager.setAppRegistry(apps);
  runtime.launcher.setApps(apps);
}

export function useDesktopAppsSync({
  runtimeRef,
  runtimeRevision,
  apps,
  connected,
  appLoadFailed,
  sessionPhase,
}: UseDesktopAppsSyncOptions): void {
  useEffect(() => {
    if (!connected && sessionPhase !== "ready") {
      syncDesktopApps(runtimeRef, []);
      return;
    }

    if (connected && appLoadFailed) {
      syncDesktopApps(runtimeRef, []);
      return;
    }

    if (apps) {
      syncDesktopApps(runtimeRef, apps);
    }
  }, [apps, appLoadFailed, connected, runtimeRef, runtimeRevision, sessionPhase]);
}
