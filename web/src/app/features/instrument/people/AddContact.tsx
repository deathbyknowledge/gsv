import { contactDisplayName, type ApproachSummary, type ContactSummary } from "@humansandmachines/gsv/protocol";
import { useEffect } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { publicDeployment } from "../../../services/deployment";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { TextInput } from "../../../components/ui/TextInput";
import { canConfigure } from "../settings/settingsModel";
import { useT } from "../../../i18n/locale";
import { NewConversation } from "./NewConversation";
import { handleLabel, matchesPerson, profileAddress, type ApproachDraft } from "./peopleModel";
import { usePersonLookup } from "./usePersonLookup";
import { useQuery } from "../../../services/navigation/viewQueries";
import { INSTRUMENT_CONTACT_BLOCKS_KEY } from "../wire/queryKeys";

/** How long typing pauses before a handle is looked up on the open network. */
const LOOKUP_DELAY_MS = 400;

/**
 * Finds someone by handle, among your contacts or on the open network, and starts a message request
 * to them; someone without a Ship gets an invitation link instead.
 */
export function AddContact({ account, draft, onChange, onSent, onBusy, contacts, onOpen, onInvite, onHaveInvitation }: {
  account: ConsoleAccount | undefined;
  draft: ApproachDraft;
  onChange: (value: ApproachDraft) => void;
  onSent: (request: ApproachSummary) => void;
  onBusy: (busy: boolean) => void;
  contacts: ContactSummary[];
  onOpen: (contactId: string) => void;
  onInvite: () => void;
  onHaveInvitation: () => void;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const lookup = usePersonLookup();
  const query = draft.url.trim();
  const address = profileAddress(query);
  const known = query ? contacts.filter((contact) => contact.state === "active" && !contact.blocked && matchesPerson([contactDisplayName(contact), contact.remoteHandle], query))
    .sort((a, b) => contactDisplayName(a).localeCompare(contactDisplayName(b))) : [];
  const mayLookup = connected && !!account && canConfigure(account, "profile.resolve");
  useEffect(() => {
    lookup.reset();
    if (!address || !mayLookup || draft.profile) return;
    const timer = window.setTimeout(() => lookup.lookup(address), LOOKUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [address, mayLookup, !!draft.profile]);
  const found = lookup.profile && !known.some((contact) => contact.remoteDid === lookup.profile!.did) ? lookup.profile : undefined;
  // A block is kept by DID, so whoever was found is checked by theirs, under whatever name they were blocked.
  const mayCheckBlock = connected && !!account && canConfigure(account, "contact.block.list");
  const blockCheck = useQuery({
    queryKey: [...INSTRUMENT_CONTACT_BLOCKS_KEY, "did", found?.did],
    enabled: mayCheckBlock && !!found,
    queryFn: async () => (await client.contact.block.list({ did: found!.did })).blocks.length > 0,
  });
  const foundBlocked = blockCheck.data === true;
  // Until the check answers, the person isn't offered a request; an account that may not check leaves it to the Kernel.
  const blockSettled = !mayCheckBlock || blockCheck.isSuccess;
  // A request needs its handling choice too, which takes contact.preferences.update.
  const maySendRequest = !!account && canConfigure(account, "approach.create") && canConfigure(account, "contact.preferences.update");
  const looking = !!address && mayLookup && !lookup.profile && !lookup.error;
  const missing = !!query && !known.length && !found && !looking;

  if (draft.profile) return <>
    <button class="people-action" onClick={() => onChange({ ...draft, profile: null, shipHandlesMessages: null, intent: null })}>{t("people.add.back")}</button>
    <NewConversation account={account} draft={draft} onChange={onChange} onSent={onSent} onBusy={onBusy} contacts={contacts} onOpen={onOpen} />
  </>;

  return <section class="people-add" aria-label={t("people.add.title")}>
    <TextInput label={t("people.add.label")} size="large" value={draft.url} placeholder={t("people.add.placeholder", { domain: publicDeployment().primaryDomain || "ship.space" })}
      onChange={(url) => onChange({ ...draft, url })} inputProps={{ autoFocus: true, autoComplete: "off", autoCapitalize: "none", spellcheck: false }} />
    <div class="people-add-links">
      <button class="people-action is-accent" onClick={onInvite}>{t("people.add.invite")}</button>
      <button class="people-action" disabled={!account || !canConfigure(account, "contact.invite.accept")} onClick={onHaveInvitation}>{t("people.invite.have")}</button>
    </div>
    {(known.length > 0 || found) && <ul class="people-add-results" aria-label={t("people.add.results")}>
      {known.map((contact) => <li key={contact.id}>
        <span><strong>{contactDisplayName(contact)}</strong>{contact.remoteHandle && <small>{handleLabel(contact.remoteHandle)}</small>}</span>
        <button class="people-action is-accent" onClick={() => onOpen(contact.id)}>{t("people.add.message", { name: contactDisplayName(contact) })}</button>
      </li>)}
      {found && <li>
        <span><strong>{found.displayName}</strong><small>{handleLabel(found.handle)}</small>{found.about && <em>{found.about}</em>}</span>
        {foundBlocked ? <small>{t("people.search.blockedProfile")}</small>
          : !maySendRequest ? <small>{t("people.compose.noSend")}</small>
          : blockCheck.error ? <small class="people-error" role="alert">{blockCheck.error.message}</small>
          : !blockSettled ? null
          : <button class="people-action is-accent" onClick={() => onChange({ ...draft, profile: found })}>{t("people.add.message", { name: found.displayName })}</button>}
      </li>}
    </ul>}
    {looking && !known.length && <LoadingState variant="panel">{t("people.search.lookingUp")}</LoadingState>}
    {missing && (lookup.error && !lookup.missing ? <p class="people-error" role="alert">{lookup.error.message}</p> : <p class="people-note" role="status">{t("people.add.noMatch")}</p>)}
    {account && !canConfigure(account, "profile.resolve") && <p class="people-note">{t("people.add.noLookup")}</p>}
    {!connected && <p class="people-note" role="status">{t("people.composer.reconnecting")}</p>}
  </section>;
}
