import { ContactConversation, type ContactComposerProps } from "./ContactConversation";
import { ContactRequests } from "./ContactRequests";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useState } from "preact/hooks";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { contactDisplayName, type ContactPreferencesUpdateArgs, type ContactSummary } from "@humansandmachines/gsv/protocol";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { RelationshipPreferences, type ContactPreferenceControls } from "./RelationshipPreferences";
import { FleetDialog } from "../fleet/FleetDialog";
import { ConversationSearch } from "../shared/ConversationSearch";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACTS_KEY as CONTACTS_KEY } from "../wire/queryKeys";
import { PEOPLE_IDEAS } from "./PeopleWelcome";

export function useContacts(account: ConsoleAccount | undefined) {
  const { client, connected } = useGateway();
  return useQuery({
    queryKey: CONTACTS_KEY,
    enabled: connected && !!account && canConfigure(account, "contact.list"),
    queryFn: () => client.contact.list({ includeRevoked: true }),
  });
}

export function ContactAttentionNotice({ account }: { account: ConsoleAccount | undefined }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => client.contact.notice.dismiss({}),
    onSuccess: () => cache.invalidateQueries({ queryKey: CONTACTS_KEY }),
  });
  return <aside class="people-note" aria-label="Contact handling changed">
    <p>Your existing conversations stay under your control. Enable “Automatically handle new messages” in a conversation to let Ship respond for you.</p>
    <button class="people-action" disabled={!connected || !account || !canConfigure(account, "contact.notice.dismiss") || dismiss.isPending} onClick={() => dismiss.mutate()}>dismiss</button>
    {dismiss.error && <p class="people-error" role="alert">{dismiss.error.message}</p>}
  </aside>;
}

export function ContactInspector({ contact, account, draft, onDraft, onSend, onRetry, onObserved, onAsk, idea }: ContactComposerProps & {
  contact: ContactSummary; account: ConsoleAccount | undefined; onAsk: (task: string) => void; idea: number | null;
}) {
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
          : preferences && <label class="people-handling" title="Let Ship read and respond to new messages. Replies to tasks you assign can still reach Ship when this is off.">
            <input type="checkbox" role="switch" aria-label="Automatically handle new messages" checked={(updatePreferences.isPending ? updatePreferences.variables?.shipHandlesMessages : undefined) ?? preferences.shipHandlesMessages} disabled={!controls.canEdit || controls.pending || contact.blocked} onChange={(event) => controls.update({ shipHandlesMessages: event.currentTarget.checked })} />
            <span>Automatically handle new messages</span>
            {controls.pending && updatePreferences.variables?.shipHandlesMessages !== undefined && <LoadingState>saving…</LoadingState>}
          </label>}
        {!detailsOpen && controls.error && <p class="people-error" role="alert">{controls.error.message}</p>}
      </div>
      <div class="people-header-actions">
        {contact.state === "active" && !contact.blocked && <button class="people-action is-accent" disabled={!connected || !account || !canConfigure(account, "conversation.send")} onClick={() => onAsk("Read my conversation with {name} and help me decide what to do next.")}>ask Ship</button>}
        {maySearch && <button class="people-action" disabled={!connected} onClick={() => setSearchOpen(true)}>search</button>}
        <button class="people-action" onClick={() => setDetailsOpen(true)}>details</button>
      </div>
    </header>
    {idea !== null && contact.state === "active" && !contact.blocked && <aside class="people-next-step"><span>You’re connected.</span><button class="people-action" disabled={!connected || !account || !canConfigure(account, "conversation.send")} onClick={() => onAsk(PEOPLE_IDEAS[idea].action)}>{PEOPLE_IDEAS[idea].title.toLocaleLowerCase()} with Ship →</button></aside>}
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
