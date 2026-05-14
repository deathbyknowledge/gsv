import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { errorToText } from "../../utils/format";
import {
  buildOverviewModel,
  type OverviewModel,
  type OverviewSnapshot,
  type OverviewSurface,
  type OverviewSurfaceError,
} from "./overview-domain";

export type OverviewRuntime = {
  model: OverviewModel | null;
  loading: boolean;
  errorText: string | null;
  refresh(): Promise<void>;
};

export function useOverview(backend: GsvBackend): OverviewRuntime {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);

  const model = useMemo(() => snapshot ? buildOverviewModel(snapshot) : null, [snapshot]);
  const errorText = snapshot && snapshot.errors.length > 0
    ? `${snapshot.errors.length} overview surface${snapshot.errors.length === 1 ? "" : "s"} failed to load.`
    : null;

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);

    const nextSnapshot = await loadOverviewSnapshot(backend);
    if (requestIdRef.current !== requestId) {
      return;
    }

    setSnapshot(nextSnapshot);
    setLoading(false);
  }, [backend]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    model,
    loading,
    errorText,
    refresh,
  };
}

async function loadOverviewSnapshot(backend: GsvBackend): Promise<OverviewSnapshot> {
  const loadedAt = Date.now();
  const [
    runtime,
    devices,
    packages,
    adapters,
    mcp,
    administration,
  ] = await Promise.allSettled([
    loadSurface(() => backend.loadRuntimeState()),
    loadSurface(() => backend.loadDevicesState({})),
    loadSurface(() => backend.loadPackagesState({})),
    loadSurface(() => backend.loadAdaptersState()),
    loadSurface(() => backend.loadMcpState()),
    loadSurface(() => backend.loadAdministrationState({})),
  ]);

  const errors: OverviewSurfaceError[] = [];
  return {
    runtime: valueOrNull(runtime, "runtime", "Runtime", errors),
    devices: valueOrNull(devices, "devices", "Devices", errors),
    packages: valueOrNull(packages, "packages", "Packages", errors),
    adapters: valueOrNull(adapters, "adapters", "Message adapters", errors),
    mcp: valueOrNull(mcp, "mcp", "MCP servers", errors),
    administration: valueOrNull(administration, "administration", "Administration", errors),
    errors,
    loadedAt,
  };
}

function loadSurface<T>(task: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(task);
}

function valueOrNull<T>(
  result: PromiseSettledResult<T>,
  surface: OverviewSurface,
  label: string,
  errors: OverviewSurfaceError[],
): T | null {
  if (result.status === "fulfilled") {
    return result.value;
  }
  errors.push({
    surface,
    label,
    message: errorToText(result.reason),
  });
  return null;
}
