import type { QueryClient } from "@tanstack/preact-query";
import type { z } from "zod";
import type { ConsoleProcess } from "../../gsv-console/domain/consoleModels";
import { INSTRUMENT_PROCESSES_KEY } from "./queryKeys";
import { patchProcesses, type ProcessSignalName, type procSignalSchema } from "./wireModel";

/** State patches are local; new records, changed labels and interrupted snapshots need a fresh list. */
export async function syncProcessSignal(cache: QueryClient, signal: ProcessSignalName, payload: z.infer<typeof procSignalSchema>): Promise<void> {
  if (signal === "proc.changed" && !payload.runtime && !payload.changes?.some((change) => change === "created" || change === "title")) return;
  const filter = { queryKey: INSTRUMENT_PROCESSES_KEY, exact: true };
  const state = cache.getQueryState(filter.queryKey);
  if (!state) return;
  const current = cache.getQueryData<ConsoleProcess[]>(filter.queryKey);
  const patch = current ? patchProcesses(current, signal, payload) : null;
  const reload = !patch || !patch.known || payload.changes?.includes("title") || state.fetchStatus === "fetching";
  const cancelled = reload ? cache.cancelQueries(filter, { revert: false }) : undefined;
  cache.setQueryData<ConsoleProcess[]>(filter.queryKey, (latest) => latest ? patchProcesses(latest, signal, payload).next : undefined);
  if (reload) {
    await cancelled;
    await cache.invalidateQueries(filter);
  }
}
