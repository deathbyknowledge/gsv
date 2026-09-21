import { contactDisplayName, resourceBlockSchema, type ContactDraft, type ContactDraftCreateArgs, type ContactDraftListArgs, type ContactSummary, type ResourceBlock } from "@humansandmachines/gsv/protocol";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useState } from "preact/hooks";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { randomId } from "../../../services/ids";
import { canConfigure } from "../settings/settingsModel";
import { useDraftGuard } from "../shared/useDraftGuard";
import { INSTRUMENT_CONTACTS_KEY, instrumentContactDeliveriesKey } from "../wire/queryKeys";
import { reviewedAttachments } from "./socialAssistance";
import { MessageDelivery } from "./MessageDelivery";

export type ReplyForReview = { source: ContactDraftCreateArgs["source"]; text: string; media: ResourceBlock[] };
const draftKey = (contactId: string) => [...INSTRUMENT_CONTACTS_KEY, "drafts", contactId] as const;
const START: ContactDraftListArgs["after"] = undefined;

export function ReplyReview({ contact, reply, onDirty, onClose, account }: {
  contact: ContactSummary; reply: ReplyForReview; onDirty: (dirty: boolean) => void; onClose: () => void; account: ConsoleAccount;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [text, setText] = useState(reply.text);
  const [attachments, setAttachments] = useState<Set<number>>(new Set());
  const [intent, setIntent] = useState<ContactDraftCreateArgs | null>(null);
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const save = useMutation({ mutationFn: (args: ContactDraftCreateArgs) => client.contact.draft.create(args), onSuccess: ({ draft: value }) => {
    setDraft(value); void cache.invalidateQueries({ queryKey: draftKey(contact.id) });
  } });
  useDraftGuard(!draft, onDirty);
  if (draft) return <><DraftDecision contact={contact} draft={draft} account={account} onChanged={setDraft} /><button class="people-action" onClick={onClose}>back to private help</button></>;
  const tooLong = new TextEncoder().encode(text).byteLength > 32_768;
  return <section class="people-assistance" aria-labelledby="review-reply-title"><div class="people-kicker">Ship-assisted reply</div><h2 id="review-reply-title">Make this reply yours</h2>
    <p class="people-note">To <strong>{contactDisplayName(contact)}</strong> · {contact.remoteOrigin}. Saving the review keeps it private. You will approve the exact message next.</p>
    <label>Reply<textarea rows={8} value={text} disabled={!!intent} onInput={(event) => setText(event.currentTarget.value)} /></label>
    {reply.media.length > 0 && <fieldset><legend>Attachments to send</legend>{reply.media.map((file, index) => <label class="people-setting" key={index}><input type="checkbox" checked={attachments.has(index)} disabled={!!intent} onChange={(event) => { const next = new Set(attachments); if (event.currentTarget.checked) next.add(index); else next.delete(index); setAttachments(next); }} /><span>{file.filename || "Unnamed file"}<small>{file.ref.contentType} · {Math.ceil(file.ref.size / 1024)} KiB</small></span></label>)}</fieldset>}
    {tooLong && <p class="people-error" role="alert">Shorten the reply to 32 KiB before reviewing.</p>}
    <div class="people-actions"><button class="ibtn" disabled={!connected || save.isPending || tooLong || (!text.trim() && !attachments.size) || !canConfigure(account, "contact.draft.create")} onClick={() => {
      const args = intent ?? { contactId: contact.id, expectedGeneration: contact.generation, source: reply.source, text, media: reviewedAttachments(reply.media, attachments), idempotencyKey: randomId() };
      setIntent(args); save.mutate(args);
    }}>{save.isPending ? <LoadingState>saving review…</LoadingState> : save.isError ? "retry saving this review" : "review exact message"}</button><button class="people-action" disabled={save.isPending} onClick={onClose}>{save.isError ? "close · kept if already saved" : "cancel"}</button></div>
    {save.error && <p class="people-error" role="alert">{save.error.message}</p>}
  </section>;
}

function DraftDecision({ contact, draft, account, onChanged }: { contact: ContactSummary; draft: ContactDraft; account: ConsoleAccount; onChanged: (draft: ContactDraft) => void }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const changed = ({ draft: value }: { draft: ContactDraft }) => { onChanged(value); void cache.invalidateQueries({ queryKey: draftKey(contact.id) }); };
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (draft.expiresAtMs <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, draft.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [draft.expiresAtMs, now]);
  const approve = useMutation({ mutationFn: () => client.contact.draft.approve({ draftId: draft.id, expectedRevision: draft.state === "sending" ? draft.revision - 1 : draft.revision }), onSuccess: changed });
  const discard = useMutation({ mutationFn: () => client.contact.draft.discard({ draftId: draft.id, expectedRevision: draft.revision }), onSuccess: changed });
  const refresh = useMutation({ mutationFn: () => client.contact.draft.get({ draftId: draft.id }), onSuccess: changed });
  const delivery = useQuery({ queryKey: [...instrumentContactDeliveriesKey(contact.id), "draft", draft.result?.deliveryId],
    enabled: connected && !!draft.result && canConfigure(account, "contact.delivery.get"),
    queryFn: () => client.contact.delivery.get({ deliveryId: draft.result!.deliveryId }) });
  const expired = draft.expiresAtMs <= now;
  const active = contact.state === "active" && contact.generation === draft.content.expectedGeneration;
  const pending = approve.isPending || discard.isPending || refresh.isPending;
  return <article class="people-draft-review" aria-label="Exact draft approval">
    <header><div class="people-kicker">{draft.state === "sent" ? "Submitted reply" : "Private draft"}</div><h3>To {contactDisplayName(contact)}</h3><p class="people-note">{contact.remoteOrigin} · sent as your approved Ship-assisted reply</p></header>
    <pre class="people-evidence-preview">{draft.content.text}</pre>
    {!!draft.content.media?.length && <ul class="people-draft-files">{draft.content.media.map((file, index) => <li key={index}>{file.filename || "Unnamed file"} · {file.ref.contentType} · {Math.ceil(file.ref.size / 1024)} KiB</li>)}</ul>}
    {draft.state === "sent" ? <><p class="people-note" role="status">Saved to the conversation for delivery.</p><MessageDelivery delivery={delivery.data?.delivery ?? undefined} mayRetry={canConfigure(account, "contact.delivery.retry")} /></>
      : draft.state === "discarded" ? <p class="people-note">Discarded without sending.</p>
      : expired ? <p class="people-note">This review expired. Check the conversation for any previously submitted delivery before preparing a new reply.</p>
      : <>
        {!active && <p class="people-error">This connection changed. The draft cannot be sent to a replacement connection.</p>}
        <p class="people-note">{draft.state === "sending" ? "Submission is unconfirmed. Retry uses the same message and cannot edit its content." : "This exact text and the listed attachments will be sent. Nothing else from the helper is included."}</p>
        <div class="people-actions"><button class="ibtn is-primary" disabled={!connected || !active || pending || !canConfigure(account, "contact.draft.approve") || !canConfigure(account, "contact.send")} onClick={() => approve.mutate()}>{approve.isPending ? <LoadingState>submitting…</LoadingState> : draft.state === "sending" || approve.isError ? "retry exact submission" : "approve and send this reply"}</button>
          {draft.state === "review" && !approve.isError && <button class="people-action" disabled={!connected || pending || !canConfigure(account, "contact.draft.discard")} onClick={() => discard.mutate()}>discard without sending</button>}
        </div>
      </>}
    {(approve.error || discard.error || refresh.error || delivery.error) && <p class="people-error" role="alert">{approve.error?.message || discard.error?.message || refresh.error?.message || delivery.error?.message}</p>}
    {(approve.isError || discard.isError) && <button class="people-action" disabled={!connected || pending} onClick={() => refresh.mutate()}>refresh saved state</button>}
  </article>;
}

export function ContactDrafts({ contact, account }: { contact: ContactSummary; account: ConsoleAccount }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const drafts = useInfiniteQuery({ queryKey: draftKey(contact.id), initialPageParam: START,
    enabled: connected && canConfigure(account, "contact.draft.list"),
    queryFn: ({ pageParam }) => client.contact.draft.list({ contactId: contact.id, after: pageParam, limit: 10 }), getNextPageParam: (page) => page.next });
  return <section class="people-saved-drafts" aria-label="Saved reply reviews"><h3>Reply reviews</h3><p class="people-note">Private reviews are kept for seven days. Submitted replies remain in your conversation.</p>
    {drafts.isPending && connected && <LoadingState>Loading reviews…</LoadingState>}
    {drafts.error && <p class="people-error" role="alert">{drafts.error.message}<button class="people-action" disabled={!connected} onClick={() => void drafts.refetch()}>retry</button></p>}
    {drafts.data && !drafts.data.pages.some((page) => page.drafts.length) && <p class="people-note">No saved reply reviews.</p>}
    {drafts.data?.pages.flatMap((page) => page.drafts).map((draft) => <details key={draft.id} open={draft.state === "review" || draft.state === "sending"}><summary>{draft.state === "review" ? "Waiting for your review" : draft.state === "sending" ? "Submission unconfirmed" : draft.state === "sent" ? "Submitted reply" : "Discarded reply"} · {new Date(draft.createdAtMs).toLocaleString()}</summary><DraftDecision contact={contact} draft={draft} account={account} onChanged={() => void cache.invalidateQueries({ queryKey: draftKey(contact.id) })} /></details>)}
    {drafts.hasNextPage && <button class="people-action" disabled={drafts.isFetchingNextPage} onClick={() => void drafts.fetchNextPage()}>more reviews</button>}
  </section>;
}

export function helperReplyMedia(media: readonly unknown[], selected: readonly ResourceBlock[]): ResourceBlock[] {
  const candidates = [...media.flatMap((file) => { const parsed = resourceBlockSchema.safeParse(file); return parsed.success ? [parsed.data] : []; }), ...selected];
  return [...new Map(candidates.map((file) => [`${file.ref.target}:${file.ref.path}:${file.ref.revision}`, file])).values()];
}
