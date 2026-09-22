import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/preact-query";
import type { ApproachListArgs, ConversationAttentionDismissArgs, ConversationAttentionListArgs } from "@humansandmachines/gsv/protocol";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_APPROACHES_KEY, INSTRUMENT_ATTENTION_KEY } from "../wire/queryKeys";
import { refreshContactQuery } from "../wire/contactSync";
import { approachStatus } from "./peopleModel";

const START: ConversationAttentionListArgs["before"] = undefined;
const REQUEST_START: ApproachListArgs["before"] = undefined;

export function ConversationAttention({ account, onOpen, onOpenRequest }: {
  account?: ConsoleAccount; onOpen: (contactId: string) => void; onOpenRequest: (approachId: string) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const mayRead = !!account && account.uid >= 1000 && canConfigure(account, "conversation.attention.list");
  const mayDismiss = connected && !!account && account.uid >= 1000 && canConfigure(account, "conversation.attention.dismiss");
  const mayReadRequests = !!account && account.uid >= 1000 && canConfigure(account, "approach.list");
  const query = useInfiniteQuery({
    queryKey: [...INSTRUMENT_ATTENTION_KEY, "pages"], enabled: connected && mayRead,
    initialPageParam: START, queryFn: ({ pageParam }) => client.conversation.attention.list({ before: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.next,
  });
  const requests = useInfiniteQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "attention-pages"], enabled: connected && mayReadRequests,
    initialPageParam: REQUEST_START,
    queryFn: ({ pageParam }) => client.approach.list({ direction: "incoming", status: "active", before: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.next,
  });
  const dismiss = useMutation({ mutationFn: (entries: ConversationAttentionDismissArgs["entries"]) => client.conversation.attention.dismiss({ entries }),
    onSuccess: () => refreshContactQuery(cache, INSTRUMENT_ATTENTION_KEY) });
  const entries = mayRead ? [...new Map((query.data?.pages.flatMap((page) => page.entries) ?? []).map((entry) => [entry.conversationId, entry])).values()] : [];
  const incoming = mayReadRequests ? [...new Map((requests.data?.pages.flatMap((page) => page.approaches) ?? []).map((entry) => [entry.id, entry])).values()] : [];
  const summary = mayRead ? query.data?.pages[0] : undefined;
  const caughtUp = (mayRead || mayReadRequests) && (!mayRead || query.isSuccess) && (!mayReadRequests || requests.isSuccess) && !entries.length && !incoming.length;
  return <section class="people-attention" aria-label="Message requests, alerts and digest">
    <div class="people-kicker">At your pace</div><h2>Catch up</h2>
    <p class="people-note">Message requests waiting for your decision, and conversations you asked to hear about. Dismissing an alert leaves the conversation unread.</p>
    {requests.isPending && connected && mayReadRequests && <LoadingState variant="panel">Loading message requests…</LoadingState>}
    {requests.error && mayReadRequests && <p class="people-error" role="alert">{requests.error.message} <button class="people-action" disabled={!connected} onClick={() => void requests.refetch()}>retry requests</button></p>}
    {incoming.length > 0 && <section aria-label="Message requests waiting for you">
      <h3>Message requests <span class="people-note">· {requests.data?.pages[0]?.total}</span></h3>
      <p class="people-note">Review the first message before accepting a conversation. Your Ship hasn’t been asked to respond.</p>
      <ol class="people-attention-list">{incoming.map((request) => <li key={request.id}>
        <div class="people-attention-meta"><span>Message request</span><time dateTime={new Date(request.createdAtMs).toISOString()}>{new Date(request.createdAtMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></div>
        <h3><button class="people-action" onClick={() => onOpenRequest(request.id)}>{request.displayName}</button></h3>
        <p class="people-note">{approachStatus(request)}</p>
        <button class="people-action" onClick={() => onOpenRequest(request.id)}>review message request →</button>
      </li>)}</ol>
      {requests.hasNextPage && <button class="people-action" disabled={requests.isFetchingNextPage} onClick={() => void requests.fetchNextPage()}>{requests.isFetchingNextPage ? "loading…" : "earlier message requests"}</button>}
    </section>}
    {!mayRead && !mayReadRequests && <p class="people-note">This account cannot read message alerts or message requests.</p>}
    {query.isPending && connected && mayRead && <LoadingState variant="panel">Loading alerts…</LoadingState>}
    {(query.error ?? dismiss.error) && <p class="people-error" role="alert">{(query.error ?? dismiss.error)?.message}</p>}
    {caughtUp && <p class="people-attention-empty">You’re caught up on requests and alerts. Your inbox still keeps all your conversations.</p>}
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
