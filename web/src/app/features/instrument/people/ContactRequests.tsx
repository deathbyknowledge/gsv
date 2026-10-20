import type { ContactRequestRecord, ContactRequestState, ContactSummary, JsonValue } from "@humansandmachines/gsv/protocol";
import { contactRequestTransitions } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useRef } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { refreshContactQuery } from "../wire/contactSync";
import { instrumentContactRequestsKey } from "../wire/queryKeys";
import { useT, type TextKey } from "../../../i18n/locale";

type NextState = Exclude<ContactRequestState, "offered">;
const LABELS = {
  accepted: "people.work.action.accepted", rejected: "people.work.action.rejected", active: "people.work.action.active",
  completed: "people.work.action.completed", cancelled: "common.cancel",
} satisfies Record<NextState, TextKey>;
const PENDING_LABELS = {
  accepted: "people.work.pending.accepted", rejected: "people.work.pending.rejected", active: "people.work.pending.active",
  completed: "people.work.pending.completed", cancelled: "people.work.pending.cancelled",
} satisfies Record<NextState, TextKey>;
const STATE_LABELS = {
  offered: "people.work.state.offered", accepted: "people.work.state.accepted", rejected: "people.work.state.rejected",
  active: "people.work.state.active", completed: "people.work.state.completed", cancelled: "people.work.state.cancelled",
} satisfies Record<ContactRequestState, TextKey>;

function RequestDetails({ value }: { value: JsonValue }) {
  if (value === null) return <span>—</span>;
  if (Array.isArray(value)) return <ul>{value.map((entry, index) => <li key={index}><RequestDetails value={entry} /></li>)}</ul>;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JsonValue is the parsed recursive protocol union; objects contain request detail fields.
  if (typeof value === "object") return <dl>{Object.entries(value).map(([key, entry]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><RequestDetails value={entry} /></dd></div>)}</dl>;
  return <span>{String(value)}</span>;
}

function RequestRow({ request, editable }: { request: ContactRequestRecord; editable: boolean }) {
  const t = useT();
  const { client } = useGateway();
  const cache = useQueryClient();
  const retry = useRef<{ revision: number; state: NextState; idempotencyKey: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (state: NextState) => {
      if (retry.current?.revision !== request.revision || retry.current.state !== state) {
        retry.current = { revision: request.revision, state, idempotencyKey: crypto.randomUUID() };
      }
      return client.contact.request.update({ requestId: request.id, expectedRevision: request.revision, state, idempotencyKey: retry.current.idempotencyKey });
    },
    onError: () => refreshContactQuery(cache, instrumentContactRequestsKey(request.contactId)),
  });
  const exchange = request.exchange?.state ?? "unconfirmed";
  const actions = exchange === "pending" || exchange === "failed" ? []
    : contactRequestTransitions(request.state, request.direction === "incoming" ? "performer" : "requester");
  return <article class="fleet-contact-request">
    <div class="sub">{t(request.direction === "incoming" ? "people.work.fromThem" : "people.work.fromYou", { state: t(STATE_LABELS[request.state]) })}</div>
    <h4>{request.title}</h4>
    <p class="note">{request.kind.replaceAll("_", " ")}</p>
    {exchange === "pending" && <p class="note"><LoadingState>{t("people.work.awaiting")}</LoadingState></p>}
    {exchange === "failed" && <p class="error">{t("people.work.notConfirmed")}</p>}
    {exchange === "unconfirmed" && <p class="note">{t("people.work.unconfirmed")}</p>}
    {request.exchange?.lastError && <p class="note">{request.exchange.lastError}</p>}
    {request.details && <details><summary>{t("people.details")}</summary><RequestDetails value={request.details} /></details>}
    {actions.length > 0 && <div class="fleet-actions">{actions.map((state) => <button key={state} class="fleet-text-action" disabled={!editable || mutation.isPending} onClick={() => mutation.mutate(state)}>{mutation.isPending && mutation.variables === state ? <LoadingState>{t(PENDING_LABELS[state])}</LoadingState> : t(LABELS[state])}</button>)}</div>}
    {mutation.error && <p class="error" role="alert">{mutation.error.message}</p>}
  </article>;
}

export function ContactRequests({ contact, account }: { contact: ContactSummary; account: ConsoleAccount | undefined }) {
  const t = useT();
  const { client, connected } = useGateway();
  const mayRead = !!account && canConfigure(account, "contact.request.list");
  const editable = connected && contact.state === "active" && !!account
    && (account.uid === 0 || account.uid === contact.ownerUid) && canConfigure(account, "contact.request.update");
  const query = useQuery({
    queryKey: instrumentContactRequestsKey(contact.id),
    enabled: connected && mayRead,
    queryFn: async () => (await client.contact.request.list({ contactId: contact.id, includeTerminal: true })).requests,
  });
  const terminal = (request: ContactRequestRecord) => ["completed", "rejected", "cancelled"].includes(request.state)
    && request.exchange?.state !== "pending" && request.exchange?.state !== "failed";
  const open = query.data?.filter((request) => !terminal(request)) ?? [];
  const closed = query.data?.filter(terminal) ?? [];
  return <section class="fleet-contact-requests" aria-label={t("people.work.label")}>
    {!mayRead && <p class="note">{t("people.work.noAccess")}</p>}
    {query.isPending && mayRead && connected && <LoadingState variant="panel">{t("people.work.loading")}</LoadingState>}
    {query.error && <p class="error" role="alert">{query.error.message} <button class="fleet-text-action" disabled={!connected} onClick={() => void query.refetch()}>{t("people.retry")}</button></p>}
    {query.data && open.length === 0 && <p class="note">{t("people.work.none")}</p>}
    {open.map((request) => <RequestRow key={request.id} request={request} editable={editable} />)}
    {closed.length > 0 && <details class="fleet-contact-closed"><summary>{t("people.work.past", { count: closed.length })}</summary>{closed.map((request) => <RequestRow key={request.id} request={request} editable={false} />)}</details>}
    {!connected && <p class="note">{t("people.reconnectingNote")}</p>}
  </section>;
}
