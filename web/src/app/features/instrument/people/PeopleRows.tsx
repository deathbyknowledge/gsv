import { contactDisplayName, type ApproachSummary, type ContactSummary, type ConversationInboxEntry } from "@humansandmachines/gsv/protocol";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useT } from "../../../i18n/locale";
import { approachStatus, inboxPreview } from "./peopleModel";
import { SaveContactTag } from "./SaveContactTag";

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A person with a conversation, as the People lists and search show them. */
export function ContactRow({ contact, entry, dated, selected, busy, account, onOpen }: {
  contact: ContactSummary; entry?: ConversationInboxEntry; dated: boolean; selected: boolean; busy: boolean;
  account: ConsoleAccount | undefined; onOpen: () => void;
}) {
  const t = useT();
  const unsaved = dated && contact.preferences?.saved === false && contact.state === "active" && !contact.blocked;
  return <li class={unsaved ? "has-tag" : undefined}><button class={`people-row${selected ? " is-selected" : ""}${entry?.unread ? " is-unread" : ""}`} disabled={busy} aria-current={selected ? "true" : undefined} onClick={onOpen}><span class="people-row-name">{contactDisplayName(contact)}{entry?.unread && <span class="people-unread" aria-label={t("people.inbox.unread")} />}</span>{dated && <time>{shortDate(entry?.conversation.updatedAt ?? contact.updatedAtMs)}</time>}<span class="people-row-preview">{inboxPreview(contact, entry)}</span></button>
    {unsaved && <SaveContactTag contact={contact} account={account} disabled={busy} />}</li>;
}

/** A message request, received or sent, with where it stands. */
export function RequestRow({ request, selected, busy, shipTakenDown, onOpen }: {
  request: ApproachSummary; selected: boolean; busy: boolean; shipTakenDown: boolean; onOpen: () => void;
}) {
  const t = useT();
  return <li><button class={`people-row${selected ? " is-selected" : ""}`} disabled={busy} aria-current={selected ? "true" : undefined} onClick={onOpen}><span class="people-row-name">{request.displayName}</span><time>{shortDate(request.createdAtMs)}</time><span class="people-row-preview">{t(approachStatus(request, shipTakenDown))}</span></button></li>;
}
