import type { QueryClient } from "@tanstack/preact-query";
import { INSTRUMENT_RESPONSIBILITIES_KEY, INSTRUMENT_ROUTINES_KEY, INSTRUMENT_SOURCES_KEY } from "./queryKeys";

/** A saved change retires older snapshots before refreshing active readers. */
export async function syncWorkSignal(cache: QueryClient, signal: string): Promise<void> {
  const queryKey = signal === "r12y.changed" ? INSTRUMENT_RESPONSIBILITIES_KEY
    : signal === "r12y.source.changed" ? INSTRUMENT_SOURCES_KEY
    : signal === "sched.changed" ? INSTRUMENT_ROUTINES_KEY : null;
  if (!queryKey || cache.getQueryCache().findAll({ queryKey }).length === 0) return;
  await cache.cancelQueries({ queryKey });
  await cache.invalidateQueries({ queryKey });
}
