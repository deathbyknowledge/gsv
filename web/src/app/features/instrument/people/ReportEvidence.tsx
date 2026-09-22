import { useInfiniteQuery, useMutation } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { contactDisplayName, type ContactListArgs, type ContactSendArgs, type ContactSummary, type ConversationMessage } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { useDraftGuard } from "../shared/useDraftGuard";
import { INSTRUMENT_CONTACTS_KEY } from "../wire/queryKeys";
import { LoadingState } from "../../../components/ui/Spinner";
import { evidenceAttachments, reportEvidence } from "./reportEvidence";

const START: ContactListArgs["after"] = undefined;
type ReviewedReport = { recipient: ContactSummary; intent: ContactSendArgs };

export function ReportEvidence({ messages, account, onClose, onOpen, onDirty }: {
  messages: readonly ConversationMessage[]; account?: ConsoleAccount; onClose: () => void;
  onOpen: (contactId: string) => void; onDirty: (dirty: boolean) => void;
}) {
  const { client, connected } = useGateway();
  const [query, setQuery] = useState("");
  const [recipient, setRecipient] = useState<ContactSummary | null>(null);
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<ReviewedReport | null>(null);
  const [error, setError] = useState("");
  const maySend = !!account && account.uid >= 1000 && canConfigure(account, "contact.send");
  const contacts = useInfiniteQuery({
    queryKey: [...INSTRUMENT_CONTACTS_KEY, "report-recipient", query],
    enabled: connected && !!account && !review && canConfigure(account, "contact.list"), initialPageParam: START,
    queryFn: ({ pageParam }) => client.contact.list({ query: query.trim(), after: pageParam, limit: 20 }), getNextPageParam: (page) => page.next,
  });
  const send = useMutation({
    mutationFn: async (value: ReviewedReport) => {
      const current = (await client.contact.list({ ids: [value.recipient.id], limit: 1 })).contacts[0];
      if (!current || current.generation !== value.recipient.generation) throw new Error("This connection changed. Close the report and review the recipient again.");
      return client.contact.send({ ...value.intent, expectedGeneration: value.recipient.generation });
    },
  });
  useDraftGuard(!send.data, onDirty);
  const resources = evidenceAttachments(messages);
  return <section class="people-report" aria-labelledby="report-evidence-title">
    <div class="people-kicker">Selected evidence</div><h2 id="report-evidence-title">Report to someone you choose</h2>
    <p class="people-note">Send a private report to a support or moderation contact. Only the selected message copies and checked attachments are included. This does not block anyone or publish an advisory.</p>
    {!review ? <>
      <label>Find the recipient<input value={query} placeholder="Name or space address" maxLength={160} disabled={!connected} onInput={(event) => setQuery(event.currentTarget.value)} /></label>
      {contacts.isFetching && !contacts.data && <LoadingState>Loading your contacts…</LoadingState>}
      <ul class="people-recipient-list">{contacts.data?.pages.flatMap((page) => page.contacts).map((contact) => <li key={contact.id}><button class="people-recipient" aria-pressed={recipient?.id === contact.id} onClick={() => setRecipient(contact)}><strong>{contactDisplayName(contact)}</strong><span>{contact.remoteOrigin}</span></button></li>)}</ul>
      {contacts.data && !contacts.data.pages.some((page) => page.contacts.length) && <p class="people-note">No matching active contacts. Establish a conversation with your support contact first.</p>}
      {contacts.hasNextPage && <button class="people-action" onClick={() => void contacts.fetchNextPage()} disabled={contacts.isFetchingNextPage}>more contacts</button>}
      {recipient && <p class="people-report-recipient">To: <strong>{contactDisplayName(recipient)}</strong> · {recipient.remoteOrigin}</p>}
      <label>What happened?<textarea value={note} maxLength={4096} rows={4} onInput={(event) => setNote(event.currentTarget.value)} /></label>
      <details open><summary>{messages.length} selected message{messages.length === 1 ? "" : "s"}</summary>{messages.map((message) => <blockquote key={message.id} class="people-reply-quote">{message.text || "Attachment message"}</blockquote>)}</details>
      {resources.length > 0 && <fieldset><legend>Include attachments</legend>{resources.map(({ id, resource }) => <label class="people-setting" key={id}><input type="checkbox" checked={attachments.has(id)} onChange={(event) => { const next = new Set(attachments); if (event.currentTarget.checked) next.add(id); else next.delete(id); setAttachments(next); }} /><span>{resource.filename || "Unnamed file"}<small>{resource.ref.contentType} · {Math.ceil(resource.ref.size / 1024)} KiB</small></span></label>)}</fieldset>}
      <button class="ibtn" disabled={!recipient || !maySend || !connected} onClick={() => {
        if (!recipient) return;
        try { setReview({ recipient, intent: reportEvidence(recipient.id, messages, note, attachments) }); setError(""); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to prepare this report"); }
      }}>review report</button>
    </> : <>
      <p class="people-report-recipient">To: <strong>{contactDisplayName(review.recipient)}</strong><br />{review.recipient.remoteOrigin}</p>
      <p class="people-note">This is the exact message that will be sent.</p><pre class="people-evidence-preview">{review.intent.text}</pre>
      {send.data ? <div role="status"><p>{send.data.state === "delivered" ? "Received by their GSV." : send.data.state === "queued" ? "Your report is saved and queued for delivery." : "The report could not be delivered. Its status is available in the recipient's conversation."}</p><button class="people-action" onClick={() => onOpen(review.recipient.id)}>open recipient conversation</button></div>
        : <div class="people-actions"><button class="ibtn is-primary" disabled={!connected || !maySend || send.isPending} onClick={() => send.mutate(review)}>{send.isPending ? <LoadingState>sending report…</LoadingState> : send.isError ? "retry same report" : "send this report"}</button>{send.isIdle && <button class="people-action" onClick={() => setReview(null)}>back to editing</button>}</div>}
      {send.isError && <p class="people-note">Submission is unconfirmed. Retrying uses this same report identity and content.</p>}
    </>}
    {(error || send.error || contacts.error) && <p class="people-error" role="alert">{error || send.error?.message || contacts.error?.message}</p>}
    <button class="people-action" disabled={send.isPending} onClick={onClose}>{send.data ? "close report" : "discard report"}</button>
  </section>;
}
