import { RequestDetails } from "./RequestDetails";
import { WorkRequestRow } from "./WorkRequestRow";
import { WorkRequestEditor, type WorkEditorSelection } from "./WorkRequestEditor";
import type { ContactRequestRecord, ContactRequestState, ContactSummary } from "@humansandmachines/gsv/protocol";
import { contactRequestTransitions, projectWork } from "@humansandmachines/gsv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useRef, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { refreshContactQuery } from "../wire/contactSync";
import { instrumentContactRequestsKey } from "../wire/queryKeys";

type NextState = Exclude<ContactRequestState, "offered">;
const LABELS = { accepted: "accept", rejected: "reject", active: "start", completed: "complete", cancelled: "cancel" } satisfies Record<NextState, string>;

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
  const exchange = request.exchange?.state ?? "unconfirmed";
  const actions = exchange === "pending" || exchange === "failed" ? []
    : contactRequestTransitions(request.state, request.direction === "incoming" ? "performer" : "requester");
  return <article class="fleet-contact-request">
    <div class="sub">{request.direction === "incoming" ? "from them" : "from you"} · {request.state}</div>
    <h4>{request.title}</h4>
    <p class="note">{request.kind.replaceAll("_", " ")}</p>
    {exchange === "pending" && <p class="note"><LoadingState>Awaiting delivery confirmation…</LoadingState></p>}
    {exchange === "failed" && <p class="error">The other GSV has not confirmed this update. This request is unsettled.</p>}
    {exchange === "unconfirmed" && <p class="note">Confirmation is unavailable for this recorded state.</p>}
    {request.exchange?.lastError && <p class="note">{request.exchange.lastError}</p>}
    {request.details && <details><summary>details</summary><RequestDetails value={request.details} /></details>}
    {actions.length > 0 && <div class="fleet-actions">{actions.map((state) => <button key={state} class="fleet-text-action" disabled={!editable || mutation.isPending} onClick={() => mutation.mutate(state)}>{mutation.isPending && mutation.variables === state ? <LoadingState>{LABELS[state]}…</LoadingState> : LABELS[state]}</button>)}</div>}
    {mutation.error && <p class="error" role="alert">{mutation.error.message}</p>}
  </article>;
}

export function ContactRequests({ contact, account, onDirty }: { contact: ContactSummary; account: ConsoleAccount | undefined; onDirty: (dirty: boolean) => void }) {
  const [editor, setEditor] = useState<WorkEditorSelection | null>(null);
  const { client, connected } = useGateway();
  const mayRead = !!account && canConfigure(account, "contact.request.list");
  const editable = connected && contact.state === "active" && !!account
    && (account.uid === 0 || account.uid === contact.ownerUid);
  const legacyEditable = editable && !!account && canConfigure(account, "contact.request.update");
  const workEditable = editable && !!account && canConfigure(account, "contact.request.act");
  const mayCreate = editable && !!account && canConfigure(account, "contact.request.create");
  const query = useQuery({
    queryKey: instrumentContactRequestsKey(contact.id),
    enabled: connected && mayRead,
    queryFn: async () => (await client.contact.request.list({ contactId: contact.id, includeTerminal: true })).requests,
  });
  const terminal = (request: ContactRequestRecord) => contact.state !== "active" || request.contactGeneration !== contact.generation
    || ["completed", "rejected", "cancelled"].includes(request.state)
    && request.exchange?.state !== "pending" && request.exchange?.state !== "failed"
    && (!request.work || request.state !== "completed" || projectWork(request.work).outcome === "acknowledged");
  const open = query.data?.filter((request) => !terminal(request)) ?? [];
  const closed = query.data?.filter(terminal) ?? [];
  const editing = editor?.kind === "action" ? query.data?.find((request) => request.id === editor.request.id) : undefined;
  const form = editor && <WorkRequestEditor key={editor.kind === "action" ? `${editor.request.id}:${editor.action}` : "offer"}
    selection={editor} contact={contact} currentRevision={editing?.revision} allowed={editor.kind === "offer" ? mayCreate : workEditable}
    onClose={() => setEditor(null)} onDirty={onDirty} />;
  const renderRequest = (request: ContactRequestRecord) => request.work ? <WorkRequestRow key={request.id} request={request} work={request.work}
    editable={workEditable && request.contactGeneration === contact.generation} busy={!!editor} onAction={(action) => setEditor({ kind: "action", request, action })}>
    {editor?.kind === "action" && editor.request.id === request.id && form}
  </WorkRequestRow> : <RequestRow key={request.id} request={request} editable={legacyEditable && !editor && request.contactGeneration === contact.generation} />;
  return <section class="fleet-contact-requests" aria-label="Work requests">
    <p class="note">Offers and explicit status reports with this person. Your private execution details stay in Fleet.</p>
    {!editor && <button class="fleet-text-action" disabled={!mayCreate} onClick={() => setEditor({ kind: "offer" })}>offer work…</button>}
    {editor?.kind === "offer" && form}
    {!mayRead && <p class="note">Your account cannot read requests.</p>}
    {query.isPending && mayRead && connected && <LoadingState variant="panel">Loading requests…</LoadingState>}
    {query.error && <p class="error" role="alert">{query.error.message} <button class="fleet-text-action" disabled={!connected} onClick={() => void query.refetch()}>retry</button></p>}
    {query.data && open.length === 0 && <p class="note">No open requests.</p>}
    {open.map(renderRequest)}
    {closed.length > 0 && <details class="fleet-contact-closed"><summary>{closed.length} past {closed.length === 1 ? "request" : "requests"}</summary>{closed.map(renderRequest)}</details>}
    {!connected && <p class="note">Reconnecting…</p>}
  </section>;
}
