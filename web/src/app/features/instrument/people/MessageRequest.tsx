import type { ApproachSummary } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_APPROACHES_KEY, INSTRUMENT_CONTACT_BLOCKS_KEY, instrumentContactConversationKey } from "../wire/queryKeys";
import { LoadingState } from "../../../components/ui/Spinner";
import { approachStatus, requestMayRetry } from "./peopleModel";
import { ContactHandlingChoice } from "./ContactHandlingChoice";

export function MessageRequest({ request, account, onOpen }: {
  request: ApproachSummary; account: ConsoleAccount | undefined; onOpen: (contactId: string) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [blockConfirm, setBlockConfirm] = useState(false);
  const [shipHandlesMessages, setShipHandlesMessages] = useState<boolean | null>(null);
  const opened = useRef(request.state === "accepted");
  useEffect(() => {
    if (!opened.current && request.state === "accepted" && request.contactId) {
      opened.current = true;
      onOpen(request.contactId);
    }
  }, [request.state, request.contactId, onOpen]);
  const refresh = () => cache.invalidateQueries({ queryKey: INSTRUMENT_APPROACHES_KEY });
  const allowed = (name: string) => connected && !!account && canConfigure(account, name);
  const history = useQuery({
    queryKey: [...instrumentContactConversationKey(request.conversationId), "approach", request.messageSequence],
    enabled: allowed("conversation.history") && request.messageSequence !== undefined,
    queryFn: () => client.conversation.history({ conversationId: request.conversationId, beforeSequence: request.messageSequence! + 1, limit: 1 }),
  });
  const decide = useMutation({ mutationFn: (decision: "accept" | "decline" | "withdraw") => {
    if (decision === "accept" && shipHandlesMessages === null) throw new Error("Choose who should handle new messages");
    return client.approach.decide({ approachId: request.id, expectedRevision: request.revision, decision,
      shipHandlesMessages: decision === "accept" ? shipHandlesMessages! : undefined });
  }, onSuccess: refresh });
  const retry = useMutation({ mutationFn: () => client.approach.retry({ approachId: request.id, expectedRevision: request.revision }), onSuccess: refresh });
  const blockedQuery = useQuery({
    queryKey: [...INSTRUMENT_CONTACT_BLOCKS_KEY, request.peer], enabled: allowed("contact.block.list"),
    queryFn: () => client.contact.block.list({ actor: request.peer }),
  });
  const blocked = !!blockedQuery.data?.blocks.length;
  const canBlock = allowed("contact.block.set") && !!blockedQuery.data;
  const block = useMutation({
    mutationFn: () => client.contact.block.set({ actor: request.peer, blocked: !blocked }),
    onSuccess: async () => { setBlockConfirm(false); await Promise.all([refresh(), cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACT_BLOCKS_KEY })]); },
  });
  const pending = decide.isPending || retry.isPending || block.isPending;
  const text = history.data?.messages.find((message) => message.sequence === request.messageSequence)?.text;
  const canDecide = request.state === "pending" || request.state === "preparing";
  const error = history.error ?? decide.error ?? retry.error ?? block.error ?? blockedQuery.error;

  return <section class="people-request" aria-labelledby="message-request-title">
    <div class="people-kicker">{request.direction === "incoming" ? "Message request from" : "Your request to"}</div>
    <h1 id="message-request-title">{request.displayName}</h1>
    <p class="people-status" role="status">{approachStatus(request)}</p>
    {history.isFetching && !history.data && request.messageSequence !== undefined && <LoadingState variant="panel">Loading the first message…</LoadingState>}
    {!allowed("conversation.history") && connected && <p class="people-note">This account cannot read the first message.</p>}
    {text !== undefined && <article class="people-first-message"><p>{text}</p><time dateTime={new Date(request.createdAtMs).toISOString()}>{new Date(request.createdAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></article>}
    {request.state === "preparing" && <LoadingState>Sending…</LoadingState>}
    {canDecide && request.direction === "incoming" && <div class="people-decision">
      <ContactHandlingChoice value={shipHandlesMessages} disabled={pending || !allowed("contact.preferences.update")} onChange={setShipHandlesMessages} />
      <div class="people-actions"><button class="ibtn is-primary" disabled={!allowed("approach.decide") || pending || request.state !== "pending" || shipHandlesMessages === null} onClick={() => decide.mutate("accept")}>{decide.isPending && decide.variables === "accept" ? "accepting…" : "accept conversation"}</button><button class="people-action" disabled={!allowed("approach.decide") || pending} onClick={() => decide.mutate("decline")}>decline</button></div>
      <p class="people-note">Declining is private.</p>
    </div>}
    {canDecide && request.direction === "outgoing" && <div class="people-decision">
      <p class="people-note">Waiting for them to accept. Requests expire after 30 days.</p>
      <button class="people-action" disabled={!allowed("approach.decide") || pending} onClick={() => decide.mutate("withdraw")}>withdraw request</button>
    </div>}
    {requestMayRetry(request) && <div class="people-decision"><button class="ibtn" disabled={!allowed("approach.retry") || pending} onClick={() => retry.mutate()}>{retry.isPending ? "retrying…" : "retry"}</button></div>}
    {request.contactId && request.state === "accepted" && <button class="ibtn is-primary" onClick={() => onOpen(request.contactId!)}>open conversation</button>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    <details class="people-identity"><summary>Connection</summary>
      <dl><dt>Ship identity</dt><dd>{request.peer.shipId}</dd><dt>Person identity</dt><dd>{request.peer.subjectId}</dd></dl>
      {blockConfirm ? <div class="people-decision"><p>{blocked ? "Allow new requests from this person? The old connection stays ended." : "Block this person? This ends the connection and prevents new messages and requests."}</p><div class="people-actions"><button class="people-action is-danger" disabled={!canBlock || pending} onClick={() => block.mutate()}>{blocked ? "unblock" : "block"}</button><button class="people-action" disabled={pending} onClick={() => setBlockConfirm(false)}>cancel</button></div></div>
        : <button class="people-action is-danger" disabled={!canBlock || pending} onClick={() => setBlockConfirm(true)}>{blocked ? "unblock this person" : "block this person"}</button>}
    </details>
  </section>;
}
