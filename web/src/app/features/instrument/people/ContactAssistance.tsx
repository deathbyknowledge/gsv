import type { ContactSummary, ProcListEntry, ProcessScope, ResourceBlock } from "@humansandmachines/gsv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useState } from "preact/hooks";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useChatConversation } from "../../../services/chat/hooks/useChatConversation";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";
import { procSignalSchema } from "../wire/wireModel";
import { ZenMedia } from "../zen/ZenMedia";
import { ZenText } from "../zen/ZenText";
import { ContactDrafts, ReplyReview, helperReplyMedia, type ReplyForReview } from "./ContactDrafts";
import { selectedMessageCopies } from "./socialAssistance";
import { AutomaticHelp } from "./AutomaticHelp";

export function ContactAssistance({ contact, account, initialPid, onDirty, onOpenWork, onMessages }: {
  contact: ContactSummary; account: ConsoleAccount; initialPid: string | null; onDirty: (dirty: boolean) => void;
  onOpenWork: (pid: string) => void; onMessages: () => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [selected, setSelected] = useState(initialPid);
  const [reply, setReply] = useState<ReplyForReview | null>(null);
  const [automatic, setAutomatic] = useState(false);
  const key = [...INSTRUMENT_PROCESSES_KEY, "social", contact.conversationId];
  const helpers = useQuery({ queryKey: key, enabled: connected && canConfigure(account, "proc.list"),
    queryFn: () => client.proc.list({ conversationId: contact.conversationId }) });
  const processes = [...(helpers.data?.processes ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  useEffect(() => client.onSignal((signal, payload) => {
    if (signal !== "proc.changed" && signal !== "process.exit") return;
    const change = procSignalSchema.safeParse(payload);
    if (!change.success || (!change.data.changes?.includes("created") && !helpers.data?.processes.some((process) => process.pid === change.data.pid))) return;
    void cache.invalidateQueries({ queryKey: [...INSTRUMENT_PROCESSES_KEY, "social", contact.conversationId] });
  }), [client, cache, contact.conversationId, helpers.data]);
  const helper = processes.find((process) => process.pid === selected) ?? (selected ? undefined : processes[0]);
  if (automatic) return <AutomaticHelp contact={contact} onDirty={onDirty} onClose={() => setAutomatic(false)} onEnabled={(pid) => {
    setSelected(pid); setAutomatic(false); void helpers.refetch();
  }} />;
  if (reply) return <ReplyReview contact={contact} account={account} reply={reply} onDirty={onDirty} onClose={() => setReply(null)} />;
  return <section class="people-assistance" aria-labelledby="contact-help-title">
    <div class="people-kicker">Only by invitation</div><h2 id="contact-help-title">Ship help</h2>
    <p class="people-note">Private work about this conversation. Choose messages in the conversation, then ask Ship for help with just that material.</p>
    <button class="people-action" disabled={contact.state !== "active"} onClick={onMessages}>choose messages for new help →</button>
    {canConfigure(account, "proc.spawn") && <button class="people-action" disabled={!connected || contact.state !== "active"} onClick={() => setAutomatic(true)}>set up help with new messages…</button>}
    {helpers.isPending && connected && <LoadingState>Loading private work…</LoadingState>}
    {helpers.error && <p class="people-error" role="alert">{helpers.error.message}<button class="people-action" disabled={!connected} onClick={() => void helpers.refetch()}>retry</button></p>}
    {helpers.data && !processes.length && <p class="people-note">No helpers for this conversation yet. Incoming messages do not start one.</p>}
    {processes.length > 0 && <label>Private work<select value={helper?.pid ?? ""} onChange={(event) => setSelected(event.currentTarget.value)}><option value="" disabled>Choose a helper</option>{processes.map((process) => <option value={process.pid} key={process.pid}>{process.label || "Conversation help"}{process.parentPid ? " · delegated work" : ""} · {new Date(process.createdAt).toLocaleString()}</option>)}</select></label>}
    {selected && !helper && helpers.data && <p class="people-note">This helper is no longer available. Saved draft reviews remain below.</p>}
    {helper && <PrivateHelper key={helper.pid} helper={helper} processes={processes} contact={contact} account={account} onReply={setReply} onOpenWork={onOpenWork} />}
    {canConfigure(account, "contact.draft.list") && <ContactDrafts contact={contact} account={account} />}
  </section>;
}

function PrivateHelper({ helper, processes, contact, account, onReply, onOpenWork }: {
  helper: ProcListEntry; processes: ProcListEntry[]; contact: ContactSummary; account: ConsoleAccount;
  onReply: (reply: ReplyForReview) => void; onOpenWork: (pid: string) => void;
}) {
  const { client, connected } = useGateway();
  const scope = useQuery({ queryKey: [...INSTRUMENT_PROCESSES_KEY, "social", contact.conversationId, helper.pid],
    enabled: connected && canConfigure(account, "proc.scope.get"), queryFn: () => client.proc.scope.get({ pid: helper.pid }) });
  const conversation = useChatConversation({ processId: helper.pid, enabled: canConfigure(account, "conversation.history") });
  const [now, setNow] = useState(Date.now);
  const grant = scope.data?.scope;
  useEffect(() => {
    if (!grant || grant.policy.expiresAtMs <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, grant.policy.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [grant, now]);
  const revoke = useMutation({ mutationFn: () => client.proc.scope.revoke({ pid: helper.pid, expectedRevision: grant!.revision }), onSettled: () => scope.refetch() });
  const initial = grant?.policy.materials.find((material) => material.name === "request.txt")?.text;
  const resume = useMutation({ mutationFn: () => client.conversation.send({ conversationId: conversation.conversation!.id, text: initial!, idempotencyKey: `${helper.pid}:initial` }), onSuccess: (result) => conversation.acceptMessage(result.message) });
  const active = !!grant && grant.state === "active" && grant.policy.expiresAtMs > now && contact.state === "active"
    && grant.policy.conversations.every((entry) => entry.contactId !== contact.id || entry.generation === contact.generation);
  const allowance = !!grant && grant.used.generations < grant.policy.budgets.generations;
  const automaticRootRemoved = !!grant?.policy.automatic && !processes.some((process) => process.pid === grant.rootPid);
  const resources: ResourceBlock[] = grant?.policy.resources.map((ref) => ({ type: "resource", ref, filename: ref.path.split("/").at(-1) })) ?? [];
  return <section class="people-private-helper" aria-label="Private helper replies">
    {scope.isPending && connected && <LoadingState>Loading access…</LoadingState>}
    {grant && <>
      <div class="people-helper-heading"><span class="people-kicker">{!active ? "Access ended" : automaticRootRemoved ? "Original helper removed" : grant.automation?.pausedReason ? "Automatic attention paused" : !allowance ? "Allowance used" : helper.state === "idle" ? grant.policy.automatic && helper.pid === grant.rootPid ? "Waiting for new human messages" : "Private helper" : helper.state === "waiting_hil" ? "Waiting for your decision" : "Working"}</span><button class="people-action" onClick={() => onOpenWork(helper.pid)}>open work and continue →</button></div>
      <HelperAccess scope={grant} />
      {automaticRootRemoved && active && <p class="people-note">The original automatic helper was removed. This delegated work retains the shared access until you stop it or it expires. Stop it before setting up a new automatic helper.</p>}
      {grant.policy.automatic && <p class="people-note">{grant.policy.automatic.mode === "draft" ? "Prepares private replies for your review." : "May reply to this person as your Ship within the reviewed allowance."} {grant.automation?.acceptedMessages ?? 0} of {grant.policy.automatic.maxMessages} incoming messages admitted · {grant.automation?.pendingMessages ?? 0} waiting.</p>}
      {grant.automation?.pausedReason && <p class="people-note">Paused: {grant.automation.pausedReason}. Review this work, then stop it before choosing a new allowance.</p>}
      {active && canConfigure(account, "proc.scope.revoke") && <button class="people-action is-danger" disabled={!connected || revoke.isPending} onClick={() => revoke.mutate()}>{revoke.isPending ? "stopping…" : "stop helper and revoke access"}</button>}
      {!active && <p class="people-note">This helper cannot do more work. Its private replies and saved reviews remain available.</p>}
      {active && !allowance && <p class="people-note">The model-request allowance is used. Review its replies or choose messages for a fresh helper.</p>}
      {active && allowance && !grant.policy.automatic && conversation.loaded && conversation.rows.length === 0 && !!initial && <div><p class="people-note">This helper was created, but its first message was not confirmed.</p><button class="ibtn" disabled={!connected || resume.isPending || !conversation.conversation} onClick={() => resume.mutate()}>{resume.isPending ? "recovering…" : "start with the reviewed message"}</button></div>}
    </>}
    {(scope.error || revoke.error || resume.error || conversation.historyError) && <p class="people-error" role="alert">{scope.error?.message || revoke.error?.message || resume.error?.message || conversation.historyError?.message}<button class="people-action" disabled={!connected} onClick={() => { void scope.refetch(); void conversation.retryHistory(); }}>refresh</button></p>}
    {conversation.hasMore && <button class="people-action" disabled={conversation.loadingOlder || !connected} onClick={() => void conversation.loadOlder()}>earlier private messages</button>}
    {conversation.historyLoading && <LoadingState>Opening private replies…</LoadingState>}
    {conversation.rows.map((row) => <article key={row.id} class={`people-helper-message${row.role === "user" ? " is-owner" : ""}`}>
      <header>{row.role === "user" ? "Your instruction" : "Your Ship · private"}{row.streaming && <span role="status"> · writing…</span>}</header>
      {row.role === "user" ? <details><summary>Your message to the helper</summary><pre class="people-evidence-preview">{row.text}</pre></details> : <ZenText text={row.text} markdown progress={null} tick={0} />}
      {row.media?.map((media, index) => <ZenMedia key={index} media={media} processId={helper.pid} onReady={() => undefined} />)}
      {row.role === "assistant" && !row.streaming && row.conversationMessageId && row.conversationSequence && conversation.conversation && <button class="people-action" disabled={!connected || contact.state !== "active" || !canConfigure(account, "contact.draft.create")} onClick={() => onReply({
        source: { conversationId: conversation.conversation!.id, messageId: row.conversationMessageId!, sequence: row.conversationSequence! },
        text: row.text, media: helperReplyMedia(row.media ?? [], resources),
      })}>prepare this as a reply…</button>}
    </article>)}
  </section>;
}

function HelperAccess({ scope }: { scope: ProcessScope }) {
  return <details class="people-helper-access"><summary>Access and remaining allowance</summary><dl>
    <dt>Messages</dt><dd>{scope.policy.conversations.some((entry) => entry.read) ? "Selected conversations, including new messages" : "Only the selected message copies"}</dd>
    <dt>Files</dt><dd>{scope.policy.resources.length} selected attachments</dd>
    <dt>Remote replies</dt><dd>{scope.policy.budgets.messages === 0 ? "Requires your approval for each draft" : `${Math.max(0, scope.policy.budgets.messages - scope.used.messages)} left`}</dd>
    <dt>Model requests</dt><dd>{Math.max(0, scope.policy.budgets.generations - scope.used.generations)} of {scope.policy.budgets.generations} left</dd>
    <dt>Processes</dt><dd>{scope.used.processes} of {scope.policy.budgets.processes} created; allowances and stop apply to the whole helper family</dd>
    <dt>Expires</dt><dd>{new Date(scope.policy.expiresAtMs).toLocaleString()}</dd>
  </dl>{scope.policy.automatic && <details><summary>Your instructions for new messages</summary><pre class="people-evidence-preview">{scope.policy.automatic.request}</pre></details>}{scope.policy.materials.map((material) => {
    const messages = material.name === "exchange.json" ? selectedMessageCopies(material.text) : null;
    return <details key={material.name}><summary>{messages ? "Selected message copies" : material.name === "request.txt" ? "Your initial instruction" : material.name === "notes.txt" ? "Additional material" : material.name}</summary>{messages ? messages.map((message) => <blockquote class="people-reply-quote" key={message.messageId}><strong>{message.authorLabel || "Message"}</strong><p>{message.text || "Attachment message"}</p></blockquote>) : <pre class="people-evidence-preview">{material.text}</pre>}</details>;
  })}</details>;
}
