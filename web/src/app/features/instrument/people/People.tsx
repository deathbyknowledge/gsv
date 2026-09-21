import { contactDisplayName, type ApproachListArgs, type ApproachSummary, type ConversationInboxArgs, type ContactListArgs } from "@humansandmachines/gsv/protocol";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleAccounts } from "../../../services/system/consoleService";
import { LoadingState } from "../../../components/ui/Spinner";
import { AddContact, ContactAttentionNotice, ContactInspector } from "./Contacts";
import { EMPTY_CONTACT_DRAFT, useContactDrafts } from "./useContactDrafts";
import { canConfigure } from "../settings/settingsModel";
import { useDraftGuard } from "../shared/useDraftGuard";
import { INSTRUMENT_APPROACHES_KEY, INSTRUMENT_CONTACTS_KEY, INSTRUMENT_INBOX_KEY } from "../wire/queryKeys";
import { NewConversation } from "./NewConversation";
import { ConversationAttention } from "./ConversationAttention";
import { useAttentionSummary } from "./useAttentionSummary";
import { BlockedPeople } from "./BlockedPeople";
import { MessageRequest } from "./MessageRequest";
import { approachStatus, emptyApproachDraft, inboxPreview } from "./peopleModel";
import "../fleet/fleet.css";
import "./people.css";

type PeopleView = "inbox" | "requests" | "contacts";
type Selection = { kind: "contact" | "request"; id: string } | { kind: "compose" | "invitation" | "blocked" | "attention" } | null;
const NO_CONTACT_CURSOR: ContactListArgs["after"] = undefined;
const NO_CURSOR: ApproachListArgs["before"] = undefined;
const NO_INBOX_CURSOR: ConversationInboxArgs["before"] = undefined;

export function People({ onDirtyChange, onProfile }: { onDirtyChange: (dirty: boolean) => void; onProfile: () => void }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const attention = useAttentionSummary();
  const [compose, setCompose] = useState(() => emptyApproachDraft(new URLSearchParams(window.location.search).get("compose") ?? ""));
  const [selection, updateSelection] = useState<Selection>(() => compose.url ? { kind: "compose" } : null);
  const [panelDirty, setPanelDirty] = useState(false);
  const setSelection = (next: Selection) => {
    if (panelDirty && !window.confirm("Discard these unsent changes?")) return;
    setPanelDirty(false); updateSelection(next);
  };
  const [view, setView] = useState<PeopleView>("inbox");
  const [direction, setDirection] = useState<"incoming" | "outgoing">("incoming");
  const [history, setHistory] = useState(false);
  const [archived, setArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [contactFilter, setContactFilter] = useState("");
  useEffect(() => { const timer = setTimeout(() => setContactFilter(filter.trim()), 180); return () => clearTimeout(timer); }, [filter]);
  const [busy, setBusy] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  const detail = useRef<HTMLElement>(null);
  const drafts = useContactDrafts(setContactDirty);
  useDraftGuard(panelDirty || contactDirty || !!compose.text || !!compose.displayName || busy, onDirtyChange);
  useEffect(() => {
    if (!compose.url) return;
    window.history.replaceState(window.history.state, "", "/people");
  }, []);
  const accounts = useQuery({ queryKey: ["fleet", "accounts"], queryFn: () => loadConsoleAccounts(client), enabled: connected });
  const account = accounts.data?.find((entry) => entry.relation === "self");
  const human = !!account && account.uid >= 1000;
  const addressBook = useInfiniteQuery({
    queryKey: [...INSTRUMENT_CONTACTS_KEY, "address-book", contactFilter],
    enabled: connected && human && view === "contacts" && canConfigure(account!, "contact.list"),
    initialPageParam: NO_CONTACT_CURSOR,
    queryFn: ({ pageParam }) => client.contact.list({ saved: true, includeRevoked: true, query: contactFilter, after: pageParam, limit: 40 }),
    getNextPageParam: (page) => page.next,
  });
  const inbox = useInfiniteQuery({
    queryKey: [...INSTRUMENT_INBOX_KEY, archived],
    enabled: connected && human && canConfigure(account!, "conversation.inbox"),
    initialPageParam: NO_INBOX_CURSOR,
    queryFn: ({ pageParam }) => client.conversation.inbox({ archived, before: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.next,
  });
  const inboxItems = inbox.data?.pages.flatMap((page) => page.entries) ?? [];
  const inboxByContact = new Map(inboxItems.map((entry) => [entry.contactId, entry]));
  const contactIds = [...new Set([...inboxItems.map((entry) => entry.contactId), ...(selection?.kind === "contact" ? [selection.id] : [])])].sort();
  const chunks = Array.from({ length: Math.max(1, Math.ceil(contactIds.length / 100)) }, (_, index) => contactIds.slice(index * 100, index * 100 + 100));
  const contactDetails = useQueries({ queries: chunks.map((ids) => ({
    queryKey: [...INSTRUMENT_CONTACTS_KEY, "by-id", ids],
    enabled: connected && human && canConfigure(account!, "contact.list"),
    queryFn: () => client.contact.list({ ids, includeRevoked: true, limit: 100 }),
  })) });
  const contacts = [...new Map([
    ...(addressBook.data?.pages.flatMap((page) => page.contacts) ?? []),
    ...contactDetails.flatMap((page) => page.data?.contacts ?? []),
  ].map((contact) => [contact.id, contact])).values()];
  const contactsQuery = {
    data: contactDetails[0]?.data || addressBook.data ? { contacts, attentionNotice: contactDetails[0]?.data?.attentionNotice ?? addressBook.data?.pages[0]?.attentionNotice } : undefined,
    isFetching: addressBook.isFetching || contactDetails.some((page) => page.isFetching),
    error: addressBook.error ?? contactDetails.find((page) => page.error)?.error,
  };
  const requests = useInfiniteQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "list", direction, history],
    enabled: connected && human && canConfigure(account!, "approach.list"),
    initialPageParam: NO_CURSOR,
    queryFn: ({ pageParam }) => client.approach.list({ direction, status: history ? "history" : "active", before: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.next,
  });
  const requestId = selection?.kind === "request" ? selection.id : null;
  const request = useQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "detail", requestId], enabled: connected && !!requestId && human && canConfigure(account!, "approach.get"),
    queryFn: async () => (await client.approach.get({ approachId: requestId! })).approach,
  });
  const selectedContact = selection?.kind === "contact" ? contacts.find((contact) => contact.id === selection.id) : undefined;
  const listedContacts = view === "contacts" ? addressBook.data?.pages.flatMap((page) => page.contacts) ?? [] : contacts;
  const visible = listedContacts.filter((contact) => (view === "contacts" ? contact.preferences?.saved !== false : inboxByContact.has(contact.id))
    && (view === "contacts" || `${contactDisplayName(contact)} ${contact.remoteSubject.displayName} ${contact.remoteOrigin}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())))
    .sort((a, b) => view === "contacts" ? contactDisplayName(a).localeCompare(contactDisplayName(b)) : (inboxByContact.get(b.id)?.conversation.updatedAt ?? 0) - (inboxByContact.get(a.id)?.conversation.updatedAt ?? 0));
  const items = requests.data?.pages.flatMap((page) => page.approaches) ?? [];
  useLayoutEffect(() => { if (selection) detail.current?.focus({ preventScroll: true }); }, [selection]);
  const openContact = (id: string) => {
    void cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY });
    setSelection({ kind: "contact", id });
  };
  const sent = (value: ApproachSummary) => {
    setCompose(emptyApproachDraft()); setView("requests"); setDirection("outgoing"); setHistory(false);
    cache.setQueryData([...INSTRUMENT_APPROACHES_KEY, "detail", value.id], value);
    void cache.invalidateQueries({ queryKey: INSTRUMENT_APPROACHES_KEY });
    setSelection({ kind: "request", id: value.id });
  };

  if (accounts.isPending && connected) return <main class="people-access"><LoadingState variant="panel">Loading your account…</LoadingState></main>;
  if (accounts.error) return <main class="people-access"><p class="people-error" role="alert">{accounts.error.message}</p></main>;
  if (account && !human) return <main class="people-access"><h1>People belongs to your personal account</h1><p>Sign in with your human account to manage your conversations and public profile. The root account administers this space.</p></main>;

  return <main class={`people${selection ? " has-selection" : ""}`} aria-label="People">
    <aside class="people-list" aria-label="People and conversations">
      <header class="people-list-heading"><h1>People</h1><button class="people-action" disabled={!connected || !account || busy || !canConfigure(account, "approach.create")} onClick={() => setSelection({ kind: "compose" })}>new conversation</button></header>
      {account && canConfigure(account, "conversation.attention.list") && <div class="people-attention-link"><button class="people-action" onClick={() => setSelection({ kind: "attention" })}>
        catch up{attention.data?.readyCount ? ` · ${attention.data.readyCount}` : ""}</button>
        {!!attention.data?.digestWaitingCount && <span>digest gathering</span>}</div>}
      <nav class="people-tabs" aria-label="People sections">{(["inbox", "requests", "contacts"] as const).map((name) => <button key={name} aria-current={view === name ? "page" : undefined} disabled={busy} onClick={() => { setView(name); setFilter(""); }}>{name === "requests" ? "Requests" : name === "inbox" ? "Inbox" : "Contacts"}</button>)}</nav>
      {view === "requests" ? <>
        {account && !canConfigure(account, "approach.list") && <p class="people-note people-access-note">This account cannot read message requests.</p>}
        <div class="people-list-tools"><div class="people-directions">{(["incoming", "outgoing"] as const).map((value) => <button class="people-action" aria-pressed={direction === value} disabled={busy} onClick={() => setDirection(value)}>{value === "incoming" ? "received" : "sent"}</button>)}</div><label class="people-check"><input type="checkbox" checked={history} onChange={(event) => setHistory(event.currentTarget.checked)} />history</label></div>
        {requests.isFetching && !requests.data && <LoadingState variant="panel">Loading requests…</LoadingState>}
        {requests.error && <p class="people-error" role="alert">{requests.error.message}</p>}
        {requests.data && !items.length && <div class="people-empty-list"><p>{history ? "No past requests." : direction === "incoming" ? "No requests waiting for you." : "No requests waiting for a reply."}</p><span>{direction === "incoming" ? "People can reach you through your published profile." : "Start with someone’s public profile or a private invitation."}</span></div>}
        <ul class="people-rows">{items.map((item) => <li key={item.id}><button class={`people-row${requestId === item.id ? " is-selected" : ""}`} disabled={busy} aria-current={requestId === item.id ? "true" : undefined} onClick={() => setSelection({ kind: "request", id: item.id })}><span class="people-row-name">{item.displayName}</span><time>{new Date(item.createdAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span class="people-row-preview">{approachStatus(item)}</span></button></li>)}</ul>
        {requests.hasNextPage && <button class="people-action people-more" disabled={requests.isFetchingNextPage} onClick={() => void requests.fetchNextPage()}>{requests.isFetchingNextPage ? "loading…" : "earlier requests"}</button>}
      </> : <>
        {view === "inbox" && account && !canConfigure(account, "conversation.inbox") && <p class="people-note people-access-note">This account cannot read the inbox.</p>}
        {account && !canConfigure(account, "contact.list") && <p class="people-note people-access-note">This account cannot read contacts.</p>}
        <div class="people-list-tools"><input class="people-filter" aria-label={view === "contacts" ? "Find a contact" : "Find a conversation"} value={filter} placeholder={view === "contacts" ? "Find a contact…" : "Filter loaded conversations…"} onInput={(event) => setFilter(event.currentTarget.value)} />{view === "inbox" && <label class="people-check"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.currentTarget.checked)} />archive</label>}</div>
        {(view === "contacts" && addressBook.isFetching && !addressBook.data || view === "inbox" && (contactsQuery.isFetching && !contactsQuery.data || inbox.isFetching && !inbox.data)) && <LoadingState variant="panel">Loading conversations…</LoadingState>}
        {view === "inbox" && inbox.error && <p class="people-error" role="alert">{inbox.error.message}</p>}
        {contactsQuery.error && <p class="people-error" role="alert">{contactsQuery.error.message}</p>}
        {contactsQuery.data && (view === "contacts" ? addressBook.data : inbox.data) && !visible.length && <div class="people-empty-list"><p>{filter ? "No matching people." : view === "contacts" ? "Your address book starts here." : archived ? "No archived conversations." : "A conversation starts with a hello."}</p><span>{filter ? "Try their name or space address." : "Use a profile address to reach someone you choose."}</span></div>}
        <ul class="people-rows">{visible.map((contact) => <li key={contact.id}><button class={`people-row${selectedContact?.id === contact.id ? " is-selected" : ""}${view === "inbox" && inboxByContact.get(contact.id)?.unread ? " is-unread" : ""}`} disabled={busy} aria-current={selectedContact?.id === contact.id ? "true" : undefined} onClick={() => openContact(contact.id)}><span class="people-row-name">{contactDisplayName(contact)}{view === "inbox" && inboxByContact.get(contact.id)?.unread && <span class="people-unread" aria-label="Unread" />}</span><time>{new Date(inboxByContact.get(contact.id)?.conversation.updatedAt ?? contact.updatedAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span class="people-row-preview">{inboxPreview(contact, view === "inbox" ? inboxByContact.get(contact.id) : undefined)}</span></button></li>)}</ul>
        {view === "contacts" && addressBook.hasNextPage && <button class="people-action people-more" disabled={addressBook.isFetchingNextPage} onClick={() => void addressBook.fetchNextPage()}>{addressBook.isFetchingNextPage ? "loading…" : "more contacts"}</button>}
        {view === "inbox" && inbox.hasNextPage && <button class="people-action people-more" disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>{inbox.isFetchingNextPage ? "loading…" : "earlier conversations"}</button>}
      </>}
      <footer class="people-list-footer"><button class="people-action" disabled={busy} onClick={onProfile}>your public profile</button><button class="people-action" disabled={busy} onClick={() => setSelection({ kind: "blocked" })}>blocked people</button>{!connected && <span role="status">reconnecting…</span>}</footer>
    </aside>
    <section class="people-detail" ref={detail} tabIndex={-1} aria-label="Selected conversation">
      {selection && <button class="people-action people-back" disabled={busy} onClick={() => setSelection(null)}>← back to {view}</button>}
      {selection?.kind === "compose" ? <NewConversation account={account} draft={compose} onChange={setCompose} onSent={sent} onBusy={setBusy} onOpen={openContact} onInvitation={() => setSelection({ kind: "invitation" })} />
        : selection?.kind === "attention" ? <ConversationAttention account={account} onOpen={openContact} />
        : selection?.kind === "blocked" ? <BlockedPeople account={account} />
        : selection?.kind === "invitation" ? <AddContact account={account} onClose={() => setSelection(null)} onAdded={openContact} />
        : selectedContact ? <ContactInspector key={selectedContact.id} contact={selectedContact} account={account} initialSection={view === "contacts" ? "details" : "messages"} onWorkDirty={setPanelDirty} onOpenContact={openContact} draft={drafts.drafts.get(selectedContact.id) ?? EMPTY_CONTACT_DRAFT} onDraft={(change) => drafts.update(selectedContact.id, change)} onSend={() => void drafts.send(selectedContact)} onRetry={(id) => void drafts.send(selectedContact, id)} onObserved={(ids) => drafts.observed(selectedContact.id, ids)} />
        : requestId ? request.data ? <MessageRequest key={requestId} request={request.data} account={account} onOpen={openContact} onDirty={setPanelDirty} /> : request.error ? <p class="people-error" role="alert">{request.error.message}</p> : <LoadingState variant="panel">Opening request…</LoadingState>
        : selection?.kind === "contact" ? contactsQuery.isFetching ? <LoadingState variant="panel">Opening conversation…</LoadingState> : <p class="people-note">This conversation is no longer available to this account.</p>
        : <div class="people-empty"><div class="people-kicker">Intentional connections</div><h2>Your people.<br />One conversation at a time.</h2><p>Open a conversation, review a request, or reach someone new. Your Ship joins only when you choose.</p><button class="people-action" disabled={busy || !connected || !account || !canConfigure(account, "approach.create")} onClick={() => setSelection({ kind: "compose" })}>start a conversation ↗</button></div>}
      {!selection && contactsQuery.data?.attentionNotice && <ContactAttentionNotice notice={contactsQuery.data.attentionNotice} account={account} />}
    </section>
  </main>;
}
