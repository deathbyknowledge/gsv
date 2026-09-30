import { ContactConversation, type ContactComposerProps } from "./ContactConversation";
import { ContactRequests } from "./ContactRequests";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useState } from "preact/hooks";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { contactDisplayName, type ContactInviteCreateResult, type ContactPreferencesUpdateArgs, type ContactSummary } from "@humansandmachines/gsv/protocol";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { RelationshipPreferences, type ContactPreferenceControls } from "./RelationshipPreferences";
import { FleetDialog } from "../fleet/FleetDialog";
import { ConversationSearch } from "../shared/ConversationSearch";
import { canConfigure } from "../settings/settingsModel";
import { SetupCommand } from "../shared/SetupCommand";
import { INSTRUMENT_CONTACTS_KEY as CONTACTS_KEY, INSTRUMENT_CONTACT_INVITES_KEY as INVITES_KEY } from "../wire/queryKeys";

export function useContacts(account: ConsoleAccount | undefined) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: CONTACTS_KEY,
    enabled: connected && !!account && canConfigure(account, "contact.list"),
    queryFn: () => client.contact.list({ includeRevoked: true }),
  });
}

export function AddContact({ account, onClose, onAdded }: {
  account: ConsoleAccount | undefined;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const active = useViewActive();
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
    if (!active || !Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [active, deadline]);
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
        {currentInvite?.state === "accepted" ? <p class="note is-on" role="status">Invitation accepted.</p>
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

export function ContactAttentionNotice({ account }: { account: ConsoleAccount | undefined }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => client.contact.notice.dismiss({}),
    onSuccess: () => cache.invalidateQueries({ queryKey: CONTACTS_KEY }),
  });
  return <aside class="people-note" aria-label="Contact handling changed">
    <p>Accepting a contact no longer starts Ship. Choose “hand to Ship” in a conversation to hand it over.</p>
    <button class="people-action" disabled={!connected || !account || !canConfigure(account, "contact.notice.dismiss") || dismiss.isPending} onClick={() => dismiss.mutate()}>dismiss</button>
    {dismiss.error && <p class="people-error" role="alert">{dismiss.error.message}</p>}
  </aside>;
}

export function ContactInspector({ contact, account, draft, onDraft, onSend, onRetry, onObserved }: ContactComposerProps & { contact: ContactSummary; account: ConsoleAccount | undefined }) {
  const active = useViewActive();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const name = contactDisplayName(contact);
  const alias = aliasDraft ?? name;
  const nameChanged = aliasDraft !== null && alias.trim() !== name;
  const maySearch = !!account && canConfigure(account, "conversation.history") && canConfigure(account, "conversation.search");
  const mayRename = connected && contact.state === "active" && !!account
    && (account.uid === 0 || account.uid === contact.ownerUid) && canConfigure(account, "contact.alias.set");
  const preferences = contact.preferences;
  const updatePreferences = useMutation({
    mutationFn: (patch: ContactPreferencesUpdateArgs["patch"]) => {
      if (!preferences) throw new Error("Refresh this contact before changing its preferences");
      return client.contact.preferences.update({ contactId: contact.id, expectedRevision: preferences.revision, patch });
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: CONTACTS_KEY }),
  });
  const controls: ContactPreferenceControls = {
    update: (patch) => updatePreferences.mutate(patch), pending: updatePreferences.isPending, error: updatePreferences.error,
    canEdit: connected && !!account && account.uid >= 1000 && account.uid === contact.ownerUid && canConfigure(account, "contact.preferences.update"),
  };
  const save = useMutation({
    mutationFn: (value: string) => client.contact.alias.set({ contactId: contact.id, alias: value || null }),
    onSuccess: () => { setAliasDraft(null); },
  });
  useEffect(() => {
    if (!active || !maySearch || detailsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, maySearch, detailsOpen]);

  return <section class="people-contact" aria-label={`Conversation with ${name}`}>
    <header class="people-conversation-header">
      <div><h1>{name}</h1>
        {contact.state !== "active" ? <p class="people-conversation-state">Connection ended</p>
          : preferences && <div class="people-handling">
            {preferences.shipHandlesMessages && <span class="people-handling-state" role="status">Ship handling</span>}
            <button class="people-action" disabled={!controls.canEdit || controls.pending || contact.blocked} title={preferences.shipHandlesMessages ? "Stop ongoing Ship handling" : "Let Ship follow and reply to this conversation"} onClick={() => controls.update({ shipHandlesMessages: !preferences.shipHandlesMessages })}>
              {controls.pending && updatePreferences.variables?.shipHandlesMessages !== undefined ? <LoadingState>{updatePreferences.variables.shipHandlesMessages ? "handing over…" : "taking back…"}</LoadingState> : preferences.shipHandlesMessages ? "take back" : "hand to Ship"}
            </button>
          </div>}
        {!detailsOpen && controls.error && <p class="people-error" role="alert">{controls.error.message}</p>}
      </div>
      <div class="people-header-actions">
        {maySearch && <button class="people-action" disabled={!connected} onClick={() => setSearchOpen(true)}>search</button>}
        <button class="people-action" onClick={() => setDetailsOpen(true)}>details</button>
      </div>
    </header>
    <ContactConversation key={contact.id} contact={contact} account={account} draft={draft} onDraft={onDraft} onSend={onSend} onRetry={onRetry} onObserved={onObserved} />
    {active && searchOpen && <ConversationSearch conversationId={contact.conversationId} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone} onClose={() => setSearchOpen(false)} />}
    <FleetDialog open={active && detailsOpen} title={name} onClose={() => setDetailsOpen(false)}>
      <div class="people-contact-details">
        <p class="people-contact-origin">{new URL(contact.remoteOrigin).host}</p>
        <form class="people-name-field" onSubmit={(event) => { event.preventDefault(); if (mayRename && nameChanged && !save.isPending) save.mutate(alias.trim()); }}>
          <label>Name<input value={alias} placeholder={contact.remoteSubject.displayName} disabled={!mayRename || save.isPending} onInput={(event) => setAliasDraft(event.currentTarget.value)} /></label>
          {nameChanged && <button type="submit" class="people-action" disabled={!mayRename || save.isPending}>{save.isPending ? "saving…" : "save"}</button>}
        </form>
        {save.error && <p class="people-error" role="alert">{save.error.message}</p>}
        <RelationshipPreferences contact={contact} account={account} controls={controls} />
        <details class="people-details-fold" onToggle={(event) => setRequestsOpen(event.currentTarget.open)}>
          <summary>Work requests</summary>
          {requestsOpen && <ContactRequests contact={contact} account={account} />}
        </details>
      </div>
    </FleetDialog>
  </section>;
}
