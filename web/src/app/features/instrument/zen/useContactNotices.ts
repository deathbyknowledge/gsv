import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { committedMessageSchema } from "../shared/committedMessageSignal";

export type ContactNotice = {
  contactId: string;
  conversationId: string;
  /** the name the peer sent; the caller swaps in the local alias when there is one */
  displayName: string;
  messageId: string;
  sequence: number;
  text: string;
  createdAt: number;
  /** the contact's GSV wrote it rather than the person */
  byShip: boolean;
  reference: { actor: { shipId: string; subjectId: string }; messageId: string };
  /** messages from this contact since the notice appeared */
  count: number;
};

const changedSchema = z.object({ conversationId: z.string(), latestSequence: z.number(), viewOnly: z.boolean().optional() });

/**
 * Live notices for contact messages that land while the person is in the Ship chat: one per
 * contact, holding the latest message and how many arrived. Only the Kernel's `notify` call
 * counts, so muted, blocked and ended contacts stay quiet. Request-state lines and v1 peers
 * carry no social metadata and are skipped. Nothing is seeded from history: a notice exists
 * only for the session in which its message arrived, as the tab signal does.
 */
export function useContactNotices({ enabled, mayReadView }: { enabled: boolean; mayReadView: boolean }) {
  const { client, connected } = useGateway();
  const [notices, setNotices] = useState<ContactNotice[]>([]);
  const held = useRef(notices);
  held.current = notices;
  const seen = useRef(new Set<string>());

  const dismiss = useCallback((contactId: string) => {
    setNotices((current) => current.filter((notice) => notice.contactId !== contactId));
  }, []);

  useEffect(() => {
    if (!connected || !enabled) return;
    return client.onSignal((signal, payload) => {
      if (signal === "message.committed") {
        const committed = committedMessageSchema.safeParse(payload);
        if (!committed.success) return;
        const { message, attention } = committed.data;
        if (message.author.kind !== "contact" || attention !== "notify" || !message.social) return;
        if (seen.current.has(message.id)) return;
        seen.current.add(message.id);
        const author = message.author;
        const social = message.social;
        setNotices((current) => {
          const existing = current.find((notice) => notice.contactId === author.contactId);
          const next: ContactNotice = {
            contactId: author.contactId,
            conversationId: message.conversationId,
            displayName: author.displayName,
            messageId: message.id,
            sequence: message.sequence,
            text: message.text,
            createdAt: message.createdAt,
            byShip: social.provenance.kind === "process",
            reference: social.reference,
            count: (existing?.count ?? 0) + 1,
          };
          return [...current.filter((notice) => notice.contactId !== author.contactId), next];
        });
        return;
      }
      if (signal === "conversation.changed") {
        const changed = changedSchema.safeParse(payload);
        if (!changed.success || !changed.data.viewOnly || !mayReadView) return;
        const { conversationId } = changed.data;
        if (!held.current.some((notice) => notice.conversationId === conversationId)) return;
        /* reading the conversation elsewhere clears the notice once the read covers the message it holds;
           a failed read keeps the notice, which the person can still act on */
        void client.conversation.view.get({ conversationId }).then(({ entry }) => {
          setNotices((current) => current.filter((notice) => notice.conversationId !== conversationId || entry.view.readThroughSequence < notice.sequence));
        }).catch(() => undefined);
      }
    });
  }, [client, connected, enabled, mayReadView]);

  return { notices, dismiss };
}
