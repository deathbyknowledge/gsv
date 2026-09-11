import { useEffect, useState } from "preact/hooks";
import { isCancelledError, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { spawnChatProcess } from "../../../services/chat/backend/chatService";
import { loadConsoleProcesses } from "../../../services/system/consoleService";
import { INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";

/** Ship follows its owner's personal process; an explicit helper keeps its exact identity. */
export function useZenProcess(pidProp: string | null | undefined, onError: (message: string) => void): string | null {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [ship, setShip] = useState<{ pid: string; ownerUid: number | null } | null>(null);
  const processes = useQuery({
    queryKey: INSTRUMENT_PROCESSES_KEY,
    queryFn: () => loadConsoleProcesses(client),
    enabled: connected && !pidProp,
  });

  /* the personal process, spawned if the account has none yet */
  useEffect(() => {
    if (!connected || pidProp) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const current = await cache.fetchQuery({
          queryKey: INSTRUMENT_PROCESSES_KEY,
          queryFn: () => loadConsoleProcesses(client),
          staleTime: Infinity,
        });
        const personal = current.find((process) => process.personal) ?? current.find((process) => process.interactive);
        if (personal) {
          if (!cancelled) setShip({ pid: personal.pid, ownerUid: personal.uid });
          return;
        }
        const spawned = await spawnChatProcess(client, { interactive: true, label: "ship" });
        if (!cancelled) setShip({ pid: spawned.pid, ownerUid: null });
      } catch (error) {
        if (!cancelled && !isCancelledError(error)) onError(error instanceof Error ? error.message : "Could not reach your ship.");
      }
    })();
    return () => { cancelled = true; };
  }, [cache, client, connected, onError, pidProp]);

  if (pidProp) return pidProp;
  const personal = processes.data?.find((process) => process.personal
    && (ship?.ownerUid === null || ship === null || process.uid === ship.ownerUid));
  return personal?.pid ?? ship?.pid ?? null;
}
