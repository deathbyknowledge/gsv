import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { sendContactMessage } from "../../../services/contacts/contactsService";
import { selectContactSendIntent, type ContactDraftSendIntent } from "../../../services/contacts/contactSendIntent";
import type { ZenAttachment } from "../zen/zenAttachments";

export type ContactDraft = {
  text: string;
  media: readonly ZenAttachment[];
  intent: ContactDraftSendIntent<ZenAttachment> | null;
  pending: boolean;
  error: string | null;
  status: string | null;
};
export const EMPTY_CONTACT_DRAFT: ContactDraft = { text: "", media: [], intent: null, pending: false, error: null, status: null };

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
  const dirty = [...drafts.values()].some((draft) => draft.pending || draft.text.length > 0 || draft.media.length > 0);
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

  const send = useCallback(async (id: string) => {
    const draft = current.current.get(id) ?? EMPTY_CONTACT_DRAFT;
    if (uploads.current.has(id) || (!draft.text.trim() && !draft.media.length)) return;
    const intent = selectContactSendIntent(draft.intent, id, draft.text, draft.media);
    const controller = new AbortController();
    uploads.current.set(id, controller);
    update(id, { intent, pending: true, error: null, status: null });
    try {
      const result = await sendContactMessage(client, id, intent, controller.signal);
      if (controller.signal.aborted) return;
      if (result.state === "failed") throw new Error("Delivery failed. Your message is kept here; retry when the contact is available.");
      update(id, { text: "", media: [], intent: null, pending: false, status: result.state === "delivered" ? "delivered" : "accepted for delivery" });
    } catch (error) {
      if (!controller.signal.aborted) update(id, { pending: false, error: error instanceof Error ? error.message : "Could not send the message." });
    } finally {
      if (uploads.current.get(id) === controller) uploads.current.delete(id);
    }
  }, [client, update]);
  return { drafts, update, send };
}
