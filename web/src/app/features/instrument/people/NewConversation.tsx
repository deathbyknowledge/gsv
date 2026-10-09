import { contactDisplayName, type ApproachCreateArgs, type ApproachSummary, type ContactSummary } from "@humansandmachines/gsv/protocol";
import { useMutation } from "@tanstack/preact-query";
import { useEffect, useRef } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { LoadingState } from "../../../components/ui/Spinner";
import { approachSendIntent, profileAddress as resolveProfileAddress, type ApproachDraft } from "./peopleModel";
import { ContactHandlingChoice } from "./ContactHandlingChoice";

export function NewConversation({ account, draft, onChange, onSent, onBusy, contacts, onOpen, onInvitation }: {
  account: ConsoleAccount | undefined;
  draft: ApproachDraft;
  onChange: (value: ApproachDraft) => void;
  onSent: (request: ApproachSummary) => void;
  onBusy: (busy: boolean) => void;
  contacts: ContactSummary[];
  onOpen: (contactId: string) => void;
  onInvitation: () => void;
}) {
  const { client, connected } = useGateway();
  const active = useViewActive();
  const profileAddress = resolveProfileAddress(draft.url);
  const latest = useRef(draft);
  latest.current = draft;
  const displayName = draft.displayName ?? (account?.displayName || account?.gecos || account?.username || "");
  const saved = contacts.filter((contact) => contact.state === "active" && contact.preferences?.saved !== false
    && `${contactDisplayName(contact)} ${contact.remoteOrigin}`.toLocaleLowerCase().includes(draft.url.trim().toLocaleLowerCase()))
    .sort((a, b) => contactDisplayName(a).localeCompare(contactDisplayName(b)));
  const resolve = useMutation({
    mutationFn: (url: string) => client.profile.resolve({ url }),
    onSuccess: ({ profile }) => onChange({ ...latest.current, profile, url: profile.url }),
  });
  const send = useMutation({
    mutationFn: (intent: ApproachCreateArgs) => client.approach.create(intent),
    onSuccess: ({ approach }) => onSent(approach),
  });
  const initial = useRef(false);
  useEffect(() => {
    if (initial.current || !active || !connected || !account) return;
    initial.current = true;
    if (profileAddress && !draft.profile && canConfigure(account, "profile.resolve")) resolve.mutate(profileAddress);
  }, [active, connected, account]);
  const busy = resolve.isPending || send.isPending;
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const profile = draft.profile;
  const existing = profile ? contacts.find((contact) => contact.state === "active" && contact.remoteShipId === profile.actor.shipId && contact.remoteSubject.id === profile.actor.subjectId) : undefined;
  const canResolve = connected && !!account && canConfigure(account, "profile.resolve");
  const canSend = connected && !!account && canConfigure(account, "approach.create");
  const bytes = new TextEncoder().encode(draft.text.trim()).length;
  const valid = !!displayName.trim() && !!draft.text.trim() && bytes <= 32_768 && draft.shipHandlesMessages !== null;
  const error = resolve.error ?? send.error;

  return <section class="people-compose" aria-label="New conversation">
    <form class="people-form" onSubmit={(event) => {
      event.preventDefault();
      if (canResolve && profileAddress && !busy) resolve.mutate(profileAddress);
    }}>
      <label>To<input value={draft.url} placeholder="Name or profile address" spellcheck={false} autoComplete="off" disabled={busy} onInput={(event) => {
        resolve.reset(); send.reset(); onChange({ ...draft, url: event.currentTarget.value, profile: null, shipHandlesMessages: null });
      }} /></label>
      {profileAddress && <button class="people-action" type="submit" disabled={!canResolve || busy}>{resolve.isPending ? <LoadingState>opening profile…</LoadingState> : "open profile"}</button>}
    </form>
    {!profile && !profileAddress && <>
      {saved.length > 0 ? <ul class="people-recipient-list" aria-label="Saved contacts">{saved.map((contact) => <li key={contact.id}>
        <button class="people-recipient" disabled={busy} onClick={() => onOpen(contact.id)}><span>{contactDisplayName(contact)}</span><small>{new URL(contact.remoteOrigin).host}</small></button>
      </li>)}</ul> : draft.url.trim() && <p class="people-note">No saved contact matches. Paste their profile address to reach someone new.</p>}
    </>}
    {profile && <>
      <div class="people-profile-preview">
        <span class="people-kicker">@{profile.alias} · {new URL(profile.origin).host}</span>
        <h2>{profile.displayName}</h2>{profile.about && <p>{profile.about}</p>}
        {profile.representation === "human-and-ship" && <p class="people-note">May reply through their Ship.</p>}
      </div>
      {existing ? <button class="ibtn is-primary" onClick={() => onOpen(existing.id)}>open your conversation</button>
        : profile.contactPolicy !== "requests" ? <p class="people-note">{profile.contactPolicy === "invitation" ? "This person connects by private invitation." : "This person is not receiving new message requests."}</p>
        : <form class="people-form" onSubmit={(event) => {
          event.preventDefault();
          if (!canSend || !valid || busy) return;
          const intent = approachSendIntent({ ...draft, displayName });
          onChange({ ...draft, intent }); send.mutate(intent);
        }}>
          <label>Your display name<input value={displayName} maxLength={80} autoComplete="off" disabled={busy} onInput={(event) => onChange({ ...draft, displayName: event.currentTarget.value })} /></label>
          <label>Message<textarea value={draft.text} rows={5} maxLength={32_768} disabled={busy} onInput={(event) => onChange({ ...draft, text: event.currentTarget.value })} /></label>
          {bytes > 32_768 && <p class="people-error" role="alert">This message is too long. Shorten it before sending.</p>}
          <p class="people-note">You can send more messages and attachments once they accept.</p>
          <ContactHandlingChoice value={draft.shipHandlesMessages} disabled={busy || !account || !canConfigure(account, "contact.preferences.update")} onChange={(shipHandlesMessages) => onChange({ ...draft, shipHandlesMessages })} />
          <button class="ibtn is-primary" type="submit" disabled={!canSend || busy || !valid}>{send.isPending ? <LoadingState>sending request…</LoadingState> : "send message request"}</button>
        </form>}
    </>}
    {account && !canConfigure(account, "approach.create") && <p class="people-note">This account can review profiles but cannot send message requests.</p>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {!connected && <p class="people-note" role="status">Reconnecting… Your draft is kept here.</p>}
    <div class="people-compose-footer"><button class="people-action" disabled={busy} onClick={onInvitation}>use a private invitation</button></div>
  </section>;
}
