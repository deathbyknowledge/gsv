import type { ContactPreferencesUpdateArgs, ContactSummary } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACTS_KEY } from "../wire/queryKeys";
import { ConversationViewControls } from "./ConversationViewControls";
import { useT } from "../../../i18n/locale";

export type ContactPreferenceControls = {
  update: (patch: ContactPreferencesUpdateArgs["patch"]) => void;
  pending: boolean;
  canEdit: boolean;
  error: Error | null;
};

export function RelationshipPreferences({ contact, account, controls }: { contact: ContactSummary; account: ConsoleAccount | undefined; controls: ContactPreferenceControls }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [confirm, setConfirm] = useState<"block" | "end" | null>(null);
  const allowed = (syscall: string) => connected && !!account && account.uid >= 1000 && account.uid === contact.ownerUid && canConfigure(account, syscall);
  const mayEnd = connected && contact.state === "active" && !!account
    && (account.uid === 0 || account.uid === contact.ownerUid) && canConfigure(account, "contact.revoke");
  const refresh = () => cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY });
  const preferences = contact.preferences;
  const block = useMutation({
    mutationFn: () => client.contact.block.set({ actor: { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }, blocked: !contact.blocked }),
    onSuccess: async () => { setConfirm(null); await refresh(); },
  });
  const revoke = useMutation({
    mutationFn: () => client.contact.revoke({ contactId: contact.id }),
    onSuccess: async () => { setConfirm(null); await refresh(); },
  });
  const pending = controls.pending || block.isPending || revoke.isPending;
  const disabled = pending || !controls.canEdit;
  const error = controls.error ?? block.error ?? revoke.error;

  return <section class="people-relationship" aria-label={t("people.prefs.label")}>
    {preferences && <div class="people-settings">
      <label class="people-setting"><span>{t("people.prefs.mute")}<small>{t("people.prefs.muteHint")}</small></span><input type="checkbox" role="switch" checked={preferences.muted} disabled={disabled} onChange={(event) => controls.update({ muted: event.currentTarget.checked })} /></label>
    </div>}
    <div class="people-contact-actions">
      {preferences && <button class="people-action" disabled={disabled} onClick={() => controls.update({ saved: !preferences.saved })}>{t(preferences.saved ? "people.prefs.unsave" : "people.prefs.save")}</button>}
      <ConversationViewControls conversationId={contact.conversationId} account={account} />
    </div>
    <details class="people-details-fold">
      <summary>{t("people.connection.title")}</summary>
      <dl class="people-connection-facts"><dt>{t("people.connection.since")}</dt><dd>{new Date(contact.createdAtMs).toLocaleDateString()}</dd><dt>{t("people.connection.status")}</dt><dd>{t(contact.blocked ? "people.contactBlocked" : contact.state === "active" ? "people.connection.active" : "people.connection.ended")}</dd></dl>
      {confirm ? <div class="people-confirm">
        <p>{t(confirm === "end" ? "people.connection.confirmEnd"
          : contact.blocked ? "people.connection.confirmUnblock"
            : "people.connection.confirmBlock")}</p>
        <div class="people-actions">
          <button class="people-action is-danger" disabled={pending || !(confirm === "end" ? mayEnd : allowed("contact.block.set"))} onClick={() => confirm === "end" ? revoke.mutate() : block.mutate()}>{t(confirm === "end" ? "people.connection.end" : contact.blocked ? "people.unblock" : "people.block")}</button>
          <button class="people-action" disabled={pending} onClick={() => setConfirm(null)}>{t("common.cancel")}</button>
        </div>
      </div> : <div class="people-actions">
        {contact.state === "active" && <button class="people-action is-danger" disabled={pending || !mayEnd} onClick={() => setConfirm("end")}>{t("people.connection.end")}</button>}
        <button class="people-action is-danger" disabled={pending || !allowed("contact.block.set")} onClick={() => setConfirm("block")}>{t(contact.blocked ? "people.connection.unblockPerson" : "people.connection.blockPerson")}</button>
      </div>}
    </details>
    {error && <p class="people-error" role="alert">{error.message}</p>}
  </section>;
}
