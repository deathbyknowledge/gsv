import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { contactDisplayName, type ContactContextConsentArgs, type SharedContextConsentRequest, type SharedContextPublication } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { useDraftGuard } from "../shared/useDraftGuard";
import { INSTRUMENT_CONTACTS_KEY, INSTRUMENT_SHARED_CONTEXT_KEY } from "../wire/queryKeys";
import { refreshContactQuery } from "../wire/contactSync";
import { LoadingState } from "../../../components/ui/Spinner";
import { ContextStatement } from "./ContextStatement";
import { ContextPublicationEditor } from "./ContextPublicationEditor";

const NO_CURSOR: string | undefined = undefined;
type Selection = { kind: "edit" | "withdraw"; publication: SharedContextPublication } | { kind: "consent"; request: SharedContextConsentRequest };

export function SharedContextManager({ account, onDirty, onOpen }: {
  account: ConsoleAccount | undefined; onDirty: (dirty: boolean) => void; onOpen: (id: string) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [section, setSection] = useState<"publications" | "consents">("publications");
  const [selection, setSelection] = useState<Selection | null>(null);
  const allowed = (name: string) => connected && !!account && account.uid >= 1000 && canConfigure(account, name);
  const result = useInfiniteQuery({ queryKey: [...INSTRUMENT_SHARED_CONTEXT_KEY, "owned", section], enabled: allowed("contact.context.publications"),
    initialPageParam: NO_CURSOR, queryFn: ({ pageParam }) => client.contact.context.publications({ section, cursor: pageParam, limit: 20 }), getNextPageParam: (page) => page.next });
  const publications = result.data?.pages.flatMap((page) => page.publications) ?? [];
  const requests = result.data?.pages.flatMap((page) => page.consentRequests) ?? [];
  const ids = [...new Set(requests.map((request) => request.contactId))].sort();
  const nameQueries = useQueries({ queries: Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => {
    const selected = ids.slice(index * 100, (index + 1) * 100);
    return { queryKey: [...INSTRUMENT_CONTACTS_KEY, "consent-sources", selected], enabled: allowed("contact.list"),
      queryFn: () => client.contact.list({ ids: selected, includeRevoked: true, limit: 100 }) };
  }) });
  const names = nameQueries.flatMap((query) => query.data?.contacts ?? []);
  const withdraw = useMutation({ mutationFn: (value: SharedContextPublication) => client.contact.context.withdraw({ id: value.record.assertion.id, expectedRevision: value.record.assertion.revision }),
    onSuccess: async () => { setSelection(null); await refreshContactQuery(cache, INSTRUMENT_SHARED_CONTEXT_KEY); } });
  const close = () => setSelection(null);
  if (selection?.kind === "edit") return <ContextPublicationEditor subject={selection.publication.record.assertion.subject} existing={selection.publication}
    account={account} allowConnection={selection.publication.record.assertion.kind === "connection"} onClose={close} onDirty={onDirty} />;
  if (selection?.kind === "consent") return <ConsentReview request={selection.request}
    current={requests.find((request) => request.contactId === selection.request.contactId && request.record.assertion.id === selection.request.record.assertion.id)}
    account={account} onClose={close} onDirty={onDirty} />;
  return <section class="people-context-manager" aria-label="Your shared context">
    <div class="people-kicker">Deliberate disclosure</div><h2>Your shared context</h2>
    <p class="people-note">Review what you share and which connections you agree to disclose. To write a new statement, open a person's details and choose “share about this person”.</p>
    <nav class="people-directions" aria-label="Shared context sections"><button class="people-action" aria-pressed={section === "publications"} onClick={() => { setSection("publications"); close(); }}>your statements</button><button class="people-action" aria-pressed={section === "consents"} onClick={() => { setSection("consents"); close(); }}>connection consent</button></nav>
    {result.isPending && allowed("contact.context.publications") && <LoadingState variant="panel">Loading shared context…</LoadingState>}
    {!allowed("contact.context.publications") && <p class="people-note">{connected ? "This account cannot manage shared context." : "Reconnect to manage shared context."}</p>}
    {result.data && !publications.length && !requests.length && <p class="people-context-empty">{section === "publications" ? "You have no shared statements here." : "There are no current connection proposals to review."}</p>}
    <ul class="people-context-list">{publications.map((entry) => {
      const a = entry.record.assertion;
      const withdrawing = selection?.kind === "withdraw" && selection.publication.record.assertion.id === a.id;
      return <li key={a.id}><p class="people-context-meta">{entry.state === "awaiting-consent" ? "Waiting for their consent" : entry.state === "published" ? "Available to subscribed direct contacts" : entry.state === "withdrawn" ? "Withdrawn" : "Expired"}</p>
        <ContextStatement assertion={a} />
        {entry.deliveryId && <ContextDelivery deliveryId={entry.deliveryId} account={account} />}
        {withdrawing ? <div class="people-decision"><p>Withdraw this statement and any pending consent proposal? Recipients will receive a removal notice. Offline copies expire within their existing display lease.</p>
          <div class="people-actions"><button class="people-action is-danger" disabled={!allowed("contact.context.withdraw") || withdraw.isPending} onClick={() => withdraw.mutate(entry)}>{withdraw.isPending ? "withdrawing…" : "withdraw statement"}</button><button class="people-action" disabled={withdraw.isPending} onClick={close}>keep it</button></div></div>
          : <div class="people-actions"><button class="people-action" disabled={!allowed("contact.context.publish")} onClick={() => setSelection({ kind: "edit", publication: entry })}>review a revision…</button>
            {entry.state !== "withdrawn" && entry.state !== "expired" && <button class="people-action" disabled={!allowed("contact.context.withdraw")} onClick={() => setSelection({ kind: "withdraw", publication: entry })}>withdraw…</button>}</div>}
      </li>;
    })}{requests.map((request) => {
      const contact = names.find((contact) => contact.id === request.contactId);
      return <li key={`${request.contactId}:${request.record.assertion.id}`}><p class="people-context-attribution">{contact ? <button class="people-action" onClick={() => onOpen(contact.id)}>{contactDisplayName(contact)}</button> : "A connected person"} wants to disclose this connection</p>
        <ContextStatement assertion={request.record.assertion} />
        <p class="people-note">{!request.consent ? "You have not agreed to this disclosure." : request.consent.decision === "approve" ? "You approved this exact statement. You can withdraw your consent." : request.consent.decision === "decline" ? "You declined this disclosure." : "You withdrew your consent."}</p>
        {request.deliveryId && <ContextDelivery deliveryId={request.deliveryId} account={account} />}
        {(!request.consent || request.consent.decision === "approve") && <button class="people-action" disabled={!allowed("contact.context.consent")} onClick={() => setSelection({ kind: "consent", request })}>{request.consent ? "review or withdraw consent…" : "review audience and decide…"}</button>}
      </li>;
    })}</ul>
    {(result.error || withdraw.error) && <p class="people-error" role="alert">{result.error?.message || withdraw.error?.message}</p>}
    {result.hasNextPage && <button class="people-action" disabled={result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>{result.isFetchingNextPage ? "loading…" : "more statements"}</button>}
  </section>;
}

function ConsentReview({ request, current, account, onClose, onDirty }: {
  request: SharedContextConsentRequest; current?: SharedContextConsentRequest; account: ConsoleAccount | undefined;
  onClose: () => void; onDirty: (dirty: boolean) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [intent, setIntent] = useState<ContactContextConsentArgs | null>(null);
  const a = request.record.assertion;
  const allowed = connected && !!account && canConfigure(account, "contact.context.consent");
  const changed = !current || current.generation !== request.generation || current.record.assertion.revision !== a.revision || current.consent?.decisionRevision !== request.consent?.decisionRevision;
  const decide = useMutation({ mutationFn: (args: ContactContextConsentArgs) => client.contact.context.consent(args),
    onSuccess: async () => { await refreshContactQuery(cache, INSTRUMENT_SHARED_CONTEXT_KEY); onClose(); }, onError: () => refreshContactQuery(cache, INSTRUMENT_SHARED_CONTEXT_KEY) });
  useDraftGuard(true, onDirty);
  const submit = (decision: ContactContextConsentArgs["decision"]) => {
    if (!allowed || decide.isPending || changed && !intent) return;
    const args = intent ?? { contactId: request.contactId, expectedGeneration: request.generation, assertionId: a.id,
      assertionRevision: a.revision, expectedDecisionRevision: request.consent?.decisionRevision ?? 0, decision };
    setIntent(args); decide.mutate(args);
  };
  return <section class="people-context-editor"><div class="people-kicker">Connection consent</div><h2>Choose what others can see</h2>
    <ContextStatement assertion={a} />
    <p>This exact statement can be shared with <strong>the author's active direct contacts who subscribe to connections</strong>, until {new Date(a.expiresAtMs).toLocaleString()}.</p>
    <p class="people-note">Your conversation stays private. This disclosure gives nobody access to your space. Both your approval and the author's proposal identify the exact wording, audience and expiry.</p>
    {request.consent?.decision === "approve" && <p class="people-note">Withdrawing asks the author to remove this connection. Previously shared copies remain until their display lease ends, within 24 hours.</p>}
    {changed && !intent && <p class="people-note" role="status">The proposal or your decision changed. Close this review and open the latest version.</p>}
    <div class="people-actions">{intent ? <button class="ibtn" disabled={!allowed || decide.isPending} onClick={() => submit(intent.decision)}>{decide.isPending ? "saving…" : "retry the same decision"}</button>
      : request.consent?.decision === "approve" ? <button class="ibtn" disabled={!allowed || changed} onClick={() => submit("withdraw")}>withdraw my consent</button>
        : <><button class="ibtn is-primary" disabled={!allowed || changed} onClick={() => submit("approve")}>approve this disclosure</button><button class="people-action" disabled={!allowed || changed} onClick={() => submit("decline")}>decline this disclosure</button></>}
      <button class="people-action" disabled={decide.isPending} onClick={onClose}>close review</button></div>
    {decide.error && <p class="people-error" role="alert">{decide.error.message}</p>}
  </section>;
}

function ContextDelivery({ deliveryId, account }: { deliveryId: string; account: ConsoleAccount | undefined }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const key = [...INSTRUMENT_SHARED_CONTEXT_KEY, "delivery", deliveryId];
  const status = useQuery({ queryKey: key, enabled: connected && !!account && canConfigure(account, "contact.delivery.get"), queryFn: () => client.contact.delivery.get({ deliveryId }) });
  const delivery = status.data?.delivery;
  const retry = useMutation({ mutationFn: () => client.contact.delivery.retry({ deliveryId, expectedUpdatedAtMs: delivery!.updatedAtMs }), onSuccess: () => refreshContactQuery(cache, key) });
  if (!delivery) return status.error ? <p class="people-error">{status.error.message}</p> : null;
  return <div class={`people-delivery is-${delivery.state}`}><span>{delivery.state === "delivered" ? "Received by their GSV" : delivery.state === "queued" ? "Delivery queued" : "Delivery unconfirmed"}</span>
    {delivery.state === "failed" && <>{delivery.retryable && <button class="people-action" disabled={!connected || !account || !canConfigure(account, "contact.delivery.retry") || retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? "retrying…" : "retry this delivery"}</button>}
      {delivery.lastError && <details><summary>delivery details</summary><p>{delivery.lastError}</p></details>}</>}
    {retry.error && <p class="people-error" role="alert">{retry.error.message}</p>}
  </div>;
}
