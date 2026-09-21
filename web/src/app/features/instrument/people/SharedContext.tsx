import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useCallback, useEffect, useState } from "preact/hooks";
import { contactDisplayName, type ActorRef, type ContactContextSubscribeArgs, type ContactSummary, type SharedContextKind } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { useDraftGuard } from "../shared/useDraftGuard";
import { INSTRUMENT_CONTACTS_KEY, INSTRUMENT_SHARED_CONTEXT_KEY } from "../wire/queryKeys";
import { refreshContactQuery } from "../wire/contactSync";
import { LoadingState } from "../../../components/ui/Spinner";
import { ContextStatement, CONTEXT_KIND_LABELS, CONTEXT_KIND_EXPLANATIONS } from "./ContextStatement";
import { ContextPublicationEditor } from "./ContextPublicationEditor";

const NO_CURSOR: string | undefined = undefined;
const KINDS: SharedContextKind[] = ["connection", "recommendation", "advisory"];

export function SharedWithYou({ subject, sourceContactId, account, onOpen }: {
  subject?: ActorRef; sourceContactId?: string; account: ConsoleAccount | undefined; onOpen: (id: string) => void;
}) {
  const { client, connected } = useGateway();
  const [now, setNow] = useState(Date.now());
  const allowed = connected && !!account && canConfigure(account, "contact.context.list");
  const results = useInfiniteQuery({ queryKey: [...INSTRUMENT_SHARED_CONTEXT_KEY, "entries", subject, sourceContactId], enabled: allowed,
    initialPageParam: NO_CURSOR, queryFn: ({ pageParam }) => client.contact.context.list({ subject, sourceContactId, cursor: pageParam, limit: 20 }),
    getNextPageParam: (page) => page.next });
  const retained = results.data?.pages.flatMap((page) => page.entries) ?? [];
  const ids = [...new Set(retained.map((entry) => entry.sourceContactId))].sort();
  const sources = useQuery({ queryKey: [...INSTRUMENT_CONTACTS_KEY, "context-sources", ids], enabled: allowed && ids.length > 0 && !!account && canConfigure(account, "contact.list"),
    queryFn: () => client.contact.list({ ids, includeRevoked: true, limit: 100 }) });
  const deadline = Math.min(...retained.filter((entry) => entry.leaseUntilMs > now).map((entry) => entry.leaseUntilMs));
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);
  const entries = retained.filter((entry) => entry.leaseUntilMs > Math.max(now, Date.now()));
  return <section class="people-shared-context" aria-label={sourceContactId ? "Statements from this person" : "Shared with you about this person"}>
    <h3>{sourceContactId ? "What this person shares" : "Shared with you"}</h3>
    <p class="people-note">{sourceContactId ? "Only the kinds you choose to receive are kept here." : "Statements about this person from sources you have chosen. No wider network is searched."}</p>
    {!allowed && <p class="people-note">{connected ? "This account cannot read shared context." : "Reconnect to load shared context."}</p>}
    {results.isFetching && !results.data && allowed && <LoadingState>Loading selected context…</LoadingState>}
    {results.error && <p class="people-error" role="alert">{results.error.message}</p>}
    {results.data && entries.length === 0 && <p class="people-note">No current statements in this view.</p>}
    <ul class="people-context-list">{entries.map((entry) => {
      const source = sources.data?.contacts.find((contact) => contact.id === entry.sourceContactId);
      return <li key={`${entry.sourceContactId}:${entry.record.assertion.id}`}>
        <div class="people-context-attribution"><span>Shared by {source ? <button class="people-action" onClick={() => onOpen(source.id)}>{contactDisplayName(source)}</button> : "a selected source"}</span>
          <time dateTime={new Date(entry.receivedAtMs).toISOString()}>received {new Date(entry.receivedAtMs).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</time></div>
        <ContextStatement assertion={entry.record.assertion} />
        {entry.record.consent && <p class="people-note">Both endpoints approved this exact connection disclosure.</p>}
      </li>;
    })}</ul>
    {results.hasNextPage && <button class="people-action" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>{results.isFetchingNextPage ? "loading…" : "more selected context"}</button>}
  </section>;
}

export function ContactContext({ contact, account, onDirty, onOpen }: {
  contact: ContactSummary; account: ConsoleAccount | undefined; onDirty: (dirty: boolean) => void; onOpen: (id: string) => void;
}) {
  const [publishing, setPublishing] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceDirty, setSourceDirty] = useState(false);
  const changed = useCallback((dirty: boolean) => { setSourceDirty(dirty); onDirty(dirty); }, [onDirty]);
  const subject = { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id };
  if (publishing) return <ContextPublicationEditor subject={subject} account={account} allowConnection={contact.state === "active"} onClose={() => setPublishing(false)} onDirty={onDirty} />;
  return <>
    <SharedWithYou subject={subject} account={account} onOpen={onOpen} />
    <div class="people-actions"><button class="people-action" disabled={sourceDirty || !account || !canConfigure(account, "contact.context.publish")} onClick={() => setPublishing(true)}>share about this person…</button></div>
    <ContextSourceControls contact={contact} account={account} onDirty={changed} />
    <button class="people-action" aria-expanded={sourceOpen} onClick={() => setSourceOpen((open) => !open)}>{sourceOpen ? "hide their shared statements" : "browse what they share"}</button>
    {sourceOpen && <SharedWithYou sourceContactId={contact.id} account={account} onOpen={onOpen} />}
  </>;
}

function ContextSourceControls({ contact, account, onDirty }: {
  contact: ContactSummary; account: ConsoleAccount | undefined; onDirty: (dirty: boolean) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const allowed = (name: string) => connected && !!account && account.uid >= 1000 && contact.state === "active" && canConfigure(account, name);
  const sources = useQuery({ queryKey: [...INSTRUMENT_SHARED_CONTEXT_KEY, "sources"], enabled: allowed("contact.context.sources"), queryFn: () => client.contact.context.sources({}) });
  const source = sources.data?.sources.find((entry) => entry.contactId === contact.id && entry.generation === contact.generation);
  const [draft, setDraft] = useState<ContactContextSubscribeArgs | null>(null);
  const update = useMutation({ mutationFn: (value: ContactContextSubscribeArgs) => client.contact.context.subscribe(value), onSuccess: async () => { setDraft(null); await refreshContactQuery(cache, INSTRUMENT_SHARED_CONTEXT_KEY); }, onError: () => refreshContactQuery(cache, INSTRUMENT_SHARED_CONTEXT_KEY) });
  const sync = useMutation({ mutationFn: () => client.contact.context.sync({ contactId: contact.id, expectedRevision: source!.revision }), onSuccess: () => refreshContactQuery(cache, INSTRUMENT_SHARED_CONTEXT_KEY) });
  useDraftGuard(!!draft, onDirty);
  const stale = draft && (draft.expectedRevision !== (source?.revision ?? 0) || draft.expectedGeneration !== contact.generation);
  return <section class="people-context-subscription" aria-label="Shared context subscription">
    <h3>Choose what you receive</h3>
    {!draft ? <>
      <p class="people-note">{source ? `Receiving ${source.kinds.map((kind) => CONTEXT_KIND_LABELS[kind].toLocaleLowerCase()).join(", ")} from ${contactDisplayName(contact)}.` : "You are not receiving this person's shared relationship context."}</p>
      {source && <p class="people-note" role="status">{source.state === "current" ? `Last synchronized ${new Date(source.updatedAtMs!).toLocaleString()}.` : source.state === "unavailable" ? "This source could not be synchronized. Existing statements remain only until their display leases expire." : "Synchronization is queued. The previous complete view stays available until the new one is ready."}</p>}
      <div class="people-actions"><button class="people-action" disabled={!allowed("contact.context.subscribe") || !sources.data} onClick={() => setDraft({ contactId: contact.id, expectedGeneration: contact.generation, expectedRevision: source?.revision ?? 0, kinds: source?.kinds.slice() ?? [] })}>{source ? "change or stop receiving…" : "choose kinds to receive…"}</button>
        {source && <button class="people-action" disabled={!allowed("contact.context.sync") || sync.isPending || source.state === "syncing" || source.state === "queued"} onClick={() => sync.mutate()}>sync now</button>}</div>
    </> : <form onSubmit={(event) => { event.preventDefault(); if (!stale && allowed("contact.context.subscribe")) update.mutate(draft); }}>
      <fieldset disabled={update.isPending}><legend>Keep a local copy of</legend>{KINDS.map((kind) => <label class="people-setting" key={kind}><input type="checkbox" checked={draft.kinds.includes(kind)} onChange={(event) => setDraft({ ...draft, kinds: event.currentTarget.checked ? [...draft.kinds, kind] : draft.kinds.filter((value) => value !== kind) })} /><span>{CONTEXT_KIND_LABELS[kind]}<small>{CONTEXT_KIND_EXPLANATIONS[kind]}</small></span></label>)}</fieldset>
      <p class="people-note">These are their selected disclosures. Your own contacts, blocks and mutes stay private. Receiving a statement gives nobody access to your space.</p>
      {!draft.kinds.length && <p class="people-note">Saving with no kinds selected stops this source and removes its cached statements.</p>}
      {stale && <p class="people-note" role="status">This subscription changed. Cancel and review the latest choice.</p>}
      <div class="people-actions"><button type="submit" class="ibtn" disabled={!allowed("contact.context.subscribe") || update.isPending || !!stale}>{update.isPending ? "saving…" : draft.kinds.length ? "receive these kinds" : "stop receiving"}</button><button type="button" class="people-action" disabled={update.isPending} onClick={() => setDraft(null)}>cancel</button></div>
    </form>}
    {(sources.error || update.error || sync.error) && <p class="people-error" role="alert">{sources.error?.message || update.error?.message || sync.error?.message}</p>}
  </section>;
}
