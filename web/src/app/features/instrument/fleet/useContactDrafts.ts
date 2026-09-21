import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ContactSummary, OriginMessageRef } from "@humansandmachines/gsv/protocol";
import { contactSendMessageId } from "@humansandmachines/gsv/protocol/stable-id";
import { sendContactMessage, retryContactMessage } from "../../../services/contacts/contactsService";
import { selectContactSendIntent, type ContactDraftSendIntent } from "../../../services/contacts/contactSendIntent";
import type { ZenAttachment } from "../zen/zenAttachments";

export type ContactReply = { reference: OriginMessageRef; author: string; preview: string };
export type PendingContactMessage = {
  intent: ContactDraftSendIntent<ZenAttachment>;
  reply: ContactReply | null;
  generation: string;
  messageId: string | null;
  deliveryId: string | null;
  state: "sending" | "queued" | "delivered" | "failed" | "unconfirmed";
  error: string | null;
  createdAt: number;
  attachmentCount: number;
  retryable: boolean;
};

export type ContactDraft = {
  reply: ContactReply | null;
  sent: readonly PendingContactMessage[];
  text: string;
  media: readonly ZenAttachment[];
  intent: ContactDraftSendIntent<ZenAttachment> | null;
  pending: boolean;
  error: string | null;
  status: string | null;
};
export const EMPTY_CONTACT_DRAFT: ContactDraft = { text: "", media: [], reply: null, sent: [], intent: null, pending: false, error: null, status: null };

/** Fleet owns drafts and uploads so selecting another row does not discard either. */
export function useContactDrafts(onDirtyChange?: (dirty: boolean) => void) {
  const { client } = useGateway();
  const [drafts, setDrafts] = useState(new Map<string, ContactDraft>());
  const current = useRef(drafts);
  const uploads = useRef(new Map<string, AbortController>());
  const update = useCallback((id: string, change: Partial<ContactDraft>) => {
    const next = new Map(current.current);
    next.set(id, { ...(next.get(id) ?? EMPTY_CONTACT_DRAFT), ...change });
    current.current = next;
    setDrafts(next);
  }, []);
  const dirty = [...drafts.values()].some((draft) => draft.pending || draft.text.length > 0 || draft.media.length > 0 || draft.sent.some((entry) => entry.state === "unconfirmed" || entry.state === "failed" && entry.intent.media.length > 0));
  useLayoutEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useLayoutEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const owned = uploads.current;
    return () => { for (const controller of owned.values()) controller.abort(); owned.clear(); };
  }, []);

  const changeSent = useCallback((contactId: string, id: string, change: Partial<PendingContactMessage>) => {
    const draft = current.current.get(contactId) ?? EMPTY_CONTACT_DRAFT;
    const sent = draft.sent.map((entry) => entry.intent.idempotencyKey === id ? { ...entry, ...change } : entry);
    update(contactId, { sent, pending: sent.some((entry) => entry.state === "sending") });
  }, [update]);

  const send = useCallback(async (contact: ContactSummary, retryId?: string) => {
    const draft = current.current.get(contact.id) ?? EMPTY_CONTACT_DRAFT;
    const previous = retryId ? draft.sent.find((entry) => entry.intent.idempotencyKey === retryId) : undefined;
    if (retryId && !previous) return;
    if (!previous && (!draft.text.trim() && !draft.media.length)) return;
    if (draft.sent.filter((entry) => entry.state === "sending").length >= 3) return;
    if (previous && previous.generation !== contact.generation) {
      changeSent(contact.id, previous.intent.idempotencyKey, { state: "failed", retryable: false, error: "This connection changed. Review the message before sending it through the new connection." });
      return;
    }
    const intent = previous?.intent ?? selectContactSendIntent(draft.intent, contact.id, draft.text, draft.media, draft.reply?.reference);
    if (uploads.current.has(intent.idempotencyKey)) return;
    const entry: PendingContactMessage = previous ?? { intent, reply: draft.reply, generation: contact.generation, messageId: null, deliveryId: null, state: "sending", error: null, createdAt: Date.now(), attachmentCount: intent.media.length, retryable: true };
    const controller = new AbortController();
    uploads.current.set(intent.idempotencyKey, controller);
    if (previous) changeSent(contact.id, intent.idempotencyKey, { state: "sending", error: null });
    else update(contact.id, { text: "", media: [], reply: null, intent: null, sent: [...draft.sent, entry], pending: true, error: null, status: null });
    try {
      const messageId = await contactSendMessageId(contact.id, contact.generation, intent.idempotencyKey);
      if (controller.signal.aborted) return;
      changeSent(contact.id, intent.idempotencyKey, { messageId });
      const status = previous?.deliveryId ? (await client.contact.delivery.get({ deliveryId: previous.deliveryId })).delivery : null;
      if (controller.signal.aborted) return;
      if (previous?.deliveryId && !status) throw new Error("The delivery receipt is no longer available. Check the conversation before composing another message.");
      const result = status?.state === "failed"
        ? await retryContactMessage(client, intent, status, controller.signal)
        : status ? { deliveryId: status.deliveryId, conversationId: status.conversationId, state: status.state }
          : await sendContactMessage(client, contact.id, intent, controller.signal);
      if (controller.signal.aborted) return;
      const failed = result.state === "failed" ? (await client.contact.delivery.get({ deliveryId: result.deliveryId })).delivery : null;
      changeSent(contact.id, intent.idempotencyKey, { deliveryId: result.deliveryId, state: result.state, retryable: failed?.retryable ?? result.state !== "failed",
        intent: result.state === "failed" ? intent : { ...intent, media: [] },
        error: result.state === "failed" ? "Delivery could not be confirmed. Review the delivery state before retrying." : null });
    } catch (error) {
      if (!controller.signal.aborted) changeSent(contact.id, intent.idempotencyKey, { state: "unconfirmed", error: error instanceof Error ? error.message : "Could not confirm the send." });
    } finally {
      if (uploads.current.get(intent.idempotencyKey) === controller) uploads.current.delete(intent.idempotencyKey);
    }
  }, [client, update, changeSent]);

  const observed = useCallback((id: string, messageIds: readonly string[]) => {
    const draft = current.current.get(id);
    if (!draft) return;
    const ids = new Set(messageIds);
    const sent = draft.sent.filter((entry) => !entry.messageId || !ids.has(entry.messageId) || uploads.current.has(entry.intent.idempotencyKey));
    if (sent.length !== draft.sent.length) update(id, { sent });
  }, [update]);
  return { drafts, update, send, observed };
}
