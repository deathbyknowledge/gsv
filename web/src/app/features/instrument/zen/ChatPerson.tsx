import { contactDisplayName } from "@humansandmachines/gsv/protocol";
import { useMutation } from "@tanstack/preact-query";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { useContacts } from "../people/Contacts";
import { NewConversation } from "../people/NewConversation";
import { contactProfileUrl, emptyApproachDraft, handleLabel, profileAddress } from "../people/peopleModel";
import type { PeopleOpenRequest } from "../people/People";
import { canConfigure } from "../settings/settingsModel";
import { useT } from "../../../i18n/locale";
import type { ChatContext } from "./chatContextModel";

export function ChatPerson({ account, request, onAsk, onPeople, onDirty }: {
  account?: ConsoleAccount;
  request: Extract<ChatContext, { kind: "person" }>;
  onAsk: (text: string) => void;
  onPeople: (request: PeopleOpenRequest) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const t = useT();
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
    mutationFn: async ({ address, revision }: { address: string; revision: number }) => ({ ...(await client.profile.resolve({ address })), revision }),
    onSuccess: ({ profile, revision: resolved }) => {
      if (revision.current === resolved) { setAddress(profile.url); setDraft({ ...emptyApproachDraft(profile.url), profile }); }
    },
  });
  const mayReplace = () => !busy && (!draft.text || window.confirm(t("chat.person.discard")));
  const lookup = (address: string) => {
    if (!mayReplace()) return;
    setSelectedContactId(null); setDraft(emptyApproachDraft()); setContacting(false); setSent(false);
    resolve.mutate({ address, revision: ++revision.current });
  };
  useLayoutEffect(() => { onDirty(!!draft.text || busy); }, [draft.text, busy, onDirty]);
  useLayoutEffect(() => {
    const { url } = request;
    if (!url || handled.current === request || !connected || !account) return;
    const saved = contacts.data?.contacts.find((contact) => contact.state === "active" && !contact.blocked && contactProfileUrl(contact) === url);
    if (!saved && !canConfigure(account, "profile.resolve")) return;
    handled.current = request;
    if (saved) {
      if (!mayReplace()) return;
      revision.current++; resolve.reset(); setDraft(emptyApproachDraft());
      setAddress(url); setContacting(false); setSent(false); setSelectedContactId(saved.id);
    } else lookup(url);
  }, [request, connected, account?.uid, contacts.data]);
  const found = (contacts.data?.contacts ?? []).filter((contact) => contact.state === "active" && !contact.blocked
    && `${contactDisplayName(contact)} ${contact.remoteHandle ?? ""}`.toLocaleLowerCase().includes(address.trim().replace(/^@/, "").toLocaleLowerCase()));
  const profile = draft.profile;
  const selectedContact = contacts.data?.contacts.find((contact) => contact.id === selectedContactId && contact.state === "active" && !contact.blocked);
  const preview = selectedContact ? {
    displayName: contactDisplayName(selectedContact), handle: selectedContact.remoteHandle,
    url: contactProfileUrl(selectedContact), about: undefined,
  } : profile && profileAddress(address) === profile.url ? profile : undefined;
  const allowed = connected && !!account && canConfigure(account, "profile.resolve");
  return <div class={`chat-person${!contacting && !preview ? " is-searching" : ""}`}>
    {contacting ? <>
      <button type="button" class="fleet-text-action chat-context-back" disabled={busy} onClick={() => setContacting(false)}>{t("chat.person.back")}</button>
      {sent ? <p role="status">{t("chat.person.sent")}</p> : <NewConversation account={account} draft={draft} onChange={setDraft}
        contacts={contacts.data?.contacts ?? []} onBusy={setBusy} onSent={() => { setDraft((value) => ({ ...value, text: "" })); setSent(true); }}
        onOpen={(contactId) => onPeople({ contactId })} />}
    </> : <>
      <form class="people-form" onSubmit={(event) => {
        event.preventDefault(); const url = profileAddress(address);
        if (url && allowed) lookup(url);
      }}>
        <label>{t("chat.person.find")}<input placeholder={t("chat.person.placeholder")} value={address} autoComplete="off" autoCapitalize="none" spellcheck={false}
          onInput={(event) => { revision.current++; resolve.reset(); setAddress(event.currentTarget.value); if (!draft.text) setDraft(emptyApproachDraft()); setSent(false); setSelectedContactId(null); }} /></label>
        {profileAddress(address) && <button type="submit" class="fleet-text-action" disabled={!allowed || resolve.isPending}>
          {resolve.isPending ? <LoadingState>{t("chat.person.opening")}</LoadingState> : t("chat.person.open")}
        </button>}
      </form>
      {(resolve.error ?? contacts.error) && <p class="people-error" role="alert">{(resolve.error ?? contacts.error)?.message}</p>}
      {preview ? <div class="chat-profile-preview">
        {preview.handle && <span class="people-kicker">{handleLabel(preview.handle)}</span>}<h3>{preview.displayName}</h3>
        {preview.about && <p>{preview.about}</p>}
        <div class="fleet-actions">
          <button type="button" class="fleet-text-action is-primary" onClick={() => onAsk(preview.url ? `Help me with ${JSON.stringify(preview.displayName)}'s Ship profile: ${preview.url}` : `Help me with my contact ${JSON.stringify(preview.displayName)}.`)}>{t("chat.person.mention")}</button>
          <button type="button" class="fleet-text-action" onClick={() => selectedContact ? onPeople({ contactId: selectedContact.id }) : setContacting(true)}>{t(selectedContact ? "chat.contact.open" : "chat.person.contact")}</button>
        </div>
      </div> : <ul class="people-recipient-list" aria-label={t("chat.person.saved")} data-scroll-edge>
        {found.map((contact) => <li key={contact.id}><button type="button" class="people-recipient"
          onClick={() => { if (!mayReplace()) return; revision.current++; resolve.reset(); setDraft(emptyApproachDraft()); setAddress(contactProfileUrl(contact) ?? address); setSelectedContactId(contact.id); }}>
          <span>{contactDisplayName(contact)}</span>{contact.remoteHandle && <small>{handleLabel(contact.remoteHandle)}</small>}
        </button></li>)}
        {!found.length && <li class="people-note">{t("chat.person.hint")}</li>}
      </ul>}
      {!connected && <p class="people-note" role="status">{t("chat.person.reconnecting")}</p>}
    </>}
  </div>;
}
