import type { QueryClient } from "@tanstack/preact-query";
import { INSTRUMENT_MESSENGERS_KEY } from "./queryKeys";

/** Replace active connection snapshots after an owner-scoped adapter status notice. */
export async function refreshMessengerConnections(cache: QueryClient): Promise<void> {
  const filter = { queryKey: INSTRUMENT_MESSENGERS_KEY };
  await cache.cancelQueries(filter);
  await cache.invalidateQueries(filter);
}
