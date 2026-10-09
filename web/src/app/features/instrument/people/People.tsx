import { contactDisplayName, type ApproachListArgs, type ApproachSummary, type ConversationInboxArgs } from "@humansandmachines/gsv/protocol";
import { useQueryClient } from "@tanstack/preact-query";
import { useInfiniteQuery, useQuery } from "../../../services/navigation/viewQueries";
import { RetainedView, useViewActive } from "../../../services/navigation/ViewActivity";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleAccounts } from "../../../services/system/consoleService";
import { LoadingState } from "../../../components/ui/Spinner";
import { ContactAttentionNotice, ContactInspector, useContacts } from "./Contacts";
import { InviteContact, type InvitationDraft } from "./InviteContact";
import { PeopleWelcome } from "./PeopleWelcome";
import { pendingContactInvitation, clearContactInvitation } from "../../../services/session/contactInvitationIntent";
import { EMPTY_CONTACT_DRAFT, useContactDrafts } from "./useContactDrafts";
import { canConfigure } from "../settings/settingsModel";
import { useDraftGuard } from "../shared/useDraftGuard";
import { FleetDialog } from "../fleet/FleetDialog";
import { INSTRUMENT_APPROACHES_KEY, INSTRUMENT_CONTACTS_KEY, INSTRUMENT_INBOX_KEY } from "../wire/queryKeys";
import { NewConversation } from "./NewConversation";
import { MessageRequest } from "./MessageRequest";
import { BlockedPeople } from "./BlockedPeople";
import { approachStatus, emptyApproachDraft, inboxPreview } from "./peopleModel";
import "../fleet/fleet.css";
import "./people.css";

type PeopleView = "inbox" | "requests" | "contacts";
const NO_CURSOR: ApproachListArgs["before"] = undefined;
const NO_INBOX_CURSOR: ConversationInboxArgs["before"] = undefined;

export type PeopleOpenRequest = { contactId: string } | { requestId: string };

export function People({ onDirtyChange, onProfile, onAsk, openRequest }: {
  onDirtyChange: (dirty: boolean) => void;
  onProfile: () => void;
  onAsk: (prompt: string) => void;
  /** A conversation to land on, asked for from another view; a fresh object reopens the same contact. */
  openRequest?: PeopleOpenRequest | null;
}) {
  const active = useViewActive();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [compose, setCompose] = useState(() => emptyApproachDraft(new URLSearchParams(window.location.search).get("compose") ?? ""));
  const [invitation, setInvitation] = useState<InvitationDraft>(() => ({ code: pendingContactInvitation() ?? "", issued: null, shipHandlesMessages: null }));
  const [idea, setIdea] = useState(0);
  const [chosenIdea, setChosenIdea] = useState<{ index: number; contactId: string | null } | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"profile" | "invitation" | "blocked" | null>(() => invitation.code ? "invitation" : compose.url ? "profile" : null);
  const [view, setView] = useState<PeopleView>("inbox");
  const [direction, setDirection] = useState<"incoming" | "outgoing">("incoming");
  const [history, setHistory] = useState(false);
  const [archived, setArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  const detail = useRef<HTMLElement>(null);
  const drafts = useContactDrafts(setContactDirty);
  useDraftGuard(contactDirty || !!compose.text || busy, onDirtyChange);
  useEffect(() => {
    if (!compose.url) return;
    window.history.replaceState(window.history.state, "", "/people");
  }, []);
  const accounts = useQuery({ queryKey: ["fleet", "accounts"], queryFn: () => loadConsoleAccounts(client), enabled: connected });
  const account = accounts.data?.find((entry) => entry.relation === "self");
  const human = !!account && account.uid >= 1000;
  const contactsQuery = useContacts(human ? account : undefined);
  const contacts = contactsQuery.data?.contacts ?? [];
  const inbox = useInfiniteQuery({
    queryKey: [...INSTRUMENT_INBOX_KEY, archived],
    enabled: connected && view === "inbox" && human && canConfigure(account!, "conversation.inbox"),
    initialPageParam: NO_INBOX_CURSOR,
    queryFn: ({ pageParam }) => client.conversation.inbox({ archived, before: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.next,
  });
  const inboxItems = inbox.data?.pages.flatMap((page) => page.entries) ?? [];
  const inboxByContact = new Map(inboxItems.map((entry) => [entry.contactId, entry]));
  const requestDirection = view === "requests" ? direction : "incoming";
  const requestHistory = view === "requests" && history;
  const requests = useInfiniteQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "list", requestDirection, requestHistory],
    enabled: connected && human && canConfigure(account!, "approach.list"),
    initialPageParam: NO_CURSOR,
    queryFn: ({ pageParam }) => client.approach.list({ direction: requestDirection, status: requestHistory ? "history" : "active", before: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.next,
  });
  const request = useQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "detail", requestId], enabled: connected && view === "requests" && !!requestId && human && canConfigure(account!, "approach.get"),
    queryFn: async () => (await client.approach.get({ approachId: requestId! })).approach,
  });
  const selectedContact = contacts.find((contact) => contact.id === contactId);
  const visible = contacts.filter((contact) => (view === "contacts" ? contact.preferences?.saved !== false : inboxByContact.has(contact.id))
    && `${contactDisplayName(contact)} ${contact.remoteSubject.displayName} ${contact.remoteOrigin}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    .sort((a, b) => view === "contacts" ? contactDisplayName(a).localeCompare(contactDisplayName(b)) : (inboxByContact.get(b.id)?.conversation.updatedAt ?? 0) - (inboxByContact.get(a.id)?.conversation.updatedAt ?? 0));
  const items = requests.data?.pages.flatMap((page) => page.approaches) ?? [];
  const hasSelection = view === "requests" ? !!requestId : view === "inbox" && !!contactId;
  useLayoutEffect(() => { if (active && hasSelection) detail.current?.focus({ preventScroll: true }); }, [active, view, contactId, requestId]);
  const mayStart = !!account && (canConfigure(account, "contact.invite.create") || canConfigure(account, "contact.invite.accept") || canConfigure(account, "profile.resolve"));
  const firstVisit = !!contactsQuery.data && !contacts.length && !hasSelection && view === "inbox" && !archived;
  const openList = (next: PeopleView) => {
    setView(next); setFilter("");
    if (next === "requests") { setDirection("incoming"); setHistory(false); setRequestId(null); }
  };
  const openContact = (id: string) => {
    setDialog(null);
    setView("inbox"); setFilter("");
    setContactId(id);
  };
  const showConversation = (id: string) => {
    setChosenIdea((current) => current && !current.contactId ? { ...current, contactId: id } : current);
    void cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY });
    void cache.invalidateQueries({ queryKey: INSTRUMENT_INBOX_KEY });
    setView("inbox");
    setArchived(false);
    openContact(id);
  };
  useLayoutEffect(() => {
    if (!openRequest) return;
    if ("contactId" in openRequest) showConversation(openRequest.contactId);
    else { setDialog(null); setView("requests"); setDirection("incoming"); setHistory(false); setRequestId(openRequest.requestId); }
  }, [openRequest]);
  const sent = (value: ApproachSummary) => {
    setDialog(null);
    setCompose(emptyApproachDraft()); setView("requests"); setDirection("outgoing"); setHistory(false);
    cache.setQueryData([...INSTRUMENT_APPROACHES_KEY, "detail", value.id], value);
    void cache.invalidateQueries({ queryKey: INSTRUMENT_APPROACHES_KEY });
    setRequestId(value.id);
  };

  if (accounts.isPending && connected) return <main class="people-access"><LoadingState variant="panel">Loading your account…</LoadingState></main>;
  if (accounts.error) return <main class="people-access"><p class="people-error" role="alert">{accounts.error.message}</p></main>;
  if (account && !human) return <main class="people-access"><p>Sign in with your personal account to use People.</p></main>;

  return <main class={`people${hasSelection ? " has-selection" : ""}${firstVisit ? " is-new" : ""}`} aria-label="People">
    <aside class="people-list" aria-label="People and conversations">
      <header class="people-list-heading"><h1>{view === "inbox" ? "People" : view === "contacts" ? "Contacts" : history ? "Past requests" : direction === "outgoing" ? "Sent requests" : "Requests"}</h1>
        {view !== "requests" && <div class="people-list-heading-actions">
          {view === "inbox" && <button class="people-action" disabled={busy} onClick={() => openList("contacts")}>contacts</button>}
          <button class="people-action" aria-label="Connect with someone" disabled={!connected || busy || !mayStart} onClick={() => setDialog("invitation")}>connect</button>
        </div>}
      </header>
      {view !== "inbox" && <button class="people-action people-list-back" aria-label="Back to conversations" disabled={busy} onClick={() => openList("inbox")}>← conversations</button>}
      {view === "inbox" && <button class="people-request-entry" disabled={busy || !account || !canConfigure(account, "approach.list")} onClick={() => openList("requests")}>
        <span>Requests</span>{items.length > 0 && <span class="people-request-count">{items.length}{requests.hasNextPage ? "+" : ""}</span>}
      </button>}
      {view === "requests" ? <>
        {account && !canConfigure(account, "approach.list") && <p class="people-note people-access-note">This account cannot read message requests.</p>}
        <div class="people-list-tools"><button class="people-action" disabled={busy} onClick={() => { setDirection(direction === "incoming" ? "outgoing" : "incoming"); setRequestId(null); }}>{direction === "incoming" ? "sent requests" : "received requests"}</button><button class="people-action" disabled={busy} onClick={() => { setHistory(!history); setRequestId(null); }}>{history ? "current requests" : "history"}</button></div>
        {requests.isFetching && !requests.data && <LoadingState variant="panel">Loading requests…</LoadingState>}
        {requests.error && <p class="people-error" role="alert">{requests.error.message}</p>}
        {requests.data && !items.length && <div class="people-empty-list"><p>{history ? "No past requests." : direction === "incoming" ? "No requests waiting for you." : "No requests waiting for a reply."}</p><span>{direction === "incoming" ? "People can reach you through your published profile." : "Start with someone’s public profile or a private invitation."}</span></div>}
        <ul class="people-rows">{items.map((item) => <li key={item.id}><button class={`people-row${requestId === item.id ? " is-selected" : ""}`} disabled={busy} aria-current={requestId === item.id ? "true" : undefined} onClick={() => setRequestId(item.id)}><span class="people-row-name">{item.displayName}</span><time>{new Date(item.createdAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span class="people-row-preview">{approachStatus(item)}</span></button></li>)}</ul>
        {requests.hasNextPage && <button class="people-action people-more" disabled={requests.isFetchingNextPage} onClick={() => void requests.fetchNextPage()}>{requests.isFetchingNextPage ? "loading…" : "earlier requests"}</button>}
      </> : <>
        {view === "inbox" && account && !canConfigure(account, "conversation.inbox") && <p class="people-note people-access-note">This account cannot read the inbox.</p>}
        {account && !canConfigure(account, "contact.list") && <p class="people-note people-access-note">This account cannot read contacts.</p>}
        <div class="people-list-tools"><input class="people-filter" aria-label={view === "contacts" ? "Find a contact" : "Find a conversation"} value={filter} placeholder={view === "contacts" ? "Find a contact…" : "Filter conversations…"} onInput={(event) => setFilter(event.currentTarget.value)} /></div>
        {view === "inbox" && archived && <div class="people-archive-heading"><span>Archived</span><button class="people-action" onClick={() => setArchived(false)}>back to conversations</button></div>}
        {(contactsQuery.isFetching && !contactsQuery.data || view === "inbox" && inbox.isFetching && !inbox.data) && <LoadingState variant="panel">Loading conversations…</LoadingState>}
        {view === "inbox" && inbox.error && <p class="people-error" role="alert">{inbox.error.message}</p>}
        {contactsQuery.error && <p class="people-error" role="alert">{contactsQuery.error.message}</p>}
        {contactsQuery.data && (view === "contacts" || inbox.data) && !visible.length && <div class="people-empty-list"><p>{filter ? "No matching people." : view === "contacts" ? "Your address book starts here." : archived ? "No archived conversations." : "Your people will appear here."}</p><span>{filter ? "Try their name or space address." : "Invite someone you know, or accept a link they’ve shared with you."}</span></div>}
        <ul class="people-rows">{visible.map((contact) => <li key={contact.id}><button class={`people-row${view === "inbox" && selectedContact?.id === contact.id ? " is-selected" : ""}${view === "inbox" && inboxByContact.get(contact.id)?.unread ? " is-unread" : ""}`} disabled={busy} aria-current={view === "inbox" && selectedContact?.id === contact.id ? "true" : undefined} onClick={() => openContact(contact.id)}><span class="people-row-name">{contactDisplayName(contact)}{view === "inbox" && inboxByContact.get(contact.id)?.unread && <span class="people-unread" aria-label="Unread" />}</span>{view === "inbox" && <time>{new Date(inboxByContact.get(contact.id)?.conversation.updatedAt ?? contact.updatedAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>}<span class="people-row-preview">{inboxPreview(contact, view === "inbox" ? inboxByContact.get(contact.id) : undefined)}</span></button></li>)}</ul>
        {view === "inbox" && inbox.hasNextPage && <button class="people-action people-more" disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>{inbox.isFetchingNextPage ? "loading…" : "earlier conversations"}</button>}
      </>}
      <footer class="people-list-footer">
        <details class="people-list-more"><summary>more</summary><div>
          <button class="people-action" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); openList("inbox"); setArchived(!archived); }}>{archived ? "conversations" : "archived conversations"}</button>
          <button class="people-action" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onProfile(); }}>your public profile</button>
          <button class="people-action" disabled={busy || !account || !canConfigure(account, "contact.block.list")} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setDialog("blocked"); }}>blocked people</button>
        </div></details>
        {!connected && <span role="status">reconnecting…</span>}
      </footer>
    </aside>
    <section class="people-detail" ref={detail} tabIndex={-1} aria-label="Selected conversation">
      {hasSelection && <button class="people-action people-back" disabled={busy} onClick={() => view === "requests" ? setRequestId(null) : setContactId(null)}>← {view === "requests" ? "requests" : "conversations"}</button>}
      <RetainedView active={active && view === "inbox"}>
        {selectedContact ? <ContactInspector key={selectedContact.id} contact={selectedContact} account={account} idea={chosenIdea?.contactId === selectedContact.id ? chosenIdea.index : null} onAsk={(task) => onAsk(task.replaceAll("{name}", `${contactDisplayName(selectedContact)} (${new URL(selectedContact.remoteOrigin).host})`))} draft={drafts.drafts.get(selectedContact.id) ?? EMPTY_CONTACT_DRAFT} onDraft={(change) => drafts.update(selectedContact.id, change)} onSend={() => void drafts.send(selectedContact)} onRetry={(id) => void drafts.send(selectedContact, id)} onObserved={(ids) => drafts.observed(selectedContact.id, ids)} />
          : contactId ? contactsQuery.isFetching ? <LoadingState variant="panel">Opening conversation…</LoadingState> : <p class="people-note">This conversation is no longer available to this account.</p>
          : firstVisit ? <PeopleWelcome idea={idea} onIdea={setIdea} disabled={busy || !connected || !mayStart} onConnect={() => { setChosenIdea({ index: idea, contactId: null }); setDialog("invitation"); }} />
          : <div class="people-empty"><h2>Pick up where you left off.</h2><p>Choose a conversation to talk, share, or ask Ship to help.</p><button class="people-action" disabled={busy || !connected || !mayStart} onClick={() => setDialog("invitation")}>connect with someone</button></div>}
        {!contactId && contactsQuery.data?.attentionNotice && <ContactAttentionNotice account={account} />}
      </RetainedView>
      <RetainedView active={active && view === "requests"}>
        {requestId ? request.data ? <MessageRequest key={requestId} request={request.data} account={account} onOpen={showConversation} /> : request.error ? <p class="people-error" role="alert">{request.error.message}</p> : <LoadingState variant="panel">Opening request…</LoadingState>
          : <div class="people-empty"><p>Select a request to read their first message.</p></div>}
      </RetainedView>
      {view === "contacts" && <div class="people-empty"><p>Choose a contact to open your conversation.</p></div>}
    </section>
    <FleetDialog open={active && dialog !== null} title={dialog === "blocked" ? "Blocked people" : dialog === "invitation" ? "Connect with someone" : "Start a conversation"} onClose={() => { if (!busy) { clearContactInvitation(); setDialog(null); } }}>
      {dialog === "blocked" ? <BlockedPeople account={account} /> : dialog === "invitation" ? <InviteContact account={account} draft={invitation} onChange={setInvitation} onAdded={showConversation} onBusy={setBusy} onProfile={() => setDialog("profile")} />
        : dialog === "profile" ? <NewConversation account={account} draft={compose} onChange={setCompose} onSent={sent} onBusy={setBusy} contacts={contacts} onOpen={openContact} onInvitation={() => setDialog("invitation")} /> : null}
    </FleetDialog>
  </main>;
}
