import type { ApproachSummary } from "@humansandmachines/gsv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_APPROACHES_KEY, instrumentContactConversationKey } from "../wire/queryKeys";
import { LoadingState } from "../../../components/ui/Spinner";
import { approachStatus, requestMayRetry } from "./peopleModel";
import { ReportEvidence } from "./ReportEvidence";

export function MessageRequest({ request, account, onOpen, onDirty }: {
  request: ApproachSummary; account: ConsoleAccount | undefined; onOpen: (contactId: string) => void; onDirty: (dirty: boolean) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [blockConfirm, setBlockConfirm] = useState(false);
  const [reporting, setReporting] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: INSTRUMENT_APPROACHES_KEY });
  const allowed = (name: string) => connected && !!account && canConfigure(account, name);
  const history = useQuery({
    queryKey: [...instrumentContactConversationKey(request.conversationId), "approach", request.messageSequence],
    enabled: allowed("conversation.history") && request.messageSequence !== undefined,
    queryFn: () => client.conversation.history({ conversationId: request.conversationId, beforeSequence: request.messageSequence! + 1, limit: 1 }),
  });
  const decide = useMutation({ mutationFn: (decision: "accept" | "decline" | "withdraw") => client.approach.decide({ approachId: request.id, expectedRevision: request.revision, decision }), onSuccess: refresh });
  const retry = useMutation({ mutationFn: () => client.approach.retry({ approachId: request.id, expectedRevision: request.revision }), onSuccess: refresh });
  const block = useMutation({ mutationFn: () => client.contact.block.set({ actor: request.peer, blocked: true }), onSuccess: async () => { setBlockConfirm(false); await refresh(); } });
  const pending = decide.isPending || retry.isPending || block.isPending;
  const message = history.data?.messages.find((message) => message.sequence === request.messageSequence);
  const text = message?.text;
  const canDecide = request.state === "pending" || request.state === "preparing";
  const error = history.error ?? decide.error ?? retry.error ?? block.error;

  if (reporting && message) return <ReportEvidence messages={[message]} account={account} onDirty={onDirty} onOpen={onOpen} onClose={() => setReporting(false)} />;
  return <section class="people-request" aria-labelledby="message-request-title">
    <div class="people-kicker">{request.direction === "incoming" ? "Message request from" : "Your request to"}</div>
    <h1 id="message-request-title">{request.displayName}</h1>
    <p class="people-status" role="status">{approachStatus(request)}</p>
    {history.isFetching && !history.data && request.messageSequence !== undefined && <LoadingState variant="panel">Loading the first message…</LoadingState>}
    {!allowed("conversation.history") && connected && <p class="people-note">This account cannot read the first message.</p>}
    {text !== undefined && <article class="people-first-message"><p>{text}</p><time dateTime={new Date(request.createdAtMs).toISOString()}>{new Date(request.createdAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></article>}
    {message && request.direction === "incoming" && <button class="people-action" disabled={pending || !allowed("contact.send")} onClick={() => setReporting(true)}>report this message…</button>}
    {request.state === "preparing" && <p class="people-note">Your message is saved. It’s being added to the conversation before delivery.</p>}
    {canDecide && request.direction === "incoming" && <div class="people-decision">
      <h2>Open a conversation?</h2>
      <p class="people-note">Accept to exchange messages and attachments with this person. You can save them as a contact afterwards. Your Ship won’t respond unless you ask it to.</p>
      <div class="people-actions"><button class="ibtn is-primary" disabled={!allowed("approach.decide") || pending || request.state !== "pending"} onClick={() => decide.mutate("accept")}>{decide.isPending && decide.variables === "accept" ? "accepting…" : "accept conversation"}</button><button class="people-action" disabled={!allowed("approach.decide") || pending} onClick={() => decide.mutate("decline")}>decline</button></div>
      <p class="people-note">Declining does not notify the sender.</p>
    </div>}
    {canDecide && request.direction === "outgoing" && <div class="people-decision">
      <p class="people-note">They can read this first message and decide whether to open a conversation. Requests expire after 30 days.</p>
      <button class="people-action" disabled={!allowed("approach.decide") || pending} onClick={() => decide.mutate("withdraw")}>withdraw request</button>
    </div>}
    {requestMayRetry(request) && <div class="people-decision"><p class="people-note">Retry resumes the same request. It won’t send a second message or create a second connection.</p><button class="ibtn" disabled={!allowed("approach.retry") || pending} onClick={() => retry.mutate()}>{retry.isPending ? "retrying…" : "retry"}</button></div>}
    {request.contactId && request.state === "accepted" && <button class="ibtn is-primary" onClick={() => onOpen(request.contactId!)}>open conversation</button>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    <details class="people-identity"><summary>Identity and controls</summary>
      <p class="people-note">This request is authenticated to one GSV identity. A display name alone does not identify a person you know.</p>
      <dl><dt>Ship identity</dt><dd>{request.peer.shipId}</dd><dt>Person identity</dt><dd>{request.peer.subjectId}</dd></dl>
      {request.state !== "blocked" && (blockConfirm ? <div class="people-decision"><p>Block {request.displayName}? This ends current communication and prevents new requests from this identity. Previous messages already received cannot be recalled.</p><div class="people-actions"><button class="people-action is-danger" disabled={!allowed("contact.block.set") || pending} onClick={() => block.mutate()}>block this person</button><button class="people-action" disabled={pending} onClick={() => setBlockConfirm(false)}>cancel</button></div></div>
        : <button class="people-action is-danger" disabled={!allowed("contact.block.set") || pending} onClick={() => setBlockConfirm(true)}>block this person</button>)}
    </details>
  </section>;
}
