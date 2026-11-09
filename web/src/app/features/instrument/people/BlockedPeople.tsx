import type { ContactBlockListArgs } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";
import { useInfiniteQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACT_BLOCKS_KEY } from "../wire/queryKeys";
import { useT } from "../../../i18n/locale";
import { LoadOnScroll } from "./LoadOnScroll";

const NO_CURSOR: ContactBlockListArgs["cursor"] = undefined;

/**
 * The people you blocked whose name contains `filter`. With `loadAll`, a filter loads every page,
 * so someone on a later page is still found; only one reader of the list should load it.
 */
export function useBlockedPeople(account: ConsoleAccount | undefined, filter: string, loadAll: boolean) {
  const t = useT();
  const { client, connected } = useGateway();
  const blocks = useInfiniteQuery({
    queryKey: [...INSTRUMENT_CONTACT_BLOCKS_KEY, "list"], enabled: connected && !!account && canConfigure(account, "contact.block.list"),
    initialPageParam: NO_CURSOR, queryFn: ({ pageParam }) => client.contact.block.list({ cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const query = filter.trim().toLocaleLowerCase();
  useEffect(() => {
    if (loadAll && query && blocks.hasNextPage && !blocks.isFetchingNextPage && !blocks.isFetchNextPageError) void blocks.fetchNextPage();
  }, [loadAll, query, blocks.hasNextPage, blocks.isFetchingNextPage, blocks.isFetchNextPageError]);
  const entries = (blocks.data?.pages.flatMap((page) => page.blocks) ?? [])
    .filter((entry) => (entry.displayName ?? t("people.blocked.unknown")).toLocaleLowerCase().includes(query));
  // A filtered search is unresolved until every page arrived; a failed page keeps it so until its retry succeeds.
  return { blocks, entries, searching: !!query && (blocks.isFetching || blocks.hasNextPage || blocks.isError) };
}

/** The people you blocked, under the contacts list; it shows only once someone is blocked. */
export function BlockedPeople({ account, filter }: { account: ConsoleAccount | undefined; filter: string }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const { blocks, entries } = useBlockedPeople(account, filter, true);
  const unblock = useMutation({
    mutationFn: (did: string) => client.contact.block.set({ did, blocked: false }),
    onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACT_BLOCKS_KEY }),
  });
  const error = blocks.error ?? unblock.error;
  if (!entries.length && !error) return null;
  return <section class="people-blocked" aria-labelledby="people-blocked-title">
    <h2 id="people-blocked-title">{t("people.blocked.title")}</h2>
    <p class="people-note">{t("people.blocked.hint")}</p>
    {entries.map((entry) => <div class="people-block-entry" key={entry.did}>
      <div class="people-actions"><span>{entry.displayName ?? t("people.blocked.unknown")}</span><button class="people-action" disabled={!connected || !account || !canConfigure(account, "contact.block.set") || unblock.isPending} onClick={() => unblock.mutate(entry.did)}>{t("people.unblock")}</button></div>
      <details><summary>{t("people.blocked.identity")}</summary><p>{entry.did}</p></details>
    </div>)}
    {/* A filter loads the rest itself; a page that fails still offers its retry. */}
    {blocks.hasNextPage && (!filter.trim() || blocks.isFetchNextPageError) && <LoadOnScroll pages={blocks.data?.pages.length ?? 0} loading={blocks.isFetchingNextPage} failed={blocks.isFetchNextPageError} onLoad={() => void blocks.fetchNextPage()} />}
    {error && <p class="people-error" role="alert">{error.message}</p>}
  </section>;
}
