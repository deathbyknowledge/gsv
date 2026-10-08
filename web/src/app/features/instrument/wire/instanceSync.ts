import type { QueryClient } from "@tanstack/preact-query";
import { INSTANCE_QUERY_KEY, INSTRUMENT_TARGETS_KEY } from "./queryKeys";

/** Invalidate the shared inventory even when Fleet and the browser viewer are closed. */
export async function syncInstanceSignal(cache: QueryClient): Promise<void> {
  await Promise.all([INSTANCE_QUERY_KEY, INSTRUMENT_TARGETS_KEY, ["cloud-instance"]].map(async queryKey => {
    if (cache.getQueryCache().findAll({ queryKey }).length === 0) return;
    await cache.cancelQueries({ queryKey });
    await cache.invalidateQueries({ queryKey });
  }));
}
