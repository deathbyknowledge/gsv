import { contactDisplayName, type ContactSummary, type ConversationMessage } from "@humansandmachines/gsv/protocol";
import type { ContactNotice, ContactNoticeMessage, ContactReplyDraft } from "../zen/ContactNotice";
import type { PeopleActivity } from "./usePeopleActivity";
import { messagePreviewPrefix } from "./peopleModel";

export type PeopleConversationItem = {
  contactId: string;
  conversationId: string;
  name: string;
  contact: ContactSummary | undefined;
  draft: boolean;
  readThroughSequence: number;
  text: string;
  attachmentCount: number;
};

/** One reachable entry per person, including a draft held after its unread messages were cleared. */
export function peopleConversations(activity: PeopleActivity, drafts: ReadonlyMap<string, ContactReplyDraft>): PeopleConversationItem[] {
  const contacts = new Map(activity.contacts.map((contact) => [contact.id, contact]));
  const inbox = new Map(activity.conversations.map((entry) => [entry.contactId, entry]));
  const ids = new Set([...inbox.keys(), ...drafts.keys()]);
  return [...ids].flatMap((contactId) => {
    const contact = contacts.get(contactId);
    const entry = inbox.get(contactId);
    const held = drafts.get(contactId);
    const draft = held?.text.trim() ?? "";
    const quiet = contact && (contact.state !== "active" || contact.blocked || contact.preferences?.muted);
    const waiting = !quiet && !!entry?.unread;
    const conversationId = contact?.conversationId ?? entry?.conversation.id;
    if (!conversationId || !waiting && !draft) return [];
    const prefix = entry?.preview ? messagePreviewPrefix(entry.preview) : "";
    return [{ contactId, conversationId, contact, draft: !!draft,
      readThroughSequence: draft && held ? held.readThroughSequence : entry?.view.readThroughSequence ?? 0,
      name: contact ? contactDisplayName(contact) : entry?.conversation.title ?? "New message",
      text: draft || `${prefix}${entry?.preview?.text ?? ""}`,
      attachmentCount: entry?.preview?.attachmentCount ?? 0 }];
  });
}

/** Recover the same reply references from history as from a live committed-message signal. */
export function conversationNotice(item: PeopleConversationItem, history: readonly ConversationMessage[]): ContactNotice | null {
  const messages = history.filter((message): message is ContactNoticeMessage => message.author.kind === "contact" && !!message.social
    && message.sequence > item.readThroughSequence);
  if (!messages.length) return null;
  return { contactId: item.contactId, conversationId: item.conversationId, displayName: item.name,
    messages };
}
