import type { ContactPreferencesUpdateArgs, ContactSummary } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACTS_KEY } from "../wire/queryKeys";
import { ConversationViewControls } from "./ConversationViewControls";

export type ContactPreferenceControls = {
  update: (patch: ContactPreferencesUpdateArgs["patch"]) => void;
  pending: boolean;
  canEdit: boolean;
  error: Error | null;
};

export function RelationshipPreferences({ contact, account, controls }: { contact: ContactSummary; account: ConsoleAccount | undefined; controls: ContactPreferenceControls }) {
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

  return <section class="people-relationship" aria-label="Conversation preferences">
    {preferences && <div class="people-settings">
      <p class="people-note">“Automatically handle new messages” lets Ship read and respond for you. When it’s off, replies to tasks you assign can still reach Ship until the task is finished.</p>
      <label class="people-setting"><span>Mute conversation<small>New messages won’t bring an archived conversation back.</small></span><input type="checkbox" role="switch" checked={preferences.muted} disabled={disabled} onChange={(event) => controls.update({ muted: event.currentTarget.checked })} /></label>
    </div>}
    <div class="people-contact-actions">
      {preferences && <button class="people-action" disabled={disabled} onClick={() => controls.update({ saved: !preferences.saved })}>{preferences.saved ? "remove from contacts" : "save contact"}</button>}
      <ConversationViewControls conversationId={contact.conversationId} account={account} />
    </div>
    <details class="people-details-fold">
      <summary>Connection</summary>
      <dl class="people-connection-facts"><dt>Connected</dt><dd>{new Date(contact.createdAtMs).toLocaleDateString()}</dd><dt>Status</dt><dd>{contact.blocked ? "Blocked" : contact.state === "active" ? "Connected" : "Ended"}</dd></dl>
      {confirm ? <div class="people-confirm">
        <p>{confirm === "end" ? "End this connection? Messages and sharing will stop."
          : contact.blocked ? "Allow new requests from this person? The old connection stays ended."
            : "End this connection and block future messages and requests? Delivered messages will stay in history."}</p>
        <div class="people-actions">
          <button class="people-action is-danger" disabled={pending || !(confirm === "end" ? mayEnd : allowed("contact.block.set"))} onClick={() => confirm === "end" ? revoke.mutate() : block.mutate()}>{confirm === "end" ? "end connection" : contact.blocked ? "unblock" : "block"}</button>
          <button class="people-action" disabled={pending} onClick={() => setConfirm(null)}>cancel</button>
        </div>
      </div> : <div class="people-actions">
        {contact.state === "active" && <button class="people-action is-danger" disabled={pending || !mayEnd} onClick={() => setConfirm("end")}>end connection</button>}
        <button class="people-action is-danger" disabled={pending || !allowed("contact.block.set")} onClick={() => setConfirm("block")}>{contact.blocked ? "unblock person" : "block person"}</button>
      </div>}
    </details>
    {error && <p class="people-error" role="alert">{error.message}</p>}
  </section>;
}
