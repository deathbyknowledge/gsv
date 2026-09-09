import type { QueryClient, QueryKey } from "@tanstack/preact-query";

/** Discard any older snapshot, including an initial read that has not resolved. */
export async function refreshContactQuery(cache: QueryClient, queryKey: QueryKey): Promise<void> {
  const filter = { queryKey, exact: true };
  await cache.cancelQueries(filter);
  await cache.invalidateQueries(filter);
}
