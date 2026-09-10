import type { ContactSummary } from "@humansandmachines/gsv/protocol";
import { useInfiniteQuery } from "@tanstack/preact-query";
import { useLayoutEffect, useRef } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { MAX_STAGED_RESOURCE_BYTES } from "../../../services/gateway/stagedResources";
import type { ConsoleAccount } from "../../gsv-console/domain/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { instrumentContactConversationKey } from "../wire/queryKeys";
import { ZenDraftAttachment, ZenMedia } from "../zen/ZenMedia";
import { zenAttachment } from "../zen/zenAttachments";
import type { ContactDraft } from "./useContactDrafts";

const NO_SEQUENCE: number | null = null;

export type ContactComposerProps = {
  draft: ContactDraft;
  onDraft: (change: Partial<ContactDraft>) => void;
  onSend: () => void;
};

export function ContactConversation({ contact, account, draft, onDraft, onSend }: ContactComposerProps & {
  contact: ContactSummary;
  account: ConsoleAccount | undefined;
}) {
  const { client, connected } = useGateway();
  const mayRead = !!account && canConfigure(account, "conversation.history");
  const maySend = !!account && canConfigure(account, "contact.send")
    && (account.uid === 0 || account.uid === contact.ownerUid) && contact.state === "active";
  const disabled = !connected || !maySend || draft.pending;
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const olderHeight = useRef<number | null>(null);
  const history = useInfiniteQuery({
    queryKey: instrumentContactConversationKey(contact.conversationId),
    enabled: connected && mayRead,
    initialPageParam: NO_SEQUENCE,
    queryFn: ({ pageParam }) => client.conversation.history({
      conversationId: contact.conversationId,
      limit: 50,
      beforeSequence: pageParam ?? undefined,
    }),
    getNextPageParam: (page) => page.hasMore ? page.messages[0]?.sequence : undefined,
  });
  const messages = history.data?.pages.slice().reverse().flatMap((page) => page.messages) ?? [];
  const followLatest = () => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  };
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (olderHeight.current !== null) {
      element.scrollTop += element.scrollHeight - olderHeight.current;
      olderHeight.current = null;
    } else followLatest();
  }, [history.data]);
  const addFiles = (files: readonly File[]) => {
    if (disabled) return;
    if (files.some((file) => file.size > MAX_STAGED_RESOURCE_BYTES)) {
      onDraft({ error: "Each attachment must be 25 MB or smaller." });
      return;
    }
    onDraft({ media: [...draft.media, ...files.map(zenAttachment)], error: null, status: null });
  };

  return <section class="fleet-contact-conversation" aria-label="Contact messages">
    {!mayRead && <p class="note">Your account cannot read this conversation.</p>}
    {mayRead && <div class="fleet-contact-history" ref={scroll} onScroll={(event) => {
      const element = event.currentTarget;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    }}>
      {history.hasNextPage && <button class="contact-link" type="button" disabled={!connected || history.isFetching} onClick={() => {
        olderHeight.current = scroll.current?.scrollHeight ?? null;
        void history.fetchNextPage().then((result) => { if (result.isError) olderHeight.current = null; });
      }}>{history.isFetchingNextPage ? "loading earlier messages…" : "earlier messages"}</button>}
      {history.isPending && connected && <LoadingState variant="panel">Loading messages…</LoadingState>}
      {history.error && <p class="error" role="alert">{history.error.message} <button class="contact-link" disabled={!connected} onClick={() => void history.refetch()}>retry</button></p>}
      {history.data && messages.length === 0 && <p class="note">No messages yet.</p>}
      {messages.map((message) => <article key={message.id} class="fleet-contact-message">
        <header><span>{message.author.kind === "contact" ? message.author.displayName : message.author.kind === "process" ? "Ship" : "you"}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></header>
        {message.text && <p>{message.text}</p>}
        {message.media?.map((media, index) => <ZenMedia key={index} media={media} processId={message.processId ?? ""} onReady={followLatest} />)}
      </article>)}
    </div>}
    <form class="fleet-place-form" onSubmit={(event) => { event.preventDefault(); if (!disabled) onSend(); }} onDragOver={(event) => { if (!disabled) event.preventDefault(); }} onDrop={(event) => {
      event.preventDefault();
      addFiles(Array.from(event.dataTransfer?.files ?? []));
    }}>
      <label>Message<textarea aria-label="Message to contact" placeholder="Write a message…" value={draft.text} disabled={disabled} onInput={(event) => onDraft({ text: event.currentTarget.value, error: null, status: null })} onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!disabled) onSend(); }
      }} onPaste={(event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length) { event.preventDefault(); addFiles(files); }
      }} /></label>
      <input type="file" multiple hidden ref={fileInput} onChange={(event) => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
      {draft.media.length > 0 && <ul class="zen-draft-attachments">{draft.media.map((file) => <ZenDraftAttachment key={file.id} attachment={file} disabled={draft.pending} onRemove={() => onDraft({ media: draft.media.filter((item) => item.id !== file.id), error: null })} />)}</ul>}
      <div class="fleet-actions"><button class="contact-link" type="button" disabled={disabled} onClick={() => fileInput.current?.click()}>attach</button><button class="contact-link" type="submit" disabled={disabled || (!draft.text.trim() && !draft.media.length)}>{draft.pending ? <LoadingState>sending…</LoadingState> : "send"}</button>
        {(draft.text || draft.media.length > 0) && <button class="contact-link" type="button" disabled={draft.pending} onClick={() => onDraft({ text: "", media: [], intent: null, error: null, status: null })}>discard draft</button>}
        {draft.status && <span class="note" role="status">{draft.status}</span>}
      </div>
      {draft.error && <p class="error" role="alert">{draft.error}</p>}
      {!connected ? <p class="note">Reconnecting… Your draft is kept here.</p> : contact.state !== "active" ? <p class="note">This connection is revoked. Previous messages remain available.</p> : !maySend && <p class="note">Your account cannot send messages to this contact.</p>}
    </form>
  </section>;
}
