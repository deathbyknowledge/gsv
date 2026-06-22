import type { RefObject } from "preact";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { SessionSnapshot } from "../../services/session/sessionService";
import { useDesktopAppsSync } from "../desktop/useDesktopAppsSync";
import { useDesktopRuntime, type DesktopRuntime } from "../desktop/useDesktopRuntime";
import { usePackageApps } from "../packages/usePackageApps";

type UseLegacyPackageRuntimeOptions = {
  shellRef: RefObject<HTMLDivElement>;
  windowsLayerRef: RefObject<HTMLElement>;
  gatewayClient: GSVClient;
  connected: boolean;
  standalone: boolean;
  sessionPhase: SessionSnapshot["phase"];
};

type UseLegacyPackageRuntimeResult = {
  runtimeRef: RefObject<DesktopRuntime | null>;
};

export function useLegacyPackageRuntime({
  shellRef,
  windowsLayerRef,
  gatewayClient,
  connected,
  standalone,
  sessionPhase,
}: UseLegacyPackageRuntimeOptions): UseLegacyPackageRuntimeResult {
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

  useDesktopAppsSync({
    runtimeRef,
    runtimeRevision,
    apps: packageApps.data,
    connected,
    appLoadFailed: packageApps.isError,
    sessionPhase,
  });

  return { runtimeRef };
}
