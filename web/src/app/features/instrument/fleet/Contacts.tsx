import { ContactConversation, type ContactComposerProps } from "./ContactConversation";
import { ContactRequests } from "./ContactRequests";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useState } from "preact/hooks";
import { contactDisplayName, type ContactInviteCreateResult, type ContactSummary } from "@humansandmachines/gsv/protocol";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../gsv-console/domain/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { SetupCommand } from "./ConnectPlace";
import { INSTRUMENT_CONTACTS_KEY as CONTACTS_KEY, INSTRUMENT_CONTACT_INVITES_KEY as INVITES_KEY } from "../wire/queryKeys";

export function useFleetContacts(account: ConsoleAccount | undefined) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: CONTACTS_KEY,
    enabled: connected && !!account && canConfigure(account, "contact.list"),
    queryFn: async () => (await client.contact.list({ includeRevoked: true })).contacts,
  });
}

export function AddContact({ account, onClose, onAdded }: {
  account: ConsoleAccount | undefined;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [issued, setIssued] = useState<ContactInviteCreateResult | null>(null);
  const [code, setCode] = useState("");
  const allowed = (syscall: string) => connected && !!account && canConfigure(account, syscall);
  const invites = useQuery({
    queryKey: INVITES_KEY,
    enabled: allowed("contact.invite.list"),
    queryFn: async () => (await client.contact.invite.list({ includeTerminal: true })).invites,
  });
  const [now, setNow] = useState(Date.now());
  const deadline = Math.min(...(invites.data ?? []).filter((invite) => invite.state === "pending" && invite.expiresAtMs > now).map((invite) => invite.expiresAtMs));
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);
  const displayedInvites = invites.data?.map((invite) => invite.state === "pending" && invite.expiresAtMs <= Math.max(now, Date.now())
    ? { ...invite, state: "expired" as const } : invite);
  const currentInvite = displayedInvites?.find((invite) => invite.inviteId === issued?.inviteId);
  const create = useMutation({
    mutationFn: () => client.contact.invite.create({}),
    onSuccess: (invite) => { setIssued(invite); },
  });
  const accept = useMutation({
    mutationFn: (value: string) => client.contact.invite.accept({ code: value }),
    onSuccess: async ({ contact }) => { setCode(""); await cache.invalidateQueries({ queryKey: CONTACTS_KEY }, { cancelRefetch: false }); onAdded(contact.id); },
  });
  const cancel = useMutation({
    mutationFn: (inviteId: string) => client.contact.invite.cancel({ inviteId }),
    onSuccess: (_, inviteId) => { if (issued?.inviteId === inviteId) setIssued(null); },
  });
  const pending = create.isPending || accept.isPending || cancel.isPending;
  const error = create.error ?? accept.error ?? cancel.error ?? invites.error;
  const pendingInvites = displayedInvites?.filter((invite) => invite.state === "pending" && invite.inviteId !== issued?.inviteId) ?? [];

  return <section class="fleet-connection" aria-label="Add a contact">
    <h3>Add a contact</h3>
    <p class="note">Connect with someone who has their own Ship.</p>
    <div class="fleet-place-form">
      <h4>Invite someone</h4>
      {issued ? <>
        {currentInvite?.state === "accepted" ? <p class="note is-on" role="status">Invitation accepted. Your new contact is in Fleet.</p>
          : currentInvite?.state === "expired" || currentInvite?.state === "cancelled" ? <p class="note" role="status">This invitation has {currentInvite.state === "expired" ? "expired" : "been cancelled"}.</p>
          : <>
            <p class="note">Share this one-use code with them. It expires {new Date(issued.expiresAtMs).toLocaleString()}.</p>
            <SetupCommand text={issued.code} label="copy invite" />
          </>}
        <div class="fleet-actions">
          {currentInvite?.state === "pending" && <button type="button" class="fleet-text-action is-danger" disabled={!allowed("contact.invite.cancel") || pending} onClick={() => cancel.mutate(issued.inviteId)}>cancel invitation</button>}
          <button type="button" class="fleet-text-action" disabled={pending} onClick={() => setIssued(null)}>invite another person</button>
        </div>
      </> : <div class="fleet-actions"><button type="button" class="ibtn is-primary" disabled={!allowed("contact.invite.create") || pending} onClick={() => create.mutate()}>{create.isPending ? <LoadingState>creating…</LoadingState> : "create invite"}</button></div>}
    </div>
    <form class="fleet-place-form" onSubmit={(event) => { event.preventDefault(); if (allowed("contact.invite.accept") && code.trim() && !pending) accept.mutate(code.trim()); }}>
      <h4>Have an invitation?</h4>
      <label>Pairing code<textarea value={code} disabled={!allowed("contact.invite.accept") || pending} placeholder="Paste a code from another Ship" spellcheck={false} autoComplete="off" onInput={(event) => setCode(event.currentTarget.value)} /></label>
      <div class="fleet-actions"><button class="ibtn" type="submit" disabled={!allowed("contact.invite.accept") || !code.trim() || pending}>{accept.isPending ? <LoadingState>connecting…</LoadingState> : "accept invite"}</button></div>
    </form>
    {pendingInvites.length > 0 && <div class="fleet-place-form">
      <h4>Pending invitations</h4>
      <ul class="fleet-invites">{pendingInvites.map((invite) => <li key={invite.inviteId}>
        <span>Expires {new Date(invite.expiresAtMs).toLocaleString()}</span>
        <button type="button" class="fleet-text-action is-danger" disabled={!allowed("contact.invite.cancel") || pending} onClick={() => cancel.mutate(invite.inviteId)}>cancel invitation</button>
      </li>)}</ul>
    </div>}
    {error && <p class="error" role="alert">{error.message}</p>}
    <div class="fleet-actions"><button class="fleet-text-action" type="button" disabled={pending} onClick={onClose}>done</button></div>
  </section>;
}

export function ContactInspector({ contact, account, draft, onDraft, onSend }: ContactComposerProps & { contact: ContactSummary; account: ConsoleAccount | undefined }) {
  const [section, setSection] = useState<"details" | "messages" | "requests">(draft.text || draft.media.length ? "messages" : "details");
  const { client, connected } = useGateway();
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const alias = aliasDraft ?? contact.localAlias ?? "";
  const [confirm, setConfirm] = useState(false);
  const allowed = (syscall: string) => connected && contact.state === "active" && !!account
    && (account.uid === 0 || account.uid === contact.ownerUid) && canConfigure(account, syscall);
  const save = useMutation({
    mutationFn: (value: string) => client.contact.alias.set({ contactId: contact.id, alias: value || null }),
    onSuccess: () => { setAliasDraft(null); },
  });
  const revoke = useMutation({
    mutationFn: () => client.contact.revoke({ contactId: contact.id }),
    onSuccess: () => { setConfirm(false); },
  });
  const pending = save.isPending || revoke.isPending;
  const error = save.error ?? revoke.error;

  return <section class="fleet-connection" aria-label="Contact details">
    <h3>{contactDisplayName(contact)}</h3>
    <div class="sub">contact · {contact.state}</div>
    <nav class="fleet-contact-tabs" aria-label="Contact sections">{(["details", "messages", "requests"] as const).map((name) => <button key={name} class="fleet-text-action" aria-pressed={section === name} onClick={() => setSection(name)}>{name}</button>)}</nav>
    {section === "messages" ? <ContactConversation contact={contact} account={account} draft={draft} onDraft={onDraft} onSend={onSend} />
      : section === "requests" ? <ContactRequests contact={contact} account={account} />
      : <>
    <dl class="fleet-kv"><dt>Ship</dt><dd>{contact.remoteOrigin}</dd><dt>Connected</dt><dd>{new Date(contact.createdAtMs).toLocaleDateString()}</dd></dl>
    <form class="fleet-place-form" onSubmit={(event) => { event.preventDefault(); if (allowed("contact.alias.set") && !pending) save.mutate(alias.trim()); }}>
      <label>Name for this person<input value={alias} placeholder={contact.remoteSubject.displayName} disabled={!allowed("contact.alias.set") || pending} onInput={(event) => setAliasDraft(event.currentTarget.value)} /></label>
      <div class="fleet-actions"><button type="submit" class="ibtn" disabled={!allowed("contact.alias.set") || pending || alias.trim() === (contact.localAlias ?? "")}>{save.isPending ? <LoadingState>saving…</LoadingState> : "save name"}</button></div>
    </form>
    {contact.state === "active" && <div class="fleet-place-form">
      {confirm ? <>
        <p class="note">Revoke this connection? Messages and sharing with this contact will stop.</p>
        <div class="fleet-actions"><button class="fleet-text-action is-danger" disabled={!allowed("contact.revoke") || pending} onClick={() => revoke.mutate()}>{revoke.isPending ? <LoadingState>revoking…</LoadingState> : "confirm revoke"}</button><button class="fleet-text-action" disabled={pending} onClick={() => setConfirm(false)}>keep contact</button></div>
      </> : <div class="fleet-actions"><button class="fleet-text-action is-danger" disabled={!allowed("contact.revoke") || pending} onClick={() => setConfirm(true)}>revoke contact</button></div>}
    </div>}
    {error && <p class="error" role="alert">{error.message}</p>}
    </>}
  </section>;
}
