import type { ContactPreferencesUpdateArgs, ContactSummary } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACTS_KEY } from "../wire/queryKeys";

export function RelationshipPreferences({ contact, account }: { contact: ContactSummary; account: ConsoleAccount | undefined }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const allowed = (syscall: string) => connected && !!account && account.uid >= 1000 && account.uid === contact.ownerUid && canConfigure(account, syscall);
  const preferences = contact.preferences;
  const update = useMutation({
    mutationFn: (patch: ContactPreferencesUpdateArgs["patch"]) => {
      if (!preferences) throw new Error("Refresh this contact before changing its preferences");
      return client.contact.preferences.update({ contactId: contact.id, expectedRevision: preferences.revision, patch });
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY }),
  });
  const block = useMutation({
    mutationFn: () => client.contact.block.set({ actor: { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }, blocked: !contact.blocked }),
    onSuccess: async () => { setConfirm(false); await cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY }); },
  });
  const pending = update.isPending || block.isPending;
  const disabled = pending || !allowed("contact.preferences.update");
  return <section class="people-relationship" aria-label="Private relationship preferences">
    <h4>In your space</h4>
    {preferences && <>
      <label class="people-setting"><input type="checkbox" checked={preferences.saved} disabled={disabled} onChange={(event) => update.mutate({ saved: event.currentTarget.checked })} /><span>Save in contacts<small>Your private address book. Removing it keeps this conversation.</small></span></label>
      <label class="people-setting"><input type="checkbox" checked={preferences.muted} disabled={disabled} onChange={(event) => update.mutate({ muted: event.currentTarget.checked })} /><span>Mute this conversation<small>Keep messages quietly. New messages won’t bring an archived conversation back.</small></span></label>
      <label class="people-notifications">Message notifications<select disabled={disabled || preferences.muted} value={preferences.notifications} onChange={(event) => update.mutate({ notifications: event.currentTarget.value as "notify" | "digest" | "quiet" })}><option value="notify">Notify me</option><option value="digest">Include in my digest</option><option value="quiet">Quiet</option></select></label>
      <p class="note">These preferences are private. They do not give your Ship permission to reply.</p>
    </>}
    <div class="people-block-control">
      {confirm ? <>
        <p class="note">{contact.blocked ? "Unblock this identity? It may request a new conversation. The old connection stays ended." : "Block this identity? This ends the connection and refuses new messages and requests from it. Previously delivered messages cannot be recalled."}</p>
        <div class="fleet-actions"><button class="fleet-text-action is-danger" disabled={pending || !allowed("contact.block.set")} onClick={() => block.mutate()}>{contact.blocked ? "confirm unblock" : "confirm block"}</button><button class="fleet-text-action" disabled={pending} onClick={() => setConfirm(false)}>cancel</button></div>
      </> : <button class="fleet-text-action is-danger" disabled={pending || !allowed("contact.block.set")} onClick={() => setConfirm(true)}>{contact.blocked ? "unblock this person" : "block this person"}</button>}
    </div>
    {(update.error ?? block.error) && <p class="error" role="alert">{(update.error ?? block.error)?.message}</p>}
  </section>;
}
