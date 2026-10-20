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
import { useT } from "../../../i18n/locale";

export function MessageRequest({ request, account, onOpen }: {
  request: ApproachSummary; account: ConsoleAccount | undefined; onOpen: (contactId: string) => void;
}) {
  const t = useT();
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
    if (decision === "accept" && shipHandlesMessages === null) throw new Error(t("people.handling.required"));
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
    <div class="people-kicker">{t(request.direction === "incoming" ? "people.request.from" : "people.request.to")}</div>
    <h1 id="message-request-title">{request.displayName}</h1>
    <p class="people-status" role="status">{t(approachStatus(request))}</p>
    {history.isFetching && !history.data && request.messageSequence !== undefined && <LoadingState variant="panel">{t("people.request.loadingFirst")}</LoadingState>}
    {!allowed("conversation.history") && connected && <p class="people-note">{t("people.request.noRead")}</p>}
    {text !== undefined && <article class="people-first-message"><p>{text}</p><time dateTime={new Date(request.createdAtMs).toISOString()}>{new Date(request.createdAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></article>}
    {request.state === "preparing" && <LoadingState>{t("people.status.sending")}</LoadingState>}
    {canDecide && request.direction === "incoming" && <div class="people-decision">
      <ContactHandlingChoice value={shipHandlesMessages} disabled={pending || !allowed("contact.preferences.update")} onChange={setShipHandlesMessages} />
      <div class="people-actions"><button class="ibtn is-primary" disabled={!allowed("approach.decide") || pending || request.state !== "pending" || shipHandlesMessages === null} onClick={() => decide.mutate("accept")}>{t(decide.isPending && decide.variables === "accept" ? "people.request.accepting" : "people.request.accept")}</button><button class="people-action" disabled={!allowed("approach.decide") || pending} onClick={() => decide.mutate("decline")}>{t("people.request.decline")}</button></div>
      <p class="people-note">{t("people.request.declinePrivate")}</p>
    </div>}
    {canDecide && request.direction === "outgoing" && <div class="people-decision">
      <p class="people-note">{t("people.request.waiting")}</p>
      <button class="people-action" disabled={!allowed("approach.decide") || pending} onClick={() => decide.mutate("withdraw")}>{t("people.request.withdraw")}</button>
    </div>}
    {requestMayRetry(request) && <div class="people-decision"><button class="ibtn" disabled={!allowed("approach.retry") || pending} onClick={() => retry.mutate()}>{t(retry.isPending ? "people.retrying" : "people.retry")}</button></div>}
    {request.contactId && request.state === "accepted" && <button class="ibtn is-primary" onClick={() => onOpen(request.contactId!)}>{t("people.request.openConversation")}</button>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    <details class="people-identity"><summary>{t("people.connection.title")}</summary>
      <dl><dt>{t("people.request.shipIdentity")}</dt><dd>{request.peer.shipId}</dd><dt>{t("people.request.personIdentity")}</dt><dd>{request.peer.subjectId}</dd></dl>
      {blockConfirm ? <div class="people-decision"><p>{t(blocked ? "people.connection.confirmUnblock" : "people.request.confirmBlock")}</p><div class="people-actions"><button class="people-action is-danger" disabled={!canBlock || pending} onClick={() => block.mutate()}>{t(blocked ? "people.unblock" : "people.block")}</button><button class="people-action" disabled={pending} onClick={() => setBlockConfirm(false)}>{t("common.cancel")}</button></div></div>
        : <button class="people-action is-danger" disabled={!canBlock || pending} onClick={() => setBlockConfirm(true)}>{t(blocked ? "people.request.unblockPerson" : "people.request.blockPerson")}</button>}
    </details>
  </section>;
}
