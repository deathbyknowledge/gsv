import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/preact-query";
import type { ConversationAttentionDismissArgs, ConversationAttentionListArgs } from "@humansandmachines/gsv/protocol";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_ATTENTION_KEY } from "../wire/queryKeys";
import { refreshContactQuery } from "../wire/contactSync";

const START: ConversationAttentionListArgs["before"] = undefined;

export function ConversationAttention({ account, onOpen }: { account?: ConsoleAccount; onOpen: (contactId: string) => void }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const mayRead = !!account && account.uid >= 1000 && canConfigure(account, "conversation.attention.list");
  const mayDismiss = connected && !!account && account.uid >= 1000 && canConfigure(account, "conversation.attention.dismiss");
  const query = useInfiniteQuery({
    queryKey: [...INSTRUMENT_ATTENTION_KEY, "pages"], enabled: connected && mayRead,
    initialPageParam: START, queryFn: ({ pageParam }) => client.conversation.attention.list({ before: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.next,
  });
  const dismiss = useMutation({ mutationFn: (entries: ConversationAttentionDismissArgs["entries"]) => client.conversation.attention.dismiss({ entries }),
    onSuccess: () => refreshContactQuery(cache, INSTRUMENT_ATTENTION_KEY) });
  const entries = [...new Map((query.data?.pages.flatMap((page) => page.entries) ?? []).map((entry) => [entry.conversationId, entry])).values()];
  const summary = query.data?.pages[0];
  return <section class="people-attention" aria-label="Message alerts and digest">
    <div class="people-kicker">At your pace</div><h2>Catch up</h2>
    <p class="people-note">Messages you asked to hear about. Dismissing an alert leaves the conversation unread. These preferences and actions stay in your space.</p>
    {!mayRead && <p class="people-note">This account cannot read message alerts.</p>}
    {query.isPending && connected && mayRead && <LoadingState variant="panel">Loading alerts…</LoadingState>}
    {(query.error ?? dismiss.error) && <p class="people-error" role="alert">{(query.error ?? dismiss.error)?.message}</p>}
    {summary && !entries.length && <p class="people-attention-empty">You’re caught up on alerts. Your inbox still keeps all your conversations.</p>}
    {!!summary?.digestWaitingCount && <p class="people-note">{summary.digestWaitingCount} {summary.digestWaitingCount === 1 ? "conversation is" : "conversations are"} gathering for your digest.
      {summary.nextDigestAt && <> Next batch: {new Date(summary.nextDigestAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.</>}</p>}
    <ol class="people-attention-list">{entries.map((entry) => <li key={entry.conversationId}>
      <div class="people-attention-meta"><span>{entry.kind === "digest" ? "From your digest" : "New message"}</span><time dateTime={new Date(entry.preview.createdAt).toISOString()}>{new Date(entry.preview.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></div>
      <h3><button class="people-action" onClick={() => onOpen(entry.contactId)}>{entry.displayName}</button></h3>
      <p class="people-attention-preview">{entry.preview.text || (entry.preview.attachmentCount ? "Attachment" : "Message")}</p>
      <div class="people-actions"><button class="people-action" onClick={() => onOpen(entry.contactId)}>open conversation</button>
        <button class="people-action" disabled={!mayDismiss || dismiss.isPending} onClick={() => dismiss.mutate([{ conversationId: entry.conversationId, throughSequence: entry.throughSequence }])}>dismiss alert</button></div>
    </li>)}</ol>
    {query.hasNextPage && <button class="people-action" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "loading…" : "earlier alerts"}</button>}
    {!connected && <p class="people-note" role="status">Reconnecting…</p>}
  </section>;
}
