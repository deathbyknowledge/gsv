import {
  useQuery as useCachedQuery,
  useInfiniteQuery as useCachedInfiniteQuery,
  type DefaultError, type InfiniteData, type QueryClient, type QueryKey,
  type UseQueryOptions, type UseInfiniteQueryOptions,
} from "@tanstack/preact-query";
import { useViewActive } from "./ViewActivity";

/** Hidden views retain cache entries while pausing UI notifications and background reads. */
export function useQuery<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TQueryKey extends QueryKey = QueryKey>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  client?: QueryClient,
) {
  const active = useViewActive();
  return useCachedQuery({ ...options, enabled: active ? options.enabled : false, notifyOnChangeProps: active ? options.notifyOnChangeProps : [] }, client);
}

export function useInfiniteQuery<TQueryFnData, TError = DefaultError, TData = InfiniteData<TQueryFnData>, TQueryKey extends QueryKey = QueryKey, TPageParam = unknown>(
  options: UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>,
  client?: QueryClient,
) {
  const active = useViewActive();
  return useCachedInfiniteQuery({ ...options, enabled: active ? options.enabled : false, notifyOnChangeProps: active ? options.notifyOnChangeProps : [] }, client);
}
