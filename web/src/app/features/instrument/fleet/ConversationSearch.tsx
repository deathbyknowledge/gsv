import { useInfiniteQuery } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { instrumentContactConversationKey } from "../wire/queryKeys";

const FIRST_PAGE: number | null = null;

export function ConversationSearch({ conversationId, onOpen }: { conversationId: string; onOpen: (sequence: number) => void }) {
  const { client, connected } = useGateway();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const search = useInfiniteQuery({
    queryKey: [...instrumentContactConversationKey(conversationId), "search", query],
    enabled: expanded && connected && !!query,
    initialPageParam: FIRST_PAGE,
    queryFn: ({ pageParam }) => client.conversation.search({ conversationId, query, beforeSequence: pageParam ?? undefined, limit: 25 }),
    getNextPageParam: (page) => page.nextBeforeSequence,
    refetchInterval: (state) => expanded && state.state.data?.pages[0]?.coverage.state === "building" ? 2_000 : false,
  });
  const coverage = search.data?.pages[0]?.coverage;
  const matches = search.data?.pages.flatMap((page) => page.matches) ?? [];
  return <details class="fleet-conversation-search" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>Search this conversation</summary>
    <form class="fleet-place-form" onSubmit={(event) => {
      event.preventDefault();
      const next = draft.trim();
      if (!next) return;
      if (next === query) void search.refetch();
      else setQuery(next);
    }}>
      <label>Find messages<input type="search" value={draft} maxLength={512} placeholder="Words to find…" onInput={(event) => setDraft(event.currentTarget.value)} /></label>
      <button class="fleet-text-action" type="submit" disabled={!connected || !draft.trim()}>search</button>
    </form>
    {query && connected && search.isPending && <LoadingState>Searching…</LoadingState>}
    {search.error && <p class="error" role="alert">{search.error.message}</p>}
    {coverage?.state === "building" && <p class="note" role="status">Still indexing older messages. Results may be incomplete.</p>}
    {coverage?.state === "limited" && <p class="note">Some messages aren’t fully searchable. The full conversation remains available.</p>}
    {coverage?.state === "error" && <p class="note">Older messages couldn’t be indexed. Search again to retry.</p>}
    {search.data && !matches.length && <p class="note">{coverage?.state === "complete" ? "No matching messages." : "No matches in the text indexed so far."}</p>}
    <ol class="fleet-conversation-search-results">{matches.map((match) => <li key={match.messageId}>
      <button type="button" onClick={() => { onOpen(match.sequence); setExpanded(false); }}>
        <time dateTime={new Date(match.createdAt).toISOString()}>{new Date(match.createdAt).toLocaleDateString()}</time>
        <span>{match.excerpt}</span>
      </button>
    </li>)}</ol>
    {search.hasNextPage && <button class="fleet-text-action" type="button" disabled={search.isFetching} onClick={() => void search.fetchNextPage()}>{search.isFetchingNextPage ? "loading…" : "more matches"}</button>}
  </details>;
}
