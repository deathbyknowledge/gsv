import { contactDisplayName, type ContactSummary, type ProcSpawnArgs } from "@humansandmachines/gsv/protocol";
import { useMutation } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { randomId } from "../../../services/ids";
import { useDraftGuard } from "../shared/useDraftGuard";

export function AutomaticHelp({ contact, onEnabled, onClose, onDirty }: {
  contact: ContactSummary; onEnabled: (pid: string) => void; onClose: () => void; onDirty: (dirty: boolean) => void;
}) {
  const { client, connected } = useGateway();
  const [mode, setMode] = useState<"draft" | "reply">("draft");
  const [request, setRequest] = useState("");
  const [notes, setNotes] = useState("");
  const [messages, setMessages] = useState(4);
  const [hours, setHours] = useState(24);
  const [review, setReview] = useState<ProcSpawnArgs | null>(null);
  const enable = useMutation({ mutationFn: async (args: ProcSpawnArgs) => {
    const result = await client.proc.spawn(args);
    if (!result.ok) throw new Error(result.error);
    await client.conversation.forProcess({ pid: result.pid });
    return result.pid;
  }, onSuccess: onEnabled });
  useDraftGuard(!enable.isSuccess, onDirty);
  const available = contact.state === "active" && contact.protocol?.version === 2 && contact.protocol.features.includes("messages") && !contact.preferences?.muted;
  return <section class="people-assistance" aria-labelledby="automatic-help-title"><div class="people-kicker">Optional attention</div><h2 id="automatic-help-title">Help with new messages</h2>
    <p class="people-note">For your conversation with <strong>{contactDisplayName(contact)}</strong>. A fresh helper can read this thread and the material you provide, and wakes only for new messages submitted by a person.</p>
    {!review ? <>
      <label>What may this helper do?<select value={mode} onChange={(event) => setMode(event.currentTarget.value === "reply" ? "reply" : "draft")}><option value="draft">Prepare private replies for my review</option><option value="reply">Reply to this person within the allowance</option></select></label>
      <label>Your instructions<textarea value={request} maxLength={4096} rows={4} placeholder="Describe the help you want in this conversation…" onInput={(event) => setRequest(event.currentTarget.value)} /></label>
      <label>Reference material <span class="people-note">optional</span><textarea value={notes} maxLength={32_768} rows={4} placeholder="Paste any details or guidance this helper may use…" onInput={(event) => setNotes(event.currentTarget.value)} /></label>
      <div class="people-helper-limits"><label>Incoming message allowance<select value={messages} onChange={(event) => setMessages(Number(event.currentTarget.value))}><option value={1}>1 message</option><option value={4}>4 messages</option><option value={8}>8 messages</option><option value={16}>16 messages</option></select></label><label>Access expires after<select value={hours} onChange={(event) => setHours(Number(event.currentTarget.value))}><option value={1}>1 hour</option><option value={24}>1 day</option><option value={168}>7 days</option></select></label></div>
      <button class="ibtn" disabled={!connected || !available || !request.trim()} onClick={() => setReview({
        idempotencyKey: randomId(), label: `Automatic help with ${contactDisplayName(contact)}`.slice(0, 160), interactive: true,
        scope: {
          conversations: [{ contactId: contact.id, conversationId: contact.conversationId, generation: contact.generation, read: true, send: mode === "reply" }],
          resources: [], materials: notes.trim() ? [{ name: "notes.txt", text: notes.trim() }] : [],
          budgets: { processes: 1, generations: 64, messages: mode === "reply" ? messages : 0 },
          expiresAtMs: Date.now() + hours * 3_600_000,
          automatic: { mode, request: request.trim(), maxMessages: messages, intervalSeconds: 60 },
        },
      })}>review automatic help</button>
    </> : <>
      <dl class="people-helper-access"><dt>Can read</dt><dd>This conversation, including earlier and new text, and your reference material.</dd><dt>Can send</dt><dd>{mode === "draft" ? "Private replies to you for review." : `Up to ${messages} replies to this person, at most one for each admitted human message. Replies are identified as your Ship.`}</dd><dt>Attention</dt><dd>Up to {messages} new human messages, at most once a minute, and 64 model requests shared by this helper.</dd><dt>Expires</dt><dd>{new Date(review.scope!.expiresAtMs).toLocaleString()}</dd></dl>
      <p class="people-note">Files, other conversations, your personal Ship history, credentials and devices remain outside its access. A full queue or exhausted allowance pauses automatic attention for your review. Muting or ending the connection stops new attention.</p>
      <details open><summary>Your instructions</summary><pre class="people-evidence-preview">{request}</pre></details>
      {!!notes.trim() && <details><summary>Reference material</summary><pre class="people-evidence-preview">{notes}</pre></details>}
      <div class="people-actions"><button class="ibtn is-primary" disabled={!connected || !available || enable.isPending} onClick={() => enable.mutate(review)}>{enable.isPending ? <LoadingState>enabling…</LoadingState> : enable.isError ? "retry same helper" : mode === "draft" ? "enable private assistance" : "enable replies within this allowance"}</button>{enable.isIdle && <button class="people-action" onClick={() => setReview(null)}>back to editing</button>}</div>
      {enable.isError && <p class="people-note">Creation is unconfirmed. Retry recovers the same helper; an already created helper may already be receiving new messages.</p>}
    </>}
    {!available && <p class="people-note">Automatic help needs an active, unmuted conversation with a GSV that identifies messages as human or Ship.</p>}
    {enable.error && <p class="people-error" role="alert">{enable.error.message}</p>}
    <button class="people-action" disabled={enable.isPending} onClick={onClose}>{enable.isError ? "close · inspect existing helpers" : "cancel"}</button>
  </section>;
}
