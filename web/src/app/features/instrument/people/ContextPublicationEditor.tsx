import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import type { ActorRef, ContactContextPublishArgs, ConversationMessage, SharedContextKind, SharedContextPublication, SharedContextAssertion } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { useDraftGuard } from "../shared/useDraftGuard";
import { INSTRUMENT_SHARED_CONTEXT_KEY } from "../wire/queryKeys";
import { refreshContactQuery } from "../wire/contactSync";
import { LoadingState } from "../../../components/ui/Spinner";
import { CONTEXT_KIND_LABELS } from "./ContextStatement";

type Review = { args: ContactContextPublishArgs; quotes: SharedContextAssertion["evidence"] };

export function ContextPublicationEditor({ subject, account, allowConnection, existing, messages = [], onClose, onDirty }: {
  subject: ActorRef; account: ConsoleAccount | undefined; allowConnection: boolean; existing?: SharedContextPublication;
  messages?: readonly ConversationMessage[]; onClose: () => void; onDirty: (dirty: boolean) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const original = existing?.record.assertion;
  const [kind, setKind] = useState<SharedContextKind>(original?.kind ?? "recommendation");
  const [label, setLabel] = useState(original?.label ?? "");
  const [text, setText] = useState(original?.text ?? "");
  const [category, setCategory] = useState(original?.category ?? "");
  const [days, setDays] = useState(7);
  const [quotes, setQuotes] = useState(() => messages.filter((message) => !!message.text.trim()).slice(0, 3).map((message) => ({ message, text: message.text.slice(0, 512) })));
  const [retainEvidence, setRetainEvidence] = useState(!!original?.evidence.length);
  const [review, setReview] = useState<Review | null>(null);
  const [localError, setLocalError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const allowed = connected && !!account && account.uid >= 1000 && canConfigure(account, "contact.context.publish");
  const publish = useMutation({
    mutationFn: (value: Review) => client.contact.context.publish(value.args),
    onSuccess: () => refreshContactQuery(cache, INSTRUMENT_SHARED_CONTEXT_KEY),
    onError: () => refreshContactQuery(cache, INSTRUMENT_SHARED_CONTEXT_KEY),
  });
  useDraftGuard(!publish.data, onDirty);
  const prepare = () => {
    setLocalError("");
    if (!label.trim() || (kind !== "connection" && !text.trim())) { setLocalError("Add a name to share and your statement."); return; }
    if (kind === "connection" && !allowConnection) { setLocalError("A connection disclosure needs an active conversation with this person."); return; }
    if (quotes.some((quote) => !quote.text.trim() || !quote.message.text.includes(quote.text))) { setLocalError("Each quote must be an exact excerpt from the selected message."); return; }
    const selected = quotes.map(({ message, text }) => ({ conversationId: message.conversationId, messageId: message.id, sequence: message.sequence, text }));
    const args: ContactContextPublishArgs = { id: original?.id ?? `statement:${crypto.randomUUID()}`, expectedRevision: original?.revision ?? 0,
      idempotencyKey: crypto.randomUUID(), subject, kind, label: label.trim(), text: text.trim(), expiresAtMs: Date.now() + days * 24 * 60 * 60_000,
      ...(category.trim() ? { category: category.trim() } : undefined),
      ...(retainEvidence && original ? { retainEvidence: true } : selected.length ? { evidence: selected } : undefined) };
    if (new TextEncoder().encode(JSON.stringify(args)).length > (kind === "connection" ? 4500 : 6500)) { setLocalError("Shorten the statement or selected quotes before sharing."); return; }
    setReview({ args, quotes: retainEvidence && original ? original.evidence : quotes.map(({ text }) => ({ text })) });
  };
  return <section class="people-context-editor" aria-label="Review a shared statement">
    <div class="people-kicker">Your words, your choice</div><h2>{original ? "Revise a shared statement" : "Share about this person"}</h2>
    {!review ? <form onSubmit={(event) => { event.preventDefault(); prepare(); }}>
      <label>What are you sharing?<select value={kind} onChange={(event) => { const value = event.currentTarget.value; if (value === "connection" || value === "recommendation" || value === "advisory") setKind(value); }}>
        <option value="recommendation">A recommendation</option><option value="advisory">An experience or concern</option><option value="connection" disabled={!allowConnection}>Our connection, with their consent</option>
      </select></label>
      <label>Name to show with this statement<input value={label} maxLength={80} required autoFocus onInput={(event) => setLabel(event.currentTarget.value)} /></label>
      <p class="people-note">Choose the name you want to disclose. Your private name for this contact is kept private.</p>
      <label>Your statement<textarea rows={4} value={text} maxLength={1024} required={kind !== "connection"} onInput={(event) => setText(event.currentTarget.value)} /></label>
      <label>Category (optional)<input value={category} maxLength={64} placeholder="For example: design, collaboration, payment" onInput={(event) => setCategory(event.currentTarget.value)} /></label>
      <label>Keep available for<select value={days} onChange={(event) => setDays(Number(event.currentTarget.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select></label>
      {!!original?.evidence.length && <label class="people-check"><input type="checkbox" checked={retainEvidence} onChange={(event) => setRetainEvidence(event.currentTarget.checked)} />keep the existing selected quotes</label>}
      {quotes.map((quote, index) => <div class="people-quote-editor" key={quote.message.id}><label>Selected quote {index + 1}<textarea rows={3} value={quote.text} maxLength={512} onInput={(event) => { const value = event.currentTarget.value; setQuotes((previous) => previous.map((entry, i) => i === index ? { ...entry, text: value } : entry)); }} /></label>
        <p class="people-note">An exact excerpt, up to 512 characters. Attachments and the rest of the conversation stay private.</p><button type="button" class="people-action" onClick={() => setQuotes((previous) => previous.filter((_, i) => i !== index))}>remove quote</button></div>)}
      <p class="people-note">Audience: your active direct contacts who choose to receive this kind of statement. {kind === "connection" ? "The other person must approve this exact wording and audience before it becomes visible." : "This will be attributed to you."}</p>
      <button type="submit" class="ibtn" disabled={!allowed}>review what will be shared</button>
    </form> : <>
      <p class="people-context-meta">{CONTEXT_KIND_LABELS[review.args.kind]} · {review.args.category || "no category"}</p>
      <h3>{review.args.label}</h3><p class="people-context-text">{review.args.text}</p>
      {review.quotes.map((quote, i) => <blockquote key={i}>{quote.text}</blockquote>)}
      <dl class="people-context-review"><dt>Audience</dt><dd>Your active direct contacts who subscribe to {review.args.kind === "advisory" ? "advisories" : `${review.args.kind}s`}.</dd>
        <dt>Until</dt><dd>{new Date(review.args.expiresAtMs).toLocaleString()}</dd>
        <dt>Identity concerned</dt><dd>{subject.shipId}<br />{subject.subjectId}</dd></dl>
      {review.args.kind === "connection" && <p class="people-note">This sends a consent proposal to the other person. A changed connection statement needs their fresh approval.</p>}
      <p class="people-note">You can withdraw this later. Disconnected recipients may retain it until its display lease ends, within 24 hours. Copies they deliberately export cannot be recalled.</p>
      {publish.data ? <div role="status"><p>{publish.data.publication.state === "awaiting-consent" ? "Proposal saved. Waiting for the other person's decision." : "Your shared statement is saved."}</p></div>
        : <div class="people-actions"><button class="ibtn is-primary" disabled={!allowed || publish.isPending} onClick={() => { setAttempted(true); publish.mutate(review); }}>{publish.isPending ? <LoadingState>saving…</LoadingState> : attempted ? "retry this exact statement" : review.args.kind === "connection" ? "ask for consent" : "share this statement"}</button>
          {!attempted && <button class="people-action" onClick={() => setReview(null)}>back to editing</button>}</div>}
    </>}
    {(localError || publish.error) && <p class="people-error" role="alert">{localError || publish.error?.message}</p>}
    <button class="people-action" disabled={publish.isPending} onClick={onClose}>{publish.data ? "done" : attempted ? "close" : "cancel"}</button>
  </section>;
}
