import type { QueryClient } from "@tanstack/preact-query";
import { INSTRUMENT_EVENT_SOURCES_KEY, INSTRUMENT_NOTICE_RULES_KEY, INSTRUMENT_RESPONSIBILITIES_KEY, INSTRUMENT_ROUTINES_KEY, INSTRUMENT_SOURCES_KEY } from "./queryKeys";

/** A saved change retires older snapshots before refreshing active readers. */
export async function syncWorkSignal(cache: QueryClient, signal: string): Promise<void> {
  // A notice rule's Ship choice reads the same setting as its responsibility source.
  const queryKeys = signal === "r12y.changed" ? [INSTRUMENT_RESPONSIBILITIES_KEY]
    : signal === "r12y.source.changed" ? [INSTRUMENT_SOURCES_KEY, INSTRUMENT_NOTICE_RULES_KEY]
    : signal === "sched.changed" ? [INSTRUMENT_ROUTINES_KEY]
    : signal === "notify.rule.changed" ? [INSTRUMENT_NOTICE_RULES_KEY]
    : signal === "event.source.changed" ? [INSTRUMENT_EVENT_SOURCES_KEY] : [];
  await Promise.all(queryKeys.map(async (queryKey) => {
    if (cache.getQueryCache().findAll({ queryKey }).length === 0) return;
    await cache.cancelQueries({ queryKey });
    await cache.invalidateQueries({ queryKey });
  }));
}
