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
import { INSTRUMENT_APPROACHES_KEY, INSTRUMENT_CONTACTS_KEY, INSTRUMENT_INBOX_KEY, INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { Profile } from "./Profile";
import { NewConversation } from "./NewConversation";
import { MessageRequest } from "./MessageRequest";
import { BlockedPeople } from "./BlockedPeople";
import { approachStatus, emptyApproachDraft, inboxPreview } from "./peopleModel";
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
  const [dialog, setDialog] = useState<"profile" | "invitation" | "blocked" | null>(() => invitation.code ? "invitation" : compose.url ? "profile" : null);
  const firstDestination = useRef(true);
  useLayoutEffect(() => {
    if (firstDestination.current) { firstDestination.current = false; return; }
    setDialog(null);
  }, [active, view, contactId, requestId]);
  const listView = view === "profile" ? "inbox" : view;
  const [filter, setFilter] = useState("");
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
  const request = useQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "detail", requestId], enabled: connected && view === "requests" && !!requestId && human && canConfigure(account!, "approach.get"),
    queryFn: async () => (await client.approach.get({ approachId: requestId! })).approach,
  });
  const selectedContact = contacts.find((contact) => contact.id === inboxContact.current);
  const visible = contacts.filter((contact) => (view === "contacts" ? contact.preferences?.saved !== false : inboxByContact.has(contact.id))
    && `${contactDisplayName(contact)} ${contact.remoteSubject.displayName} ${contact.remoteOrigin}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
    .sort((a, b) => view === "contacts" ? contactDisplayName(a).localeCompare(contactDisplayName(b)) : (inboxByContact.get(b.id)?.conversation.updatedAt ?? 0) - (inboxByContact.get(a.id)?.conversation.updatedAt ?? 0));
  const items = requests.data?.pages.flatMap((page) => page.approaches) ?? [];
  const hasSelection = view === "profile" || (view === "requests" ? !!requestId : view === "inbox" && !!contactId);
  useLayoutEffect(() => { if (active && hasSelection) detail.current?.focus({ preventScroll: true }); }, [active, view, contactId, requestId]);
  const mayStart = !!account && (canConfigure(account, "contact.invite.create") || canConfigure(account, "contact.invite.accept") || canConfigure(account, "profile.resolve"));
  const firstVisit = !!contactsQuery.data && !contacts.length && !hasSelection && view === "inbox" && !archived;
  const openList = (next: PeopleRoute["view"]) => {
    setFilter("");
    open({ view: next, contactId: null, requestId: null, direction: next === "requests" ? "incoming" : direction, history: next === "requests" ? false : history });
  };
  const openContact = (id: string) => {
    setDialog(null);
    setFilter("");
    open({ view: "inbox", contactId: id });
  };
  const showConversation = (id: string) => {
    setChosenIdea((current) => current && !current.contactId ? { ...current, contactId: id } : current);
    void cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY });
    void cache.invalidateQueries({ queryKey: INSTRUMENT_INBOX_KEY });
    setDialog(null); setFilter("");
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
      <header class="people-list-heading"><h1>{t(listView === "inbox" ? "people.title" : listView === "contacts" ? "people.contacts.title" : history ? "people.requests.pastTitle" : direction === "outgoing" ? "people.requests.sentTitle" : "people.requests.title")}</h1>
        {listView !== "requests" && <div class="people-list-heading-actions">
          {listView === "inbox" && <button class="people-action people-request-entry" disabled={busy || !account || !canConfigure(account, "approach.list")} onClick={() => openList("requests")}>
            <span>{t("people.requests.open")}</span>{items.length > 0 && <span class="people-request-count">{items.length}{requests.hasNextPage ? "+" : ""}</span>}
          </button>}
          {listView === "inbox" && <button class="people-action" disabled={busy} onClick={() => openList("contacts")}>{t("people.contacts.open")}</button>}
          <button class="people-action" aria-label={t("people.connect.title")} disabled={!connected || busy || !mayStart} onClick={() => setDialog("invitation")}>{t("people.connect.action")}</button>
        </div>}
      </header>
      {listView !== "inbox" && <button class="people-action people-list-back" aria-label={t("people.back.label")} disabled={busy} onClick={() => openList("inbox")}>{t("people.back.conversations")}</button>}
      {listView === "requests" ? <>
        {account && !canConfigure(account, "approach.list") && <p class="people-note people-access-note">{t("people.requests.noAccess")}</p>}
        <div class="people-list-tools"><button class="people-action" disabled={busy} onClick={() => { open({ direction: direction === "incoming" ? "outgoing" : "incoming", requestId: null }); }}>{t(direction === "incoming" ? "people.requests.showSent" : "people.requests.showReceived")}</button><button class="people-action" disabled={busy} onClick={() => { open({ history: !history, requestId: null }); }}>{t(history ? "people.requests.showCurrent" : "people.requests.showHistory")}</button></div>
        {requests.isFetching && !requests.data && <LoadingState variant="panel">{t("people.requests.loading")}</LoadingState>}
        {requests.error && <p class="people-error" role="alert">{requests.error.message}</p>}
        {requests.data && !items.length && <div class="people-empty-list"><p>{t(history ? "people.requests.noneHistory" : direction === "incoming" ? "people.requests.noneIncoming" : "people.requests.noneOutgoing")}</p><span>{t(direction === "incoming" ? "people.requests.reachHint" : "people.requests.startHint")}</span></div>}
        <ul class="people-rows">{items.map((item) => <li key={item.id}><button class={`people-row${requestId === item.id ? " is-selected" : ""}`} disabled={busy} aria-current={requestId === item.id ? "true" : undefined} onClick={() => open({ requestId: item.id })}><span class="people-row-name">{item.displayName}</span><time>{new Date(item.createdAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><span class="people-row-preview">{t(approachStatus(item))}</span></button></li>)}</ul>
        {requests.hasNextPage && <button class="people-action people-more" disabled={requests.isFetchingNextPage} onClick={() => void requests.fetchNextPage()}>{t(requests.isFetchingNextPage ? "people.loadingMore" : "people.requests.earlier")}</button>}
      </> : <>
        {listView === "inbox" && account && !canConfigure(account, "conversation.inbox") && <p class="people-note people-access-note">{t("people.inbox.noAccess")}</p>}
        {account && !canConfigure(account, "contact.list") && <p class="people-note people-access-note">{t("people.contacts.noAccess")}</p>}
        <div class="people-list-tools"><input class="people-filter" aria-label={t(listView === "contacts" ? "people.contacts.find" : "people.inbox.find")} value={filter} placeholder={t(listView === "contacts" ? "people.contacts.findPlaceholder" : "people.inbox.filter")} onInput={(event) => setFilter(event.currentTarget.value)} /></div>
        {listView === "inbox" && archived && <div class="people-archive-heading"><span>{t("people.inbox.archived")}</span><button class="people-action" onClick={() => open({ archived: false })}>{t("people.inbox.leaveArchive")}</button></div>}
        {(contactsQuery.isFetching && !contactsQuery.data || listView === "inbox" && inbox.isFetching && !inbox.data) && <LoadingState variant="panel">{t("people.inbox.loading")}</LoadingState>}
        {listView === "inbox" && inbox.error && <p class="people-error" role="alert">{inbox.error.message}</p>}
        {contactsQuery.error && <p class="people-error" role="alert">{contactsQuery.error.message}</p>}
        {contactsQuery.data && (listView === "contacts" || inbox.data) && !visible.length && <div class="people-empty-list"><p>{t(filter ? "people.inbox.noMatch" : listView === "contacts" ? "people.contacts.empty" : archived ? "people.inbox.noArchived" : "people.inbox.empty")}</p><span>{t(filter ? "people.inbox.tryName" : "people.inbox.emptyHint")}</span></div>}
        <ul class="people-rows">{visible.map((contact) => <li key={contact.id}><button class={`people-row${view === "inbox" && selectedContact?.id === contact.id ? " is-selected" : ""}${listView === "inbox" && inboxByContact.get(contact.id)?.unread ? " is-unread" : ""}`} disabled={busy} aria-current={view === "inbox" && selectedContact?.id === contact.id ? "true" : undefined} onClick={() => openContact(contact.id)}><span class="people-row-name">{contactDisplayName(contact)}{listView === "inbox" && inboxByContact.get(contact.id)?.unread && <span class="people-unread" aria-label={t("people.inbox.unread")} />}</span>{listView === "inbox" && <time>{new Date(inboxByContact.get(contact.id)?.conversation.updatedAt ?? contact.updatedAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>}<span class="people-row-preview">{inboxPreview(contact, listView === "inbox" ? inboxByContact.get(contact.id) : undefined)}</span></button></li>)}</ul>
        {listView === "inbox" && inbox.hasNextPage && <button class="people-action people-more" disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>{t(inbox.isFetchingNextPage ? "people.loadingMore" : "people.inbox.earlier")}</button>}
      </>}
      </div>
      <footer class="people-list-footer">
        <details class="people-list-more"><summary>{t("people.more")}</summary><div>
          <button class="people-action" disabled={busy} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setFilter(""); open({ view: "inbox", contactId: null, archived: !archived }); }}>{t(archived ? "people.inbox.showCurrent" : "people.inbox.showArchived")}</button>
          <button class="people-action" disabled={busy || !account || !canConfigure(account, "contact.block.list")} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setDialog("blocked"); }}>{t("people.blocked.open")}</button>
        </div></details>
        {human && <button class="people-self" aria-current={view === "profile" ? "page" : undefined} disabled={busy || !canConfigure(account!, "profile.get")} onClick={() => open({ view: "profile", edit: false, focusBio: false })}><span>{profile.data ? `@${new URL(profile.data.url).hostname.split(".")[0]}` : account?.displayName || account?.username}{profileDirty ? " ·" : ""}</span></button>}
        {!connected && <span role="status">{t("people.reconnecting")}</span>}
      </footer>
    </aside>
    <section class="people-detail" ref={detail} tabIndex={-1} aria-label={t(view === "profile" ? "people.profile.title" : "people.selected")}>
      {hasSelection && view !== "profile" && !(view === "inbox" && selectedContact) && <button class="people-action people-back" disabled={busy} onClick={() => { open({ view: view === "requests" ? "requests" : "inbox", contactId: null, requestId: null }); }}>{t(view === "requests" ? "people.back.requests" : "people.back.conversations")}</button>}
      <RetainedView active={active && view === "inbox"}>
        {selectedContact ? <ContactInspector key={selectedContact.id} contact={selectedContact} account={account} onBack={() => open({ contactId: null })} idea={chosenIdea?.contactId === selectedContact.id ? chosenIdea.index : null} onAsk={(task) => onAsk(`Help me with ${JSON.stringify(contactDisplayName(selectedContact))}'s Ship profile: ${selectedContact.remoteOrigin}/profile\n\n${task.replaceAll("{name}", `${contactDisplayName(selectedContact)} (${new URL(selectedContact.remoteOrigin).host})`)}`)} draft={drafts.drafts.get(selectedContact.id) ?? EMPTY_CONTACT_DRAFT} onDraft={(change) => drafts.update(selectedContact.id, change)} onSend={() => void drafts.send(selectedContact)} onRetry={(id) => void drafts.send(selectedContact, id)} onObserved={(ids) => drafts.observed(selectedContact.id, ids)} />
          : contactId ? contactsQuery.isFetching ? <LoadingState variant="panel">{t("people.inbox.opening")}</LoadingState> : <p class="people-note">{t("people.inbox.unavailable")}</p>
          : firstVisit ? <PeopleWelcome idea={idea} onIdea={setIdea} disabled={busy || !connected || !mayStart} onConnect={() => { setChosenIdea({ index: idea, contactId: null }); setDialog("invitation"); }} />
          : <div class="people-empty"><h2>{t("people.inbox.resume")}</h2><p>{t("people.inbox.resumeHint")}</p><button class="people-action" disabled={busy || !connected || !mayStart} onClick={() => setDialog("invitation")}>{t("people.connect.prompt")}</button></div>}
        {!contactId && contactsQuery.data?.attentionNotice && <ContactAttentionNotice account={account} />}
      </RetainedView>
      <RetainedView active={active && view === "requests"}>
        {requestId ? request.data ? <MessageRequest key={requestId} request={request.data} account={account} onOpen={showConversation} /> : request.error ? <p class="people-error" role="alert">{request.error.message}</p> : <LoadingState variant="panel">{t("people.requests.opening")}</LoadingState>
          : <div class="people-empty"><p>{t("people.requests.select")}</p></div>}
      </RetainedView>
      <RetainedView active={active && view === "profile"}>{account && <Profile key={account.uid} account={account} active={active && view === "profile"} edit={edit} focusBio={focusBio} onDirty={setProfileDirty} onEdit={(focus) => open({ view: "profile", edit: true, focusBio: focus === "bio" })} onBack={() => edit ? open({ view: "profile", edit: false, focusBio: false }) : open({ view: "inbox", contactId: null })} />}</RetainedView>
      {view === "contacts" && <div class="people-empty"><p>{t("people.contacts.select")}</p></div>}
    </section>
    <FleetDialog open={active && dialog !== null} title={t(dialog === "blocked" ? "people.blocked.title" : dialog === "invitation" ? "people.connect.title" : "people.compose.title")} onClose={() => { if (!busy) { clearContactInvitation(); setDialog(null); } }}>
      {dialog === "blocked" ? <BlockedPeople account={account} /> : dialog === "invitation" ? <InviteContact account={account} draft={invitation} onChange={setInvitation} onAdded={showConversation} onBusy={setBusy} onProfile={() => setDialog("profile")} />
        : dialog === "profile" ? <NewConversation account={account} draft={compose} onChange={setCompose} onSent={sent} onBusy={setBusy} contacts={contacts} onOpen={openContact} onInvitation={() => setDialog("invitation")} /> : null}
    </FleetDialog>
  </main>;
}
