import type { ContactSummary, ConversationMessage } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useDraftGuard } from "../shared/useDraftGuard";
import { INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";
import { assistancePlan, type AssistancePlan } from "./socialAssistance";
import { evidenceAttachments } from "./reportEvidence";

export function AskShip({ contact, messages, onClose, onStarted, onDirty }: {
  contact: ContactSummary; messages: readonly ConversationMessage[]; onClose: () => void;
  onStarted: (pid: string) => void; onDirty: (dirty: boolean) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [request, setRequest] = useState("");
  const [notes, setNotes] = useState("");
  const [attachments, setAttachments] = useState<Set<string>>(new Set());
  const [entireThread, setEntireThread] = useState(false);
  const [hours, setHours] = useState(24);
  const [generations, setGenerations] = useState(32);
  const [review, setReview] = useState<AssistancePlan | null>(null);
  const [error, setError] = useState("");
  const start = useMutation({
    mutationFn: async (plan: AssistancePlan) => {
      const process = await client.proc.spawn(plan.spawn);
      if (!process.ok) throw new Error(process.error);
      const { conversation } = await client.conversation.forProcess({ pid: process.pid });
      await client.conversation.send({ conversationId: conversation.id, text: plan.input, idempotencyKey: `${process.pid}:initial` });
      return process.pid;
    },
    onSuccess: (pid) => { void cache.invalidateQueries({ queryKey: INSTRUMENT_PROCESSES_KEY }); onStarted(pid); },
  });
  useDraftGuard(!start.isSuccess, onDirty);
  const resources = evidenceAttachments(messages);
  return <section class="people-assistance" aria-labelledby="ask-ship-title">
    <div class="people-kicker">Private assistance</div><h2 id="ask-ship-title">Ask your Ship</h2>
    <p class="people-note">A fresh helper sees the material you choose here. Its replies stay private until you review and send one.</p>
    {!review ? <>
      <label>What would you like help with?<textarea rows={3} maxLength={4096} placeholder="Help me understand this, or prepare a reply…" value={request} onInput={(event) => setRequest(event.currentTarget.value)} /></label>
      <details open><summary>{messages.length} selected message{messages.length === 1 ? "" : "s"}</summary>{messages.map((message) => <blockquote key={message.id} class="people-reply-quote"><strong>{message.author.kind === "contact" ? message.author.displayName : message.author.kind === "process" ? "Your Ship" : "You"}</strong><p>{message.text || "Attachment message"}</p></blockquote>)}</details>
      <label class="people-setting"><input type="checkbox" checked={entireThread} onChange={(event) => setEntireThread(event.currentTarget.checked)} /><span>Also allow reading this entire conversation<small>Includes older messages and new messages until access expires. Attachments still require selection.</small></span></label>
      {resources.length > 0 && <fieldset><legend>Files the helper may read</legend>{resources.map(({ id, resource }) => {
        const supported = resource.ref.target === contact.id && resource.ref.expiresAt === undefined;
        return <label class="people-setting" key={id}><input type="checkbox" disabled={!supported} checked={attachments.has(id)} onChange={(event) => { const next = new Set(attachments); if (event.currentTarget.checked) next.add(id); else next.delete(id); setAttachments(next); }} /><span>{resource.filename || "Unnamed file"}<small>{supported ? `${resource.ref.contentType} · ${Math.ceil(resource.ref.size / 1024)} KiB` : "Files from your private storage need to be shared as selected text for now."}</small></span></label>;
      })}</fieldset>}
      <label>Additional material <span class="people-note">optional · shared only with this helper</span><textarea rows={3} maxLength={32_768} placeholder="Paste reference material or details you want to include…" value={notes} onInput={(event) => setNotes(event.currentTarget.value)} /></label>
      <div class="people-helper-limits"><label>Access expires after<select value={hours} onChange={(event) => setHours(Number(event.currentTarget.value))}><option value={1}>1 hour</option><option value={24}>1 day</option><option value={168}>7 days</option></select></label><label>Model requests allowed<select value={generations} onChange={(event) => setGenerations(Number(event.currentTarget.value))}><option value={16}>16</option><option value={32}>32</option><option value={64}>64</option></select></label></div>
      <button class="ibtn" disabled={!connected || !request.trim()} onClick={() => {
        try { setReview(assistancePlan(contact, messages, { request, notes, attachments, entireThread, hours, generations })); setError(""); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to prepare this helper"); }
      }}>review access</button>
    </> : <>
      <dl class="people-helper-access"><dt>Can read</dt><dd>{entireThread ? "This conversation, including new messages" : `${messages.length} selected messages`}{attachments.size > 0 ? ` and ${attachments.size} selected files` : ""}{notes.trim() ? ", plus your additional material" : ""}</dd><dt>Can reply to</dt><dd>You, privately. Sending to this person needs your separate approval.</dd><dt>Limits</dt><dd>One helper · {generations} model requests · until {new Date(review.spawn.scope!.expiresAtMs).toLocaleString()}</dd></dl>
      <details><summary>The message you are giving Ship</summary><pre class="people-evidence-preview">{review.input}</pre></details>
      <p class="people-note">Your other conversations, personal Ship history, standing context, credentials and connected machines are outside this helper's access.</p>
      <div class="people-actions"><button class="ibtn is-primary" disabled={!connected || start.isPending} onClick={() => start.mutate(review)}>{start.isPending ? <LoadingState>starting private help…</LoadingState> : start.isError ? "retry same helper" : "start private help"}</button>{start.isIdle && <button class="people-action" onClick={() => setReview(null)}>back to editing</button>}</div>
      {start.isError && <p class="people-note">Starting is unconfirmed. Retry recovers the same helper and first message. You can also find it under Ship help.</p>}
    </>}
    {(error || start.error) && <p class="people-error" role="alert">{error || start.error?.message}</p>}
    <button class="people-action" disabled={start.isPending} onClick={onClose}>{start.isError ? "close this review" : "cancel"}</button>
  </section>;
}
