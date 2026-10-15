import { contactDisplayName } from "@humansandmachines/gsv/protocol";
import { useMutation } from "@tanstack/preact-query";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { useContacts } from "../people/Contacts";
import { NewConversation } from "../people/NewConversation";
import { emptyApproachDraft, profileAddress, profileAddressLabel } from "../people/peopleModel";
import type { PeopleOpenRequest } from "../people/People";
import { canConfigure } from "../settings/settingsModel";
import type { ChatContext } from "./chatContextModel";

export function ChatPerson({ account, request, onAsk, onPeople, onDirty }: {
  account?: ConsoleAccount;
  request: Extract<ChatContext, { kind: "person" }>;
  onAsk: (text: string) => void;
  onPeople: (request: PeopleOpenRequest) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { client, connected } = useGateway();
  const [address, setAddress] = useState(request.url ?? "");
  const [draft, setDraft] = useState(() => emptyApproachDraft());
  const [contacting, setContacting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const revision = useRef(0);
  const handled = useRef<typeof request>();
  const contacts = useContacts(account);
  const resolve = useMutation({
    mutationFn: async ({ address, revision }: { address: string; revision: number }) => ({ ...(await client.profile.resolve({ url: address })), revision }),
    onSuccess: ({ profile, revision: resolved }) => {
      if (revision.current === resolved) { setAddress(profile.url); setDraft({ ...emptyApproachDraft(profile.url), profile }); }
    },
  });
  const mayReplace = () => !busy && (!draft.text || window.confirm("Discard this unsent contact request and open another person?"));
  const lookup = (address: string) => {
    if (!mayReplace()) return;
    setSelectedContactId(null); setDraft(emptyApproachDraft()); setContacting(false); setSent(false);
    resolve.mutate({ address, revision: ++revision.current });
  };
  useLayoutEffect(() => { onDirty(!!draft.text || busy); }, [draft.text, busy, onDirty]);
  useLayoutEffect(() => {
    const { url } = request;
    if (!url || handled.current === request || !connected || !account) return;
    const saved = contacts.data?.contacts.find((contact) => contact.state === "active" && !contact.blocked && `${contact.remoteOrigin}/profile` === url);
    if (!saved && !canConfigure(account, "profile.resolve")) return;
    handled.current = request;
    if (saved) {
      if (!mayReplace()) return;
      revision.current++; resolve.reset(); setDraft(emptyApproachDraft());
      setAddress(url); setContacting(false); setSent(false); setSelectedContactId(saved.id);
    } else lookup(url);
  }, [request, connected, account?.uid, contacts.data]);
  const found = (contacts.data?.contacts ?? []).filter((contact) => contact.state === "active" && !contact.blocked
    && `${contactDisplayName(contact)} ${contact.remoteOrigin}`.toLocaleLowerCase().includes(address.trim().replace(/^@/, "").toLocaleLowerCase()));
  const profile = draft.profile;
  const selectedContact = contacts.data?.contacts.find((contact) => contact.id === selectedContactId && contact.state === "active" && !contact.blocked);
  const preview = selectedContact ? {
    displayName: contactDisplayName(selectedContact), origin: selectedContact.remoteOrigin,
    url: `${selectedContact.remoteOrigin}/profile`, about: undefined,
  } : profile && profileAddress(address) === profile.url ? profile : undefined;
  const allowed = connected && !!account && canConfigure(account, "profile.resolve");
  return <div class={`chat-person${!contacting && !preview ? " is-searching" : ""}`}>
    {contacting ? <>
      <button type="button" class="fleet-text-action chat-context-back" disabled={busy} onClick={() => setContacting(false)}>← profile</button>
      {sent ? <p role="status">Message request sent.</p> : <NewConversation account={account} draft={draft} onChange={setDraft}
        contacts={contacts.data?.contacts ?? []} onBusy={setBusy} onSent={() => { setDraft((value) => ({ ...value, text: "" })); setSent(true); }}
        onOpen={(contactId) => onPeople({ contactId })} />}
    </> : <>
      <form class="people-form" onSubmit={(event) => {
        event.preventDefault(); const url = profileAddress(address);
        if (url && allowed) lookup(url);
      }}>
        <label>Find a person<input placeholder="@handle, name or address" value={address} autoComplete="off" autoCapitalize="none" spellcheck={false}
          onInput={(event) => { revision.current++; resolve.reset(); setAddress(event.currentTarget.value); if (!draft.text) setDraft(emptyApproachDraft()); setSent(false); setSelectedContactId(null); }} /></label>
        {profileAddress(address) && <button type="submit" class="fleet-text-action" disabled={!allowed || resolve.isPending}>
          {resolve.isPending ? <LoadingState>opening profile…</LoadingState> : "open profile"}
        </button>}
      </form>
      {(resolve.error ?? contacts.error) && <p class="people-error" role="alert">{(resolve.error ?? contacts.error)?.message}</p>}
      {preview ? <div class="chat-profile-preview">
        <span class="people-kicker">{profileAddressLabel(preview.origin)}</span><h3>{preview.displayName}</h3>
        {preview.about && <p>{preview.about}</p>}
        <div class="fleet-actions">
          <button type="button" class="fleet-text-action is-primary" onClick={() => onAsk(`Help me with ${JSON.stringify(preview.displayName)}'s GSV profile: ${preview.url}`)}>mention in message</button>
          <button type="button" class="fleet-text-action" onClick={() => selectedContact ? onPeople({ contactId: selectedContact.id }) : setContacting(true)}>{selectedContact ? "open conversation" : "contact"}</button>
        </div>
      </div> : <ul class="people-recipient-list" aria-label="Saved people" data-scroll-edge>
        {found.map((contact) => <li key={contact.id}><button type="button" class="people-recipient"
          onClick={() => { if (!mayReplace()) return; revision.current++; resolve.reset(); setDraft(emptyApproachDraft()); setAddress(`${contact.remoteOrigin}/profile`); setSelectedContactId(contact.id); }}>
          <span>{contactDisplayName(contact)}</span><small>{profileAddressLabel(contact.remoteOrigin)}</small>
        </button></li>)}
        {!found.length && <li class="people-note">Enter a handle to find someone on gsv.space, or their full address for another GSV.</li>}
      </ul>}
      {!connected && <p class="people-note" role="status">Reconnecting…</p>}
    </>}
  </div>;
}
