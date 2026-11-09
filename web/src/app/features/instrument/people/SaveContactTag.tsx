import { contactDisplayName, type ContactSummary } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACTS_KEY } from "../wire/queryKeys";
import { useT } from "../../../i18n/locale";

/** "not a contact" on a conversation with someone you never saved; it turns into the action that saves them. */
export function SaveContactTag({ contact, account, disabled }: { contact: ContactSummary; account: ConsoleAccount | undefined; disabled: boolean }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const save = useMutation({
    mutationFn: () => client.contact.preferences.update({ contactId: contact.id, expectedRevision: contact.preferences!.revision, patch: { saved: true } }),
    onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY }),
  });
  const allowed = connected && !!account && account.uid === contact.ownerUid && canConfigure(account, "contact.preferences.update");
  return <button class="people-contact-tag" disabled={disabled || !allowed || save.isPending} aria-label={t("people.contact.addContactLabel", { name: contactDisplayName(contact) })} title={save.error?.message} onClick={() => save.mutate()}>
    <span class="people-contact-tag-state">{t("people.contact.notContact")}</span><span class="people-contact-tag-action">{t("people.contact.addContact")}</span>
  </button>;
}
