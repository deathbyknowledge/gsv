import { contactDisplayName, type ApproachListArgs, type ApproachSummary, type ConversationInboxArgs } from "@humansandmachines/gsv/protocol";
import { useQueryClient } from "@tanstack/preact-query";
import { useInfiniteQuery, useQuery } from "../../../services/navigation/viewQueries";
import { RetainedView, useViewActive } from "../../../services/navigation/ViewActivity";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleAccounts } from "../../../services/system/consoleService";
import { LoadingState } from "../../../components/ui/Spinner";
import { IconButton } from "../../../components/ui/IconButton";
import { TextInput } from "../../../components/ui/TextInput";
import { Hint } from "../../../components/ui/Tooltip";
import { LINE_ICONS, LineIcon } from "../shared/lineIcons";
import { LoadOnScroll } from "./LoadOnScroll";
import { ContactRow, RequestRow } from "./PeopleRows";
import { PeopleSearch } from "./PeopleSearch";
import { ContactAttentionNotice, ContactInspector, useContacts } from "./Contacts";
import { InviteContact, type InvitationDraft } from "./InviteContact";
import { PeopleWelcome } from "./PeopleWelcome";
import { pendingContactInvitation, clearContactInvitation } from "../../../services/session/contactInvitationIntent";
import { EMPTY_CONTACT_DRAFT, useContactDrafts } from "./useContactDrafts";
import { canConfigure } from "../settings/settingsModel";
import { useDraftGuard } from "../shared/useDraftGuard";
import { FleetDialog } from "../fleet/FleetDialog";
import { INSTRUMENT_APPROACHES_KEY, INSTRUMENT_CONTACTS_KEY, INSTRUMENT_INBOX_KEY, INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { Profile } from "./Profile";
import { useShipTakedowns } from "./ProfileTakedowns";
import { NewConversation } from "./NewConversation";
import { MessageRequest } from "./MessageRequest";
import { BlockedPeople } from "./BlockedPeople";
import { contactAsk, emptyApproachDraft } from "./peopleModel";
import { shipTakenDown } from "./profileModel";
import { usePeopleRoute, type PeopleRoute } from "./peopleNavigation";
import { navigateApp } from "../../../services/navigation/appNavigation";
import { useT } from "../../../i18n/locale";
import "../fleet/fleet.css";
import "./people.css";

const NO_CURSOR: ApproachListArgs["before"] = undefined;
const NO_INBOX_CURSOR: ConversationInboxArgs["before"] = undefined;

/** A conversation to land on, asked for from another view; a fresh object reopens the same contact. */
export type PeopleOpenRequest = { contactId: string } | { requestId: string };

export function People({ onDirtyChange, onAsk }: {
  onDirtyChange: (dirty: boolean) => void;
  onAsk: (text: string) => void;
}) {
  const t = useT();
  const active = useViewActive();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [compose, setCompose] = useState(() => emptyApproachDraft(new URLSearchParams(window.location.search).get("compose") ?? ""));
  const [invitation, setInvitation] = useState<InvitationDraft>(() => ({ code: pendingContactInvitation() ?? "", issued: null, shipHandlesMessages: null }));
  const [idea, setIdea] = useState(0);
  const [chosenIdea, setChosenIdea] = useState<{ index: number; contactId: string | null } | null>(null);
  const [{ view, contactId, requestId, direction, history, archived, edit, focusBio }, open] = usePeopleRoute();
  const inboxContact = useRef(contactId);
  if (view === "inbox") inboxContact.current = contactId;
  const [dialog, setDialog] = useState<"profile" | "invitation" | null>(() => invitation.code ? "invitation" : compose.url ? "profile" : null);
  const firstDestination = useRef(true);
  useLayoutEffect(() => {
    if (firstDestination.current) { firstDestination.current = false; return; }
    setDialog(null);
  }, [active, view, contactId, requestId]);
  const listView = view === "profile" ? "inbox" : view;
  const [filter, setFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const detail = useRef<HTMLElement>(null);
  const drafts = useContactDrafts(setContactDirty);
  useDraftGuard(contactDirty || profileDirty || !!compose.text || busy, onDirtyChange);
  useEffect(() => {
    if (!compose.url) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("compose");
    navigateApp(url.href, { replace: true });
  }, []);
  const accounts = useQuery({ queryKey: ["fleet", "accounts"], queryFn: () => loadConsoleAccounts(client), enabled: connected });
  const account = accounts.data?.find((entry) => entry.relation === "self");
  const human = !!account && account.uid >= 1000;
  const profile = useQuery({ queryKey: [...INSTRUMENT_PROFILE_KEY, account?.uid], queryFn: async () => (await client.profile.get({})).profile, enabled: connected && human && canConfigure(account!, "profile.get") });
  const takedowns = useShipTakedowns(account, human);
  const takenDown = shipTakenDown(takedowns);
  const contactsQuery = useContacts(human ? account : undefined);
  const contacts = contactsQuery.data?.contacts ?? [];
  const inbox = useInfiniteQuery({
    queryKey: [...INSTRUMENT_INBOX_KEY, archived],
    enabled: connected && listView === "inbox" && human && canConfigure(account!, "conversation.inbox"),
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
  // The badge counts active received requests, whichever request list is open; this shares that list's cache.
  const pendingIncoming = useInfiniteQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "list", "incoming", false],
    enabled: connected && human && canConfigure(account!, "approach.list"),
    initialPageParam: NO_CURSOR,
    queryFn: ({ pageParam }) => client.approach.list({ direction: "incoming", status: "active", before: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.next,
  });
  const pendingCount = pendingIncoming.data?.pages.reduce((total, page) => total + page.approaches.length, 0) ?? 0;
  const pendingLabel = `${pendingCount}${pendingIncoming.hasNextPage ? "+" : ""}`;
  const request = useQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "detail", requestId], enabled: connected && view === "requests" && !!requestId && human && canConfigure(account!, "approach.get"),
    queryFn: async () => (await client.approach.get({ approachId: requestId! })).approach,
  });
  const selectedContact = contacts.find((contact) => contact.id === inboxContact.current);
  const query = searching ? filter.trim() : "";
  const visible = contacts.filter((contact) => view === "contacts" ? contact.preferences?.saved !== false : inboxByContact.has(contact.id))
    .sort((a, b) => view === "contacts" ? contactDisplayName(a).localeCompare(contactDisplayName(b)) : (inboxByContact.get(b.id)?.conversation.updatedAt ?? 0) - (inboxByContact.get(a.id)?.conversation.updatedAt ?? 0));
  const items = requests.data?.pages.flatMap((page) => page.approaches) ?? [];
  const hasSelection = view === "profile" || (view === "requests" ? !!requestId : view === "inbox" && !!contactId);
  useLayoutEffect(() => { if (active && hasSelection) detail.current?.focus({ preventScroll: true }); }, [active, view, contactId, requestId]);
  const mayStart = !!account && (canConfigure(account, "contact.invite.create") || canConfigure(account, "contact.invite.accept") || canConfigure(account, "profile.resolve"));
  const firstVisit = !!contactsQuery.data && !contacts.length && !hasSelection && view === "inbox" && !archived;
  const closeSearch = () => { setSearching(false); setFilter(""); };
  const openList = (next: PeopleRoute["view"]) => {
    closeSearch();
    open({ view: next, contactId: null, requestId: null, direction: next === "requests" ? "incoming" : direction, history: next === "requests" ? false : history });
  };
  const openContact = (id: string) => {
    setDialog(null);
    closeSearch();
    open({ view: "inbox", contactId: id });
  };
  const showConversation = (id: string) => {
    setChosenIdea((current) => current && !current.contactId ? { ...current, contactId: id } : current);
    void cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY });
    void cache.invalidateQueries({ queryKey: INSTRUMENT_INBOX_KEY });
    setDialog(null); closeSearch();
    open({ view: "inbox", contactId: id, archived: false });
  };
  const sent = (value: ApproachSummary) => {
    setDialog(null);
    setCompose(emptyApproachDraft());
    cache.setQueryData([...INSTRUMENT_APPROACHES_KEY, "detail", value.id], value);
    void cache.invalidateQueries({ queryKey: INSTRUMENT_APPROACHES_KEY });
    open({ view: "requests", direction: "outgoing", history: false, requestId: value.id });
  };

  if (accounts.isPending && connected) return <main class="people-access"><LoadingState variant="panel">{t("people.loadingAccount")}</LoadingState></main>;
  if (accounts.error) return <main class="people-access"><p class="people-error" role="alert">{accounts.error.message}</p></main>;
  if (account && !human) return <main class="people-access"><p>{t("people.personalOnly")}</p></main>;

  return <main class={`people${hasSelection ? " has-selection" : ""}${firstVisit ? " is-new" : ""}${listView === "inbox" ? " is-inbox" : ""}`} aria-label={t("people.title")}>
    <aside class="people-list" aria-label={t("people.listLabel")}>
      <div class="people-list-scroll" data-scroll-edge>
      <header class="people-list-heading">
        {searching ? <div class="people-search">
          <TextInput label="" size="small" value={filter} placeholder={t("people.search.placeholder")} prefix={<LineIcon path={LINE_ICONS.search} size={16} />} clearable onChange={setFilter}
            inputProps={{ "aria-label": t("people.search.label"), autoComplete: "off", autoCapitalize: "none", spellcheck: false, autoFocus: true, onKeyDown: (event) => { if (event.key === "Escape") closeSearch(); } }} />
          <Hint text={t("people.search.close")} position="bottom"><IconButton glyph="close" variant="floating" size={36} ariaLabel={t("people.search.close")} onClick={closeSearch} /></Hint>
        </div> : <>
          <h1>{t(listView === "inbox" ? archived ? "people.inbox.archivedTitle" : "people.inbox.title" : listView === "contacts" ? "people.contacts.title" : history ? "people.requests.pastTitle" : direction === "outgoing" ? "people.requests.sentTitle" : "people.requests.title")}</h1>
          <Hint text={t("people.search.label")} position="bottom"><IconButton icon={<LineIcon path={LINE_ICONS.search} />} variant="floating" size={36} ariaLabel={t("people.search.label")} disabled={busy} onClick={() => setSearching(true)} /></Hint>
        </>}
      </header>
      {(listView !== "inbox" || archived) && <button class="people-action people-list-back" aria-label={t("people.back.label")} disabled={busy} onClick={() => { closeSearch(); open({ view: "inbox", contactId: null, requestId: null, archived: false }); }}>{t("people.back.conversations")}</button>}
      {query ? <PeopleSearch account={account} query={query} contacts={contacts} contactsLoaded={!!contactsQuery.data} contactsError={contactsQuery.error} inbox={inboxByContact} busy={busy} selectedContactId={view === "inbox" ? selectedContact?.id ?? null : null}
        selectedRequestId={view === "requests" ? requestId : null} shipTakenDown={takenDown} onOpenContact={openContact}
        onOpenRequest={(id, to) => { closeSearch(); open({ view: "requests", direction: to, history: false, requestId: id, contactId: null }); }}
        onCompose={(found) => { setCompose({ ...emptyApproachDraft(found.url), profile: found }); setDialog("profile"); }} />
      : listView === "requests" ? <>
        {account && !canConfigure(account, "approach.list") && <p class="people-note people-access-note">{t("people.requests.noAccess")}</p>}
        <div class="people-list-tools"><button class="people-action" disabled={busy} onClick={() => { open({ direction: direction === "incoming" ? "outgoing" : "incoming", requestId: null }); }}>{t(direction === "incoming" ? "people.requests.showSent" : "people.requests.showReceived")}</button><button class="people-action" disabled={busy} onClick={() => { open({ history: !history, requestId: null }); }}>{t(history ? "people.requests.showCurrent" : "people.requests.showHistory")}</button></div>
        {requests.isFetching && !requests.data && <LoadingState variant="panel">{t("people.requests.loading")}</LoadingState>}
        {requests.error && <p class="people-error" role="alert">{requests.error.message}</p>}
        {requests.data && !items.length && <div class="people-empty-list"><p>{t(history ? "people.requests.noneHistory" : direction === "incoming" ? "people.requests.noneIncoming" : "people.requests.noneOutgoing")}</p><span>{t(direction === "incoming" ? "people.requests.reachHint" : "people.requests.startHint")}</span></div>}
        <ul class="people-rows">{items.map((item) => <RequestRow key={item.id} request={item} selected={requestId === item.id} busy={busy} shipTakenDown={takenDown} onOpen={() => open({ requestId: item.id })} />)}</ul>
        {requests.hasNextPage && <LoadOnScroll pages={requests.data?.pages.length ?? 0} loading={requests.isFetchingNextPage} failed={requests.isFetchNextPageError} onLoad={() => void requests.fetchNextPage()} />}
      </> : <>
        {listView === "inbox" && account && !canConfigure(account, "conversation.inbox") && <p class="people-note people-access-note">{t("people.inbox.noAccess")}</p>}
        {account && !canConfigure(account, "contact.list") && <p class="people-note people-access-note">{t("people.contacts.noAccess")}</p>}
        {(contactsQuery.isFetching && !contactsQuery.data || listView === "inbox" && inbox.isFetching && !inbox.data) && <LoadingState variant="panel">{t("people.inbox.loading")}</LoadingState>}
        {listView === "inbox" && inbox.error && <p class="people-error" role="alert">{inbox.error.message}</p>}
        {contactsQuery.error && <p class="people-error" role="alert">{contactsQuery.error.message}</p>}
        {contactsQuery.data && (listView === "contacts" || inbox.data) && !visible.length && <div class="people-empty-list"><p>{t(listView === "contacts" ? "people.contacts.empty" : archived ? "people.inbox.noArchived" : "people.inbox.empty")}</p><span>{t("people.inbox.emptyHint")}</span></div>}
        <ul class="people-rows">{visible.map((contact) => <ContactRow key={contact.id} contact={contact} entry={listView === "inbox" ? inboxByContact.get(contact.id) : undefined} dated={listView === "inbox"}
          selected={view === "inbox" && selectedContact?.id === contact.id} busy={busy} account={account} onOpen={() => openContact(contact.id)} />)}</ul>
        {listView === "inbox" && inbox.hasNextPage && <LoadOnScroll pages={inbox.data?.pages.length ?? 0} loading={inbox.isFetchingNextPage} failed={inbox.isFetchNextPageError} onLoad={() => void inbox.fetchNextPage()} />}
        {listView === "contacts" && <BlockedPeople account={account} filter="" />}
      </>}
      </div>
      <footer class="people-list-footer">
        {human && <button class="people-self" aria-current={view === "profile" ? "page" : undefined} disabled={busy || !canConfigure(account!, "profile.get")} onClick={() => open({ view: "profile", edit: false, focusBio: false })}><span>{profile.data?.handle ? `@${profile.data.handle}` : profile.data?.draft.displayName || account?.displayName || account?.username}{profileDirty ? " ·" : ""}</span>{takedowns.length > 0 && <small class="is-takedown">{t("people.profile.takenDownLabel")}</small>}</button>}
        <nav class="people-list-nav" aria-label={t("people.nav.label")}>
          <Hint text={t("people.inbox.showArchived")}><IconButton icon={<LineIcon path={LINE_ICONS.archive} />} variant="floating" size={40} ariaLabel={t("people.inbox.showArchived")} pressed={listView === "inbox" && archived} disabled={busy}
            onClick={() => { closeSearch(); open({ view: "inbox", contactId: null, requestId: null, archived: !(listView === "inbox" && archived) }); }} /></Hint>
          <Hint text={t("people.contacts.open")}><IconButton icon={<LineIcon path={LINE_ICONS.contacts} />} variant="floating" size={40} ariaLabel={t("people.contacts.open")} pressed={listView === "contacts"} disabled={busy} onClick={() => openList(listView === "contacts" ? "inbox" : "contacts")} /></Hint>
          <span class="people-nav-item">
            <Hint text={t("people.requests.open")}><IconButton icon={<LineIcon path={LINE_ICONS.requests} />} variant="floating" size={40} ariaLabel={pendingCount ? t("people.requests.openCount", { total: pendingLabel }) : t("people.requests.open")} pressed={listView === "requests"} disabled={busy || !account || !canConfigure(account, "approach.list")} onClick={() => openList(listView === "requests" ? "inbox" : "requests")} /></Hint>
            {pendingCount > 0 && <span class="people-nav-count" aria-hidden="true">{pendingLabel}</span>}
          </span>
          <Hint text={t("people.connect.add")}><IconButton icon={<LineIcon path={LINE_ICONS.connect} />} variant="floating" size={40} ariaLabel={t("people.connect.add")} disabled={!connected || busy || !mayStart} onClick={() => setDialog("invitation")} /></Hint>
        </nav>
        {!connected && <span class="people-reconnecting" role="status">{t("people.reconnecting")}</span>}
      </footer>
    </aside>
    <section class="people-detail" ref={detail} tabIndex={-1} aria-label={t(view === "profile" ? "people.profile.title" : "people.selected")}>
      {hasSelection && view !== "profile" && !(view === "inbox" && selectedContact) && <button class="people-action people-back" disabled={busy} onClick={() => { open({ view: view === "requests" ? "requests" : "inbox", contactId: null, requestId: null }); }}>{t(view === "requests" ? "people.back.requests" : "people.back.conversations")}</button>}
      <RetainedView active={active && view === "inbox"}>
        {selectedContact ? <ContactInspector key={selectedContact.id} contact={selectedContact} account={account} onBack={() => open({ contactId: null })} idea={chosenIdea?.contactId === selectedContact.id ? chosenIdea.index : null} onAsk={(task) => onAsk(contactAsk(selectedContact, task))} draft={drafts.drafts.get(selectedContact.id) ?? EMPTY_CONTACT_DRAFT} onDraft={(change) => drafts.update(selectedContact.id, change)} onSend={() => void drafts.send(selectedContact)} onRetry={(id) => void drafts.send(selectedContact, id)} onObserved={(ids) => drafts.observed(selectedContact.id, ids)} />
          : contactId ? contactsQuery.isFetching ? <LoadingState variant="panel">{t("people.inbox.opening")}</LoadingState> : <p class="people-note">{t("people.inbox.unavailable")}</p>
          : firstVisit ? <PeopleWelcome idea={idea} onIdea={setIdea} disabled={busy || !connected || !mayStart} onConnect={() => { setChosenIdea({ index: idea, contactId: null }); setDialog("invitation"); }} />
          : <div class="people-empty"><h2>{t("people.inbox.resume")}</h2><p>{t("people.inbox.resumeHint")}</p><button class="people-action" disabled={busy || !connected || !mayStart} onClick={() => setDialog("invitation")}>{t("people.connect.prompt")}</button></div>}
        {!contactId && contactsQuery.data?.attentionNotice && <ContactAttentionNotice account={account} />}
      </RetainedView>
      <RetainedView active={active && view === "requests"}>
        {requestId ? request.data ? <MessageRequest key={requestId} request={request.data} account={account} shipTakenDown={takenDown} onOpen={showConversation} /> : request.error ? <p class="people-error" role="alert">{request.error.message}</p> : <LoadingState variant="panel">{t("people.requests.opening")}</LoadingState>
          : <div class="people-empty"><p>{t("people.requests.select")}</p></div>}
      </RetainedView>
      <RetainedView active={active && view === "profile"}>{account && <Profile key={account.uid} account={account} active={active && view === "profile"} edit={edit} focusBio={focusBio} onDirty={setProfileDirty} onEdit={(focus) => open({ view: "profile", edit: true, focusBio: focus === "bio" })} onBack={() => edit ? open({ view: "profile", edit: false, focusBio: false }) : open({ view: "inbox", contactId: null })} />}</RetainedView>
      {view === "contacts" && <div class="people-empty"><p>{t("people.contacts.select")}</p></div>}
    </section>
    <FleetDialog open={active && dialog !== null} title={t(dialog === "invitation" ? "people.connect.title" : "people.compose.title")} onClose={() => { if (!busy) { clearContactInvitation(); setDialog(null); } }}>
      {dialog === "invitation" ? <InviteContact account={account} draft={invitation} onChange={setInvitation} onAdded={showConversation} onBusy={setBusy} onProfile={() => setDialog("profile")} />
        : dialog === "profile" ? <NewConversation account={account} draft={compose} onChange={setCompose} onSent={sent} onBusy={setBusy} contacts={contacts} onOpen={openContact} onInvitation={() => setDialog("invitation")} /> : null}
    </FleetDialog>
  </main>;
}

