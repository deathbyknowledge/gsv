import { contactDisplayName, type ApproachListArgs, type ContactSummary, type ConversationInboxEntry, type PublicProfile } from "@humansandmachines/gsv/protocol";
import { useEffect } from "preact/hooks";
import { useInfiniteQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_APPROACHES_KEY } from "../wire/queryKeys";
import { useT } from "../../../i18n/locale";
import { BlockedPeople, useBlockedPeople } from "./BlockedPeople";
import { ContactRow, RequestRow } from "./PeopleRows";
import { handleLabel, matchesPerson, profileAddress } from "./peopleModel";
import { usePersonLookup } from "./usePersonLookup";

const NO_CURSOR: ApproachListArgs["before"] = undefined;
/** How long typing pauses before an address is looked up on the open network. */
const LOOKUP_DELAY_MS = 400;

/** Every pending request in one direction; searching loads all of them and lets them go when the search closes. */
function usePendingRequests(account: ConsoleAccount | undefined, direction: ApproachListArgs["direction"]) {
  const { client, connected } = useGateway();
  const requests = useInfiniteQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "search", direction],
    enabled: connected && !!account && canConfigure(account, "approach.list"),
    initialPageParam: NO_CURSOR,
    queryFn: ({ pageParam }) => client.approach.list({ direction, status: "active", before: pageParam, limit: 100 }),
    getNextPageParam: (page) => page.next,
    gcTime: 0,
  });
  useEffect(() => {
    if (requests.hasNextPage && !requests.isFetchingNextPage && !requests.error) void requests.fetchNextPage();
  }, [requests.hasNextPage, requests.isFetchingNextPage, requests.error]);
  return requests;
}

/**
 * One search across People, whichever list it was opened from: conversations, recent or archived,
 * pending requests, blocked people and, when nothing here matches, the public profile an address names.
 */
export function PeopleSearch({ account, query, contacts, contactsLoaded, contactsError, inbox, busy, selectedContactId, selectedRequestId, shipTakenDown, onOpenContact, onOpenRequest, onCompose }: {
  account: ConsoleAccount | undefined;
  query: string;
  contacts: ContactSummary[];
  /** Whether the contact list has arrived; until it has, nothing here can be ruled out. */
  contactsLoaded: boolean;
  contactsError: Error | null;
  inbox: Map<string, ConversationInboxEntry>;
  busy: boolean;
  selectedContactId: string | null;
  selectedRequestId: string | null;
  shipTakenDown: boolean;
  onOpenContact: (contactId: string) => void;
  onOpenRequest: (requestId: string, direction: ApproachListArgs["direction"]) => void;
  onCompose: (profile: PublicProfile) => void;
}) {
  const t = useT();
  const { connected } = useGateway();
  const incoming = usePendingRequests(account, "incoming");
  const outgoing = usePendingRequests(account, "outgoing");
  const lookup = usePersonLookup();
  const conversations = contacts.filter((contact) => matchesPerson([contactDisplayName(contact), contact.remoteName, contact.remoteHandle], query))
    .sort((a, b) => (inbox.get(b.id)?.conversation.updatedAt ?? b.updatedAtMs) - (inbox.get(a.id)?.conversation.updatedAt ?? a.updatedAtMs));
  const requests = [...incoming.data?.pages ?? [], ...outgoing.data?.pages ?? []].flatMap((page) => page.approaches)
    .filter((request) => matchesPerson([request.displayName, request.peerHandle], query))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  const requestsLoading = incoming.isFetching || outgoing.isFetching;
  // Blocked people are listed below the results, so they count as a match here.
  const blocked = useBlockedPeople(account, query, false);
  const blockedMatch = blocked.entries.length > 0 || blocked.searching;
  // Every local list this account may read has fully and successfully arrived; one still loading, cut short or failed
  // may hold the person. A list it may not read can't be checked here; the Kernel still refuses a request to someone blocked.
  const settled = (list: { isSuccess: boolean; isError: boolean; hasNextPage: boolean }, call: string) =>
    !account || !canConfigure(account, call) || (list.isSuccess && !list.isError && !list.hasNextPage);
  const mayListContacts = !!account && canConfigure(account, "contact.list");
  const localComplete = (!mayListContacts || (contactsLoaded && !contactsError)) && settled(incoming, "approach.list") && settled(outgoing, "approach.list")
    && settled(blocked.blocks, "contact.block.list");
  const address = profileAddress(query);
  const mayLookup = connected && !!account && canConfigure(account, "profile.resolve");
  const wantsProfile = !!address && mayLookup && localComplete && !conversations.length && !requests.length && !requestsLoading && !blockedMatch;
  useEffect(() => {
    lookup.reset();
    if (!wantsProfile) return;
    const timer = window.setTimeout(() => lookup.lookup(address!), LOOKUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [address, wantsProfile]);
  const profile = wantsProfile ? lookup.profile : undefined;
  const existing = profile ? contacts.find((contact) => contact.remoteDid === profile.did) : undefined;
  // A block is kept by DID with the name it had then, so a profile found under another name can still be blocked.
  const blockedProfile = !!profile && !!blocked.blocks.data?.pages.some((page) => page.blocks.some((block) => block.did === profile.did));
  // While typing pauses and the lookup runs, the profile is still on its way rather than missing.
  const awaitingProfile = wantsProfile && !profile && !lookup.error;
  const nothing = localComplete && !conversations.length && !requests.length && !requestsLoading && !wantsProfile && !blockedMatch;

  return <section class="people-search-results" aria-label={t("people.search.results")}>
    {conversations.length > 0 && <>
      <h2 class="people-search-heading">{t("people.search.conversations")}</h2>
      <ul class="people-rows">{conversations.map((contact) => <ContactRow key={contact.id} contact={contact} entry={inbox.get(contact.id)} dated
        selected={selectedContactId === contact.id} busy={busy} account={account} onOpen={() => onOpenContact(contact.id)} />)}</ul>
    </>}
    {requests.length > 0 && <>
      <h2 class="people-search-heading">{t("people.search.requests")}</h2>
      <ul class="people-rows">{requests.map((request) => <RequestRow key={request.id} request={request} selected={selectedRequestId === request.id} busy={busy}
        shipTakenDown={shipTakenDown} onOpen={() => onOpenRequest(request.id, request.direction)} />)}</ul>
    </>}
    {mayListContacts && !contactsLoaded && !contactsError && <LoadingState variant="panel">{t("people.inbox.loading")}</LoadingState>}
    {contactsError && <p class="people-error people-search-note" role="alert">{contactsError.message}</p>}
    {requestsLoading && <LoadingState variant="panel">{t("people.search.loadingRequests")}</LoadingState>}
    {(incoming.error ?? outgoing.error) && <p class="people-error people-search-note" role="alert">{(incoming.error ?? outgoing.error)?.message}{" "}
      {/* Loading stops at a failed page until the person asks again. */}
      {(incoming.isFetchNextPageError || outgoing.isFetchNextPageError) && <button class="people-action" onClick={() => {
        if (incoming.isFetchNextPageError) void incoming.fetchNextPage();
        if (outgoing.isFetchNextPageError) void outgoing.fetchNextPage();
      }}>{t("people.retry")}</button>}</p>}
    {awaitingProfile && <LoadingState variant="panel">{t("people.search.lookingUp")}</LoadingState>}
    {profile && <div class="people-search-profile">
      <span class="people-kicker">{handleLabel(profile.handle)}</span>
      <h2>{profile.displayName}</h2>
      {profile.about && <p>{profile.about}</p>}
      {blockedProfile ? <p class="people-note">{t("people.search.blockedProfile")}</p>
        : existing ? <button class="people-action is-accent" disabled={busy} onClick={() => onOpenContact(existing.id)}>{t("people.compose.openExisting")}</button>
        : profile.contactPolicy === "requests" ? account && canConfigure(account, "approach.create")
          ? <button class="people-action is-accent" disabled={busy} onClick={() => onCompose(profile)}>{t("people.search.sendRequest")}</button>
          : <p class="people-note">{t("people.compose.noSend")}</p>
        : <p class="people-note">{t(profile.contactPolicy === "invitation" ? "people.compose.byInvitation" : "people.compose.closed")}</p>}
    </div>}
    {wantsProfile && lookup.missing && <p class="people-note people-search-note">{t("people.search.noProfile", { handle: query.trim().replace(/^@?/, "@") })}</p>}
    {wantsProfile && lookup.error && !lookup.missing && <p class="people-error people-search-note" role="alert">{lookup.error.message}</p>}
    {nothing && <div class="people-empty-list"><p>{t("people.inbox.noMatch")}</p><span>{t("people.inbox.tryName")}</span></div>}
    <BlockedPeople account={account} filter={query} />
  </section>;
}
