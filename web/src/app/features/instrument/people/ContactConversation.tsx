import { MAX_FEDERATION_MESSAGE_RESOURCES, type ContactSummary, type OriginMessageRef } from "@humansandmachines/gsv/protocol";
import { useQueries } from "@tanstack/preact-query";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { useLayoutEffect, useRef } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { MAX_STAGED_RESOURCE_BYTES } from "../../../services/gateway/stagedResources";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { instrumentContactDeliveriesKey } from "../wire/queryKeys";
import { ZenDraftAttachment, ZenMedia } from "../zen/ZenMedia";
import { zenAttachment } from "../zen/zenAttachments";
import type { ContactDraft } from "./useContactDrafts";
import { useConversationReadPosition } from "./useConversationReadPosition";
import { useContactHistory } from "./useContactHistory";
import { MessageDelivery } from "./MessageDelivery";
import "../shared/senderBadge.css";

export type ContactComposerProps = {
  draft: ContactDraft;
  onDraft: (change: Partial<ContactDraft>) => void;
  onSend: () => void;
  onRetry: (id: string) => void;
  onObserved: (messageIds: readonly string[]) => void;
};

export function ContactConversation({ contact, account, draft, onDraft, onSend, onRetry, onObserved }: ContactComposerProps & {
  contact: ContactSummary;
  account: ConsoleAccount | undefined;
}) {
  const active = useViewActive();
  const { client, connected } = useGateway();
  const mayRead = !!account && canConfigure(account, "conversation.history");
  const maySend = !!account && canConfigure(account, "contact.send")
    && (account.uid === 0 || account.uid === contact.ownerUid) && contact.state === "active";
  const disabled = !connected || !maySend;
  const sendingFull = draft.sent.filter((entry) => entry.state === "sending").length >= 3;
  const tooLong = new TextEncoder().encode(draft.text).length > 32_768;
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const olderHeight = useRef<number | null>(null);
  const history = useContactHistory(contact.conversationId, mayRead);
  const messages = history.data?.pages.slice().reverse().flatMap((page) => page.messages) ?? [];
  useConversationReadPosition(contact.conversationId, scroll, messages.at(-1)?.sequence ?? 0, !!account && account.uid >= 1000 && canConfigure(account, "conversation.view.update"));
  const pendingMessages = draft.sent.filter((entry) => !entry.messageId || !messages.some((message) => message.id === entry.messageId));
  const outgoingSequences = messages.filter((message) => message.author.kind !== "contact").map((message) => message.sequence);
  const deliveryQueries = useQueries({ queries: Array.from({ length: Math.ceil(outgoingSequences.length / 100) }, (_, index) => {
    const messageSequences = outgoingSequences.slice(index * 100, (index + 1) * 100);
    return { queryKey: [...instrumentContactDeliveriesKey(contact.id), messageSequences],
      enabled: active && connected && !!account && canConfigure(account, "contact.delivery.list"),
      notifyOnChangeProps: active ? undefined : [],
      queryFn: () => client.contact.delivery.list({ contactId: contact.id, messageSequences }) };
  }) });
  const deliveryBySequence = new Map(deliveryQueries.flatMap((query) => query.data?.deliveries ?? []).map((delivery) => [delivery.messageSequence, delivery]));
  useLayoutEffect(() => { onObserved(messages.map((message) => message.id)); }, [history.data, draft.sent, onObserved]);
  const send = () => {
    if (disabled || sendingFull || tooLong) return;
    follow.current = true; onSend();
  };
  const followLatest = () => {
    if (active && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  };
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!active || !element) return;
    if (olderHeight.current !== null) {
      element.scrollTop += element.scrollHeight - olderHeight.current;
      olderHeight.current = null;
    } else followLatest();
  }, [active, history.data, draft.sent]);
  const addFiles = (files: readonly File[]) => {
    if (disabled) return;
    if (files.some((file) => file.size > MAX_STAGED_RESOURCE_BYTES)) {
      onDraft({ error: "Each attachment must be 25 MB or smaller." });
      return;
    }
    if (draft.media.length + files.length > MAX_FEDERATION_MESSAGE_RESOURCES) {
      onDraft({ error: `A message can include up to ${MAX_FEDERATION_MESSAGE_RESOURCES} attachments.` }); return;
    }
    if (draft.media.reduce((bytes, file) => bytes + file.body.size, 0) + files.reduce((bytes, file) => bytes + file.size, 0) > 100 * 1024 * 1024) {
      onDraft({ error: "Keep the total attachments in one message under 100 MB." }); return;
    }
    onDraft({ media: [...draft.media, ...files.map(zenAttachment)], error: null, status: null });
  };

  return <section class="people-conversation" aria-label="Contact messages">
    {!mayRead && <p class="note">Your account cannot read this conversation.</p>}
    {mayRead && <div class="people-history" ref={scroll} onScroll={(event) => {
      const element = event.currentTarget;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    }}>
      {history.hasNextPage && <button class="fleet-text-action" type="button" disabled={!connected || history.isFetching} onClick={() => {
        olderHeight.current = scroll.current?.scrollHeight ?? null;
        void history.fetchNextPage().then((result) => { if (result.isError) olderHeight.current = null; });
      }}>{history.isFetchingNextPage ? "loading earlier messages…" : "earlier messages"}</button>}
      {history.isPending && connected && <LoadingState variant="panel">Loading messages…</LoadingState>}
      {history.error && <p class="error" role="alert">{history.error.message} <button class="fleet-text-action" disabled={!connected} onClick={() => void history.refetch()}>retry</button></p>}
      {history.data && messages.length === 0 && <p class="note">No messages yet.</p>}
      {messages.map((message) => {
        const incoming = message.author.kind === "contact";
        /* absent on historical and v1 messages, whose submission path is unknown: no badge rather than a guess */
        const provenance = incoming ? message.social?.provenance.kind ?? null : null;
        const authorName = message.author.kind === "contact" ? message.author.displayName : message.author.kind === "process" ? "GSV" : "you";
        const authorKind = incoming ? (provenance === "process" ? "contact-ship" : provenance === "human" ? "contact-human" : "contact") : message.author.kind === "process" ? "your-ship" : "you";
        return <article key={message.id} data-message-sequence={message.sequence} data-author={authorKind} class="people-message">
        <header><span class="people-message-author">{authorName}{provenance && <span class="sender-badge">{provenance === "process" && <span class="sender-dot" />}{provenance === "process" ? "GSV" : "PERSON"}</span>}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></header>
        {message.social?.replyTo && <blockquote class="people-reply-quote">{messages.find((candidate) => sameReference(candidate.social?.reference, message.social!.replyTo!))?.text.slice(0, 240) || "Reply to an earlier message"}</blockquote>}
        {message.text && <p>{message.text}</p>}
        {message.media?.map((media, index) => <ZenMedia key={index} media={media} processId={message.processId ?? ""} onReady={followLatest} />)}
        <footer class="people-message-actions">
          {message.social && <button class="fleet-text-action people-message-reply" type="button" disabled={disabled} onClick={() => onDraft({ reply: { reference: message.social!.reference, author: message.author.kind === "contact" ? message.author.displayName : "you", preview: message.text.slice(0, 200) } })}>reply</button>}
          {message.author.kind !== "contact" && <MessageDelivery delivery={deliveryBySequence.get(message.sequence)} mayRetry={!!account && canConfigure(account, "contact.delivery.retry")} />}
        </footer>
      </article>;
      })}
      {pendingMessages.map((entry) => <article key={entry.intent.idempotencyKey} data-author="you" class="people-message people-pending-message">
        <header><span class="people-message-author">you</span><span role="status">{entry.state === "sending" ? <LoadingState>sending…</LoadingState> : entry.state === "queued" ? "accepted for delivery" : entry.state === "delivered" ? "delivered" : "send unconfirmed"}</span></header>
        {entry.reply && <blockquote class="people-reply-quote">{entry.reply.preview}</blockquote>}
        {entry.intent.text && <p>{entry.intent.text}</p>}
        {entry.attachmentCount > 0 && <span class="note">{entry.attachmentCount} attachment{entry.attachmentCount === 1 ? "" : "s"}</span>}
        {entry.error && <p class="error" role="alert">{entry.error}</p>}
        {(entry.state === "failed" && entry.retryable || entry.state === "unconfirmed") && <button class="fleet-text-action" disabled={disabled || sendingFull} onClick={() => onRetry(entry.intent.idempotencyKey)}>retry same message</button>}
      </article>)}
    </div>}
    <form class="people-composer" onSubmit={(event) => { event.preventDefault(); send(); }} onDragOver={(event) => { if (!disabled) event.preventDefault(); }} onDrop={(event) => {
      event.preventDefault();
      addFiles(Array.from(event.dataTransfer?.files ?? []));
    }}>
      {draft.reply && <div class="people-composer-reply"><span>Reply to {draft.reply.author}</span><blockquote class="people-reply-quote">{draft.reply.preview}</blockquote><button class="fleet-text-action" type="button" onClick={() => onDraft({ reply: null })}>cancel reply</button></div>}
      <textarea aria-label="Message to contact" placeholder="Write a message…" rows={2} value={draft.text} disabled={disabled} onInput={(event) => onDraft({ text: event.currentTarget.value, error: null, status: null })} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!event.repeat) send(); }
      }} onPaste={(event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length) { event.preventDefault(); addFiles(files); }
      }} />
      <input type="file" multiple hidden ref={fileInput} onChange={(event) => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
      {draft.media.length > 0 && <ul class="zen-draft-attachments">{draft.media.map((file) => <ZenDraftAttachment key={file.id} attachment={file} disabled={disabled} onRemove={() => onDraft({ media: draft.media.filter((item) => item.id !== file.id), error: null })} />)}</ul>}
      <div class="people-composer-actions">
        <button class="fleet-text-action" type="button" disabled={disabled} onClick={() => fileInput.current?.click()}>attach</button>
        {draft.status && <span class="note" role="status">{draft.status}</span>}
        <button class="fleet-text-action" type="submit" disabled={disabled || sendingFull || tooLong || (!draft.text.trim() && !draft.media.length)}>send</button>
      </div>
      {tooLong && <p class="error" role="alert">This message is too long. Shorten it before sending.</p>}
      {draft.error && <p class="error" role="alert">{draft.error}</p>}
      {!connected ? <p class="note">Reconnecting… Your draft is kept here.</p> : contact.state !== "active" ? <p class="note">This connection is revoked. Previous messages remain available.</p> : !maySend && <p class="note">Your account cannot send messages to this contact.</p>}
    </form>
  </section>;
}

function sameReference(value: OriginMessageRef | undefined, expected: OriginMessageRef): boolean {
  return !!value && value.messageId === expected.messageId && value.actor.shipId === expected.actor.shipId && value.actor.subjectId === expected.actor.subjectId;
}
