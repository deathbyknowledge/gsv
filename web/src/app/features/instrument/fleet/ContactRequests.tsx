import type { ContactRequestRecord, ContactRequestState, ContactSummary, JsonValue } from "@humansandmachines/gsv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useRef } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../gsv-console/domain/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { refreshContactQuery } from "../wire/contactSync";
import { instrumentContactRequestsKey } from "../wire/queryKeys";

type NextState = Exclude<ContactRequestState, "offered">;
const LABELS = { accepted: "accept", rejected: "reject", active: "start", completed: "complete", cancelled: "cancel" } satisfies Record<NextState, string>;

function RequestDetails({ value }: { value: JsonValue }) {
  if (value === null) return <span>—</span>;
  if (Array.isArray(value)) return <ul>{value.map((entry, index) => <li key={index}><RequestDetails value={entry} /></li>)}</ul>;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JsonValue is the parsed recursive protocol union; objects contain request detail fields.
  if (typeof value === "object") return <dl>{Object.entries(value).map(([key, entry]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><RequestDetails value={entry} /></dd></div>)}</dl>;
  return <span>{String(value)}</span>;
}

function RequestRow({ request, editable }: { request: ContactRequestRecord; editable: boolean }) {
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
  const actions: NextState[] = request.state === "offered" ? request.direction === "incoming" ? ["accepted", "rejected"] : ["cancelled"]
    : request.state === "accepted" ? ["active", "completed", "cancelled"] : request.state === "active" ? ["completed", "cancelled"] : [];
  return <article class="fleet-contact-request">
    <div class="sub">{request.direction === "incoming" ? "from them" : "from you"} · {request.state}</div>
    <h4>{request.title}</h4>
    <p class="note">{request.kind.replaceAll("_", " ")}</p>
    {request.details && <details><summary>details</summary><RequestDetails value={request.details} /></details>}
    {actions.length > 0 && <div class="fleet-actions">{actions.map((state) => <button key={state} class="contact-link" disabled={!editable || mutation.isPending} onClick={() => mutation.mutate(state)}>{mutation.isPending && mutation.variables === state ? <LoadingState>{LABELS[state]}…</LoadingState> : LABELS[state]}</button>)}</div>}
    {mutation.error && <p class="error" role="alert">{mutation.error.message}</p>}
  </article>;
}

export function ContactRequests({ contact, account }: { contact: ContactSummary; account: ConsoleAccount | undefined }) {
  const { client, connected } = useGateway();
  const mayRead = !!account && canConfigure(account, "contact.request.list");
  const editable = connected && contact.state === "active" && !!account
    && (account.uid === 0 || account.uid === contact.ownerUid) && canConfigure(account, "contact.request.update");
  const query = useQuery({
    queryKey: instrumentContactRequestsKey(contact.id),
    enabled: connected && mayRead,
    queryFn: async () => (await client.contact.request.list({ contactId: contact.id, includeTerminal: true })).requests,
  });
  const terminal = (request: ContactRequestRecord) => ["completed", "rejected", "cancelled"].includes(request.state);
  const open = query.data?.filter((request) => !terminal(request)) ?? [];
  const closed = query.data?.filter(terminal) ?? [];
  return <section class="fleet-contact-requests" aria-label="Contact requests">
    {!mayRead && <p class="note">Your account cannot read requests.</p>}
    {query.isPending && mayRead && connected && <LoadingState variant="panel">Loading requests…</LoadingState>}
    {query.error && <p class="error" role="alert">{query.error.message} <button class="contact-link" disabled={!connected} onClick={() => void query.refetch()}>retry</button></p>}
    {query.data && open.length === 0 && <p class="note">No open requests.</p>}
    {open.map((request) => <RequestRow key={request.id} request={request} editable={editable} />)}
    {closed.length > 0 && <details class="fleet-contact-closed"><summary>{closed.length} past {closed.length === 1 ? "request" : "requests"}</summary>{closed.map((request) => <RequestRow key={request.id} request={request} editable={false} />)}</details>}
    {!connected && <p class="note">Reconnecting…</p>}
  </section>;
}
