import { memo } from "preact/compat";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConversationHistoryArgs, ConversationSearchHit } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useQuery } from "../../../services/navigation/viewQueries";
import { Spinner } from "../../../components/ui/Spinner";
import { ZenText } from "../zen/ZenText";
import { ZenMedia } from "../zen/ZenMedia";

export const ConversationSearch = memo(function ConversationSearch({ conversationId, timeZone, onClose }: {
  conversationId: string;
  timeZone: string;
  onClose(): void;
}) {
  const { client, connected } = useGateway();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const backdropPress = useRef(false);
  const [query, setQuery] = useState("");
  const [settled, setSettled] = useState("");
  const [pages, setPages] = useState<number[]>([]);
  const [selected, setSelected] = useState(0);
  const [opened, setOpened] = useState<ConversationSearchHit | null>(null);
  const date = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }), [timeZone]);
  const search = useQuery({
    queryKey: ["conversation-search", conversationId, settled, pages.at(-1)],
    enabled: connected && settled.length > 0 && !opened,
    queryFn: () => client.conversation.search({ conversationId, query: settled, beforeSequence: pages.at(-1), limit: 20 }),
    retry: false,
  });
  const hits = search.data?.hits ?? [];
  const pending = query.trim() !== settled || search.isFetching;
  const fresh = query.trim() === settled;
  useEffect(() => {
    const timer = window.setTimeout(() => { setSettled(query.trim()); setPages([]); setSelected(0); }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    input.current?.focus();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useLayoutEffect(() => {
    const option = dialog.current?.querySelector<HTMLElement>(`[data-search-index="${selected}"]`);
    option?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const outside = (event: MouseEvent | PointerEvent) => {
    const element = dialog.current;
    if (!element || event.target !== element) return false;
    const bounds = element.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };

  return <dialog ref={dialog} class="zen-search-dialog" aria-label="Search conversation" data-instrument-dialog
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { backdropPress.current = outside(event); }}
    onClick={(event) => { if (backdropPress.current && outside(event)) onClose(); backdropPress.current = false; }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (opened || event.target !== input.current) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((index) => Math.max(0, Math.min(hits.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
      } else if (event.key === "Enter" && fresh && hits[selected]) {
        event.preventDefault(); setOpened(hits[selected]);
      }
    }}>
    <header class="zen-search-head">
      {opened ? <button type="button" onClick={() => { setOpened(null); requestAnimationFrame(() => input.current?.focus()); }}>← results</button>
        : <input ref={input} type="search" value={query} maxLength={256} placeholder="Search conversation" aria-label="Search conversation"
          role="combobox" aria-autocomplete="list" aria-expanded={hits.length > 0 && fresh} aria-controls="zen-search-results"
          aria-activedescendant={hits[selected] && fresh ? `zen-search-hit-${selected}` : undefined}
          onInput={(event) => setQuery(event.currentTarget.value)} />}
      {!opened && pending && <span role="status" aria-label="Searching"><Spinner size={16} /></span>}
      <button type="button" onClick={onClose}>close <kbd>esc</kbd></button>
    </header>
    {opened ? <ConversationExcerpt conversationId={conversationId} hit={opened} date={date} /> : <>
      <div class="zen-search-results">
        {search.isError && fresh ? <p role="alert">{String(search.error).match(/unknown syscall|not implemented|unsupported/i)
          ? "Search isn’t available on this space yet." : "Search could not be completed."} <button type="button" onClick={() => void search.refetch()}>retry</button></p> : null}
        <div id="zen-search-results" role="listbox" aria-label="Matching messages">
          {fresh && hits.map((hit, index) => <button type="button" key={hit.id} id={`zen-search-hit-${index}`} data-search-index={index}
            class={`zen-search-hit${index === selected ? " is-selected" : ""}`} role="option" aria-selected={index === selected}
            onMouseEnter={() => setSelected(index)} onClick={() => setOpened(hit)}>
            <span class="zen-search-byline"><span>{hit.author.kind === "user" ? "you" : hit.author.kind === "contact" ? hit.author.displayName : "GSV"}</span>
              <time dateTime={new Date(hit.createdAt).toISOString()}>{date.format(hit.createdAt)}</time></span>
            <span class="zen-search-snippet">{hit.snippet}</span>
          </button>)}
        </div>
        {fresh && settled && !pending && !search.isError && !hits.length ? <p>No matches.</p> : null}
      </div>
      <footer class="zen-search-footer">
        <span>↑ ↓ select · enter open</span>
        {pages.length > 0 && <button type="button" onClick={() => { setPages((pages) => pages.slice(0, -1)); setSelected(0); }}>newer</button>}
        {search.data?.nextBeforeSequence != null && fresh && <button type="button"
          onClick={() => { setPages((pages) => [...pages, search.data!.nextBeforeSequence!]); setSelected(0); }}>older</button>}
      </footer>
    </>}
  </dialog>;
});

function ConversationExcerpt({ conversationId, hit, date }: {
  conversationId: string;
  hit: ConversationSearchHit;
  date: Intl.DateTimeFormat;
}) {
  const { client } = useGateway();
  const body = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<Pick<ConversationHistoryArgs, "beforeSequence" | "afterSequence"> | null>(null);
  const history = useQuery({
    queryKey: ["conversation-excerpt", conversationId, hit.sequence, page],
    queryFn: async () => {
      if (page) return client.conversation.history({ conversationId, ...page, limit: 16 });
      const [before, after] = await Promise.all([
        client.conversation.history({ conversationId, beforeSequence: hit.sequence + 1, limit: 8 }),
        client.conversation.history({ conversationId, afterSequence: hit.sequence, limit: 8 }),
      ]);
      return { ...before, conversation: after.conversation, messages: [...before.messages, ...after.messages] };
    },
    retry: false,
  });
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || !history.data) return;
    const selected = Array.from(element.querySelectorAll<HTMLElement>("[data-message-id]")).find((node) => node.dataset.messageId === hit.id);
    if (selected) selected.scrollIntoView({ block: "center" });
    else element.scrollTop = page?.beforeSequence !== undefined ? element.scrollHeight : 0;
  }, [history.data, hit.id, page]);
  const messages = history.data?.messages ?? [];
  return <>
    <div class="zen-search-excerpt" ref={body} aria-busy={history.isFetching}>
      {history.isLoading && <span role="status" aria-label="Loading messages"><Spinner /></span>}
      {history.isError && <p role="alert">Messages could not be loaded. <button type="button" onClick={() => void history.refetch()}>retry</button></p>}
      {messages.map((message) => <article key={message.id} data-message-id={message.id} class={message.id === hit.id ? "is-match" : ""}>
        <div class="zen-search-byline"><span>{message.author.kind === "user" ? "you" : message.author.kind === "contact" ? message.author.displayName : "GSV"}</span>
          <time dateTime={new Date(message.createdAt).toISOString()}>{date.format(message.createdAt)}</time></div>
        <ZenText text={message.text} markdown={message.author.kind !== "user"} progress={null} tick={0} />
        {message.media?.map((media, index) => <ZenMedia key={index} media={media} processId={message.processId ?? ""} />)}
      </article>)}
    </div>
    <footer class="zen-search-footer">
      {history.data?.hasMore && messages[0] && <button type="button" disabled={history.isFetching}
        onClick={() => setPage({ beforeSequence: messages[0].sequence })}>earlier messages</button>}
      {history.data && messages.at(-1) && messages.at(-1)!.sequence < history.data.conversation.latestSequence && <button type="button" disabled={history.isFetching}
        onClick={() => setPage({ afterSequence: messages.at(-1)!.sequence })}>later messages</button>}
    </footer>
  </>;
}
