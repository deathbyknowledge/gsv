import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import type { ActorRef, ContactBlockListArgs } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACTS_KEY } from "../wire/queryKeys";

const START: ContactBlockListArgs["cursor"] = undefined;

export function BlockedPeople({ account }: { account?: ConsoleAccount }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [confirm, setConfirm] = useState<ActorRef | null>(null);
  const allowed = (call: string) => connected && !!account && canConfigure(account, call);
  const blocks = useInfiniteQuery({
    queryKey: [...INSTRUMENT_CONTACTS_KEY, "blocked"], enabled: allowed("contact.block.list"),
    initialPageParam: START,
    queryFn: ({ pageParam }) => client.contact.block.list({ cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const unblock = useMutation({
    mutationFn: (actor: ActorRef) => client.contact.block.set({ actor, blocked: false }),
    onSuccess: async () => { setConfirm(null); await cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY }); },
  });
  const entries = blocks.data?.pages.flatMap((page) => page.blocks) ?? [];
  return <section class="people-blocks" aria-labelledby="blocked-people-title">
    <div class="people-kicker">Private controls</div><h1 id="blocked-people-title">Blocked identities</h1>
    <p class="people-note">These identities cannot message you or request a conversation. This list stays in your space. Unblocking permits a fresh request; it does not reopen the old connection.</p>
    {!allowed("contact.block.list") && <p class="people-note">Connect with an account that can manage blocks to view this list.</p>}
    {blocks.isFetching && !blocks.data && <LoadingState>Loading blocked identities…</LoadingState>}
    {blocks.data && !entries.length && <p class="people-note">No blocked identities.</p>}
    <ul class="people-block-list">{entries.map(({ actor, createdAtMs, displayName, origin }) => <li key={`${actor.shipId}/${actor.subjectId}`}>
      <h2>{displayName || "Unnamed identity"}</h2>{origin && <p class="people-note">{origin}</p>}
      <time>Blocked {new Date(createdAtMs).toLocaleDateString()}</time>
      <details><summary>Identity</summary><dl><dt>Space identity</dt><dd>{actor.shipId}</dd><dt>Person identity</dt><dd>{actor.subjectId}</dd></dl></details>
      {confirm?.shipId === actor.shipId && confirm.subjectId === actor.subjectId ? <>
        <p>Allow this identity to request a new conversation?</p><div class="people-message-actions"><button class="people-action" disabled={unblock.isPending || !allowed("contact.block.set")} onClick={() => unblock.mutate(actor)}>confirm unblock</button><button class="people-action" disabled={unblock.isPending} onClick={() => setConfirm(null)}>cancel</button></div>
      </> : <button class="people-action" disabled={unblock.isPending || !allowed("contact.block.set")} onClick={() => setConfirm(actor)}>unblock</button>}
    </li>)}</ul>
    {blocks.hasNextPage && <button class="people-action" disabled={blocks.isFetchingNextPage} onClick={() => void blocks.fetchNextPage()}>more blocked identities</button>}
    {(blocks.error ?? unblock.error) && <p class="people-error" role="alert">{(blocks.error ?? unblock.error)?.message}</p>}
  </section>;
}
