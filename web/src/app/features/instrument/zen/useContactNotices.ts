import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { committedMessageSchema } from "../shared/committedMessageSignal";

export type ContactNoticeMessage = {
  messageId: string;
  sequence: number;
  text: string;
  createdAt: number;
  /** the contact's GSV wrote it rather than the person */
  byShip: boolean;
  reference: { actor: { shipId: string; subjectId: string }; messageId: string };
  /** attachments as the message carried them; ZenMedia reads the shape */
  media: readonly unknown[];
};

export type ContactNotice = {
  contactId: string;
  conversationId: string;
  /** the name the peer sent; the caller swaps in the local alias when there is one */
  displayName: string;
  /** what is waiting, oldest first; a reply from the notice closes the batch and the next message starts a new one */
  messages: ContactNoticeMessage[];
  /** the person answered this batch from the notice itself */
  replied: boolean;
};

/** The newest message in a notice; a notice always holds at least one. */
export function latestOf(notice: ContactNotice): ContactNoticeMessage {
  return notice.messages[notice.messages.length - 1];
}

const changedSchema = z.object({ conversationId: z.string(), latestSequence: z.number(), viewOnly: z.boolean().optional() });

/**
 * Live notices for contact messages that land while the person is in the Ship chat: one per
 * contact, holding every message waiting there. Only the Kernel's `notify` call counts, so
 * muted, blocked and ended contacts stay quiet. Request-state lines and v1 peers carry no
 * social metadata and are skipped. Nothing is seeded from history, and nothing is collected
 * while the chat is behind another view: a notice exists only for messages that arrived while
 * the person was here. A notice the person replied to stays, marked as answered, until that
 * contact writes again; messages that arrived during the send stay unanswered.
 */
export function useContactNotices({ enabled, listening, mayReadView }: { enabled: boolean; listening: boolean; mayReadView: boolean }) {
  const { client, connected } = useGateway();
  const [notices, setNotices] = useState<ContactNotice[]>([]);
  const held = useRef(notices);
  held.current = notices;
  /* read at signal time, so a view change neither resubscribes nor drops the read-tracking below */
  const hearing = useRef(listening);
  hearing.current = listening;
  const seen = useRef(new Set<string>());

  const markReplied = useCallback((contactId: string, throughSequence: number) => {
    setNotices((current) => current.map((notice) => {
      if (notice.contactId !== contactId) return notice;
      const later = notice.messages.filter((message) => message.sequence > throughSequence);
      return later.length > 0 ? { ...notice, messages: later, replied: false } : { ...notice, replied: true };
    }));
  }, []);

  useEffect(() => {
    if (!connected || !enabled) return;
    return client.onSignal((signal, payload) => {
      if (signal === "message.committed") {
        if (!hearing.current) return;
        const committed = committedMessageSchema.safeParse(payload);
        if (!committed.success) return;
        const { message, attention } = committed.data;
        if (message.author.kind !== "contact" || attention !== "notify" || !message.social) return;
        if (seen.current.has(message.id)) return;
        seen.current.add(message.id);
        const author = message.author;
        const arrived: ContactNoticeMessage = {
          messageId: message.id, sequence: message.sequence, text: message.text, createdAt: message.createdAt,
          byShip: message.social.provenance.kind === "process", reference: message.social.reference, media: message.media ?? [],
        };
        setNotices((current) => {
          const existing = current.find((notice) => notice.contactId === author.contactId);
          const next: ContactNotice = {
            contactId: author.contactId,
            conversationId: message.conversationId,
            displayName: author.displayName,
            /* a message after a reply starts a new batch */
            messages: existing && !existing.replied ? [...existing.messages, arrived] : [arrived],
            replied: false,
          };
          return [...current.filter((notice) => notice.contactId !== author.contactId), next];
        });
        return;
      }
      if (signal === "conversation.changed") {
        const changed = changedSchema.safeParse(payload);
        if (!changed.success || !changed.data.viewOnly || !mayReadView) return;
        const { conversationId } = changed.data;
        if (!held.current.some((notice) => notice.conversationId === conversationId && !notice.replied)) return;
        /* reading the conversation elsewhere clears an unanswered notice once the read covers its newest message;
           an answered one stays as the record of the reply. A failed read keeps the notice either way. */
        void client.conversation.view.get({ conversationId }).then(({ entry }) => {
          setNotices((current) => current.filter((notice) => notice.conversationId !== conversationId || notice.replied || entry.view.readThroughSequence < latestOf(notice).sequence));
        }).catch(() => undefined);
      }
    });
  }, [client, connected, enabled, mayReadView]);

  return { notices, markReplied };
}
