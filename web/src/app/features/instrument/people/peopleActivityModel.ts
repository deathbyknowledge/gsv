import { contactDisplayName, type ContactSummary, type ConversationInboxEntry, type ConversationMessage } from "@humansandmachines/gsv/protocol";
import { latestOf, type ContactNotice, type ContactNoticeMessage } from "../zen/useContactNotices";
import type { ContactReplyDraft } from "../zen/ContactNotice";
import type { PeopleActivity } from "./usePeopleActivity";
import { messagePreviewPrefix } from "./peopleModel";

export type PeopleConversationItem = {
  contactId: string;
  conversationId: string;
  name: string;
  contact: ContactSummary | undefined;
  entry: ConversationInboxEntry | undefined;
  notice: ContactNotice | undefined;
  draft: boolean;
  text: string;
  attachmentCount: number;
};

/** One reachable entry per person, including a draft held after its unread messages were cleared. */
export function peopleConversations(activity: PeopleActivity, notices: readonly ContactNotice[], drafts: ReadonlyMap<string, ContactReplyDraft>): PeopleConversationItem[] {
  const contacts = new Map(activity.contacts.map((contact) => [contact.id, contact]));
  const inbox = new Map(activity.conversations.map((entry) => [entry.contactId, entry]));
  const live = new Map(notices.map((notice) => [notice.contactId, notice]));
  const ids = new Set([...inbox.keys(), ...live.keys(), ...drafts.keys()]);
  return [...ids].flatMap((contactId) => {
    const contact = contacts.get(contactId);
    const entry = inbox.get(contactId);
    const notice = live.get(contactId);
    const latest = notice && latestOf(notice);
    const draft = drafts.get(contactId)?.text.trim() ?? "";
    const quiet = contact && (contact.state !== "active" || contact.blocked || contact.preferences?.muted);
    const answered = notice?.replied && latest && (!entry || entry.latestIncomingSequence <= latest.sequence);
    const waiting = !quiet && !answered && (!!entry || !!notice && !notice.replied);
    const conversationId = contact?.conversationId ?? entry?.conversation.id ?? notice?.conversationId;
    if (!conversationId || !waiting && !draft) return [];
    const preview = latest && (!entry?.preview || latest.sequence >= entry.preview.sequence) ? latest : null;
    const prefix = preview ? (preview.byShip ? "Their Ship: " : "") : entry?.preview ? messagePreviewPrefix(entry.preview) : "";
    return [{ contactId, conversationId, contact, entry, notice, draft: !!draft,
      name: contact ? contactDisplayName(contact) : notice?.displayName ?? entry?.conversation.title ?? "New message",
      text: draft || `${prefix}${preview?.text ?? entry?.preview?.text ?? ""}`,
      attachmentCount: preview?.media.length ?? entry?.preview?.attachmentCount ?? 0 }];
  });
}

/** Recover the same reply references from history as from a live committed-message signal. */
export function conversationNotice(item: PeopleConversationItem, history: readonly ConversationMessage[]): ContactNotice | null {
  const messages = new Map<string, ContactNoticeMessage>();
  for (const message of history) {
    if (message.author.kind !== "contact" || !message.social) continue;
    if (item.entry && message.sequence <= item.entry.view.readThroughSequence && !item.draft) continue;
    messages.set(message.id, { messageId: message.id, sequence: message.sequence, text: message.text,
      createdAt: message.createdAt, byShip: message.social.provenance.kind === "process",
      reference: message.social.reference, media: message.media ?? [] });
  }
  for (const message of item.notice?.messages ?? []) {
    if (!item.notice?.replied || item.draft) messages.set(message.messageId, message);
  }
  if (!messages.size) return null;
  return { contactId: item.contactId, conversationId: item.conversationId, displayName: item.name,
    messages: [...messages.values()].sort((a, b) => a.sequence - b.sequence), replied: false };
}
