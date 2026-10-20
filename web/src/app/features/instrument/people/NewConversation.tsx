import { contactDisplayName, type ApproachCreateArgs, type ApproachSummary, type ContactSummary } from "@humansandmachines/gsv/protocol";
import { useMutation } from "@tanstack/preact-query";
import { useEffect, useRef } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { LoadingState } from "../../../components/ui/Spinner";
import { approachSendIntent, profileAddress as resolveProfileAddress, profileAddressLabel, type ApproachDraft } from "./peopleModel";
import { ContactHandlingChoice } from "./ContactHandlingChoice";
import { useT } from "../../../i18n/locale";

export function NewConversation({ account, draft, onChange, onSent, onBusy, contacts, onOpen, onInvitation }: {
  account: ConsoleAccount | undefined;
  draft: ApproachDraft;
  onChange: (value: ApproachDraft) => void;
  onSent: (request: ApproachSummary) => void;
  onBusy: (busy: boolean) => void;
  contacts: ContactSummary[];
  onOpen: (contactId: string) => void;
  onInvitation?: () => void;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const active = useViewActive();
  const profileAddress = resolveProfileAddress(draft.url);
  const latest = useRef(draft);
  latest.current = draft;
  const displayName = draft.displayName ?? (account?.displayName || account?.gecos || account?.username || "");
  const saved = contacts.filter((contact) => contact.state === "active" && contact.preferences?.saved !== false
    && `${contactDisplayName(contact)} ${contact.remoteOrigin}`.toLocaleLowerCase().includes(draft.url.trim().replace(/^@/, "").toLocaleLowerCase()))
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

  return <section class="people-compose" aria-label={t("people.compose.label")}>
    <form class="people-form" onSubmit={(event) => {
      event.preventDefault();
      if (canResolve && profileAddress && !busy) resolve.mutate(profileAddress);
    }}>
      <label>{t("people.compose.to")}<input value={draft.url} placeholder={t("people.compose.toPlaceholder")} spellcheck={false} autoCapitalize="none" autoComplete="off" disabled={busy} onInput={(event) => {
        resolve.reset(); send.reset(); onChange({ ...draft, url: event.currentTarget.value, profile: null, shipHandlesMessages: null });
      }} /></label>
      {profileAddress && <button class="people-action" type="submit" disabled={!canResolve || busy}>{resolve.isPending ? <LoadingState>{t("people.compose.openingProfile")}</LoadingState> : t("people.compose.openProfile")}</button>}
    </form>
    {!profile && <>
      {saved.length > 0 ? <ul class="people-recipient-list" aria-label={t("people.compose.saved")}>{saved.map((contact) => <li key={contact.id}>
        <button class="people-recipient" disabled={busy} onClick={() => onOpen(contact.id)}><span>{contactDisplayName(contact)}</span><small>{profileAddressLabel(contact.remoteOrigin)}</small></button>
      </li>)}</ul> : draft.url.trim() && !profileAddress && <p class="people-note">{t("people.compose.noMatch")}</p>}
    </>}
    {profile && <>
      <div class="people-profile-preview">
        <span class="people-kicker">{profileAddressLabel(profile.origin)}</span>
        <h2>{profile.displayName}</h2>{profile.about && <p>{profile.about}</p>}
        {profile.representation === "human-and-ship" && <p class="people-note">{t("people.compose.mayReply")}</p>}
      </div>
      {existing ? <button class="ibtn is-primary" onClick={() => onOpen(existing.id)}>{t("people.compose.openExisting")}</button>
        : profile.contactPolicy !== "requests" ? <p class="people-note">{t(profile.contactPolicy === "invitation" ? "people.compose.byInvitation" : "people.compose.closed")}</p>
        : <form class="people-form" onSubmit={(event) => {
          event.preventDefault();
          if (!canSend || !valid || busy) return;
          const intent = approachSendIntent({ ...draft, displayName });
          onChange({ ...draft, intent }); send.mutate(intent);
        }}>
          <label>{t("people.compose.displayName")}<input value={displayName} maxLength={80} autoComplete="off" disabled={busy} onInput={(event) => onChange({ ...draft, displayName: event.currentTarget.value })} /></label>
          <label>{t("people.compose.message")}<textarea value={draft.text} rows={5} maxLength={32_768} disabled={busy} onInput={(event) => onChange({ ...draft, text: event.currentTarget.value })} /></label>
          {bytes > 32_768 && <p class="people-error" role="alert">{t("people.composer.tooLong")}</p>}
          <p class="people-note">{t("people.compose.afterAccept")}</p>
          <ContactHandlingChoice value={draft.shipHandlesMessages} disabled={busy || !account || !canConfigure(account, "contact.preferences.update")} onChange={(shipHandlesMessages) => onChange({ ...draft, shipHandlesMessages })} />
          <button class="ibtn is-primary" type="submit" disabled={!canSend || busy || !valid}>{send.isPending ? <LoadingState>{t("people.compose.sending")}</LoadingState> : t("people.compose.send")}</button>
        </form>}
    </>}
    {account && !canConfigure(account, "approach.create") && <p class="people-note">{t("people.compose.noSend")}</p>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {!connected && <p class="people-note" role="status">{t("people.composer.reconnecting")}</p>}
    {onInvitation && <div class="people-compose-footer"><button class="people-action" disabled={busy} onClick={onInvitation}>{t("people.compose.useInvitation")}</button></div>}
  </section>;
}
