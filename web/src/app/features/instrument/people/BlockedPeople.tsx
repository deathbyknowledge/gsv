import type { ContactBlockListArgs } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useInfiniteQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACT_BLOCKS_KEY } from "../wire/queryKeys";

const NO_CURSOR: ContactBlockListArgs["cursor"] = undefined;

export function BlockedPeople({ account }: { account: ConsoleAccount | undefined }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const allowed = (call: string) => connected && !!account && canConfigure(account, call);
  const blocks = useInfiniteQuery({
    queryKey: [...INSTRUMENT_CONTACT_BLOCKS_KEY, "list"], enabled: allowed("contact.block.list"),
    initialPageParam: NO_CURSOR, queryFn: ({ pageParam }) => client.contact.block.list({ cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const unblock = useMutation({
    mutationFn: (actor: NonNullable<ContactBlockListArgs["actor"]>) => client.contact.block.set({ actor, blocked: false }),
    onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACT_BLOCKS_KEY }),
  });
  const entries = blocks.data?.pages.flatMap((page) => page.blocks) ?? [];
  return <section aria-label="Blocked people">
    <p class="people-note">Unblocking allows new requests. Old connections stay ended.</p>
    {blocks.isLoading && <LoadingState>Loading…</LoadingState>}
    {blocks.data && !entries.length && <p class="people-note">No blocked people.</p>}
    {entries.map((entry) => <div class="people-block-entry" key={`${entry.actor.shipId}/${entry.actor.subjectId}`}>
      <div class="people-actions"><span>{entry.displayName ?? "Blocked identity"}</span><button class="people-action" disabled={!allowed("contact.block.set") || unblock.isPending} onClick={() => unblock.mutate(entry.actor)}>unblock</button></div>
      <details><summary>identity</summary><p>{entry.actor.shipId}<br />{entry.actor.subjectId}</p></details>
    </div>)}
    {blocks.hasNextPage && <button class="people-action" disabled={blocks.isFetchingNextPage} onClick={() => void blocks.fetchNextPage()}>more</button>}
    {(blocks.error ?? unblock.error) && <p class="people-error" role="alert">{(blocks.error ?? unblock.error)?.message}</p>}
  </section>;
}
