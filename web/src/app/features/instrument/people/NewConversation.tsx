import type { ApproachCreateArgs, ApproachSummary, ContactSummary } from "@humansandmachines/gsv/protocol";
import { useMutation } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { LoadingState } from "../../../components/ui/Spinner";
import { Checkbox } from "../../../components/ui/Checkbox";
import { approachSendIntent, handleLabel, type ApproachDraft } from "./peopleModel";
import { ContactHandlingChoice } from "./ContactHandlingChoice";
import { submitOnEnter } from "../shared/enterToSend";
import { useT } from "../../../i18n/locale";

/** The person a draft names and the message request to them, once their profile is open. */
export function NewConversation({ account, draft, onChange, onSent, onBusy, contacts, onOpen }: {
  account: ConsoleAccount | undefined;
  draft: ApproachDraft;
  onChange: (value: ApproachDraft) => void;
  onSent: (request: ApproachSummary) => void;
  onBusy: (busy: boolean) => void;
  contacts: ContactSummary[];
  onOpen: (contactId: string) => void;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const displayName = draft.displayName ?? (account?.displayName || account?.gecos || account?.username || "");
  const send = useMutation({
    mutationFn: (intent: ApproachCreateArgs) => client.approach.create(intent),
    onSuccess: ({ approach }) => onSent(approach),
  });
  const busy = send.isPending;
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const profile = draft.profile;
  if (!profile) return null;
  const existing = contacts.find((contact) => contact.state === "active" && contact.remoteDid === profile.did);
  const canSend = connected && !!account && canConfigure(account, "approach.create");
  /* a request's text counts UTF-16 code units, as its textarea's maxLength does */
  const tooLong = draft.text.trim().length > 32_768;
  const valid = !!displayName.trim() && !!draft.text.trim() && !tooLong && draft.shipHandlesMessages !== null;

  return <section class="people-compose" aria-label={t("people.compose.label")}>
    <div class="people-profile-preview">
      <span class="people-kicker">{handleLabel(profile.handle)}</span>
      <h2>{profile.displayName}</h2>{profile.about && <p>{profile.about}</p>}
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
        <label>{t("people.compose.message")}<textarea value={draft.text} rows={5} maxLength={32_768} disabled={busy} onInput={(event) => onChange({ ...draft, text: event.currentTarget.value })}
          onKeyDown={submitOnEnter} /></label>
        {tooLong && <p class="people-error" role="alert">{t("people.composer.tooLong")}</p>}
        <p class="people-note">{t("people.compose.afterAccept")}</p>
        <Checkbox label={t("people.compose.saveContact")} checked={draft.saveContact} disabled={busy} onChange={(saveContact) => onChange({ ...draft, saveContact })} />
        <ContactHandlingChoice value={draft.shipHandlesMessages} disabled={busy || !account || !canConfigure(account, "contact.preferences.update")} onChange={(shipHandlesMessages) => onChange({ ...draft, shipHandlesMessages })} />
        <button class="ibtn is-primary" type="submit" disabled={!canSend || busy || !valid}>{send.isPending ? <LoadingState>{t("people.compose.sending")}</LoadingState> : t("people.compose.send")}</button>
      </form>}
    {account && !canConfigure(account, "approach.create") && <p class="people-note">{t("people.compose.noSend")}</p>}
    {send.error && <p class="people-error" role="alert">{send.error.message}</p>}
    {!connected && <p class="people-note" role="status">{t("people.composer.reconnecting")}</p>}
  </section>;
}
