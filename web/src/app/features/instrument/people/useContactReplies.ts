import { useCallback, useState } from "preact/hooks";
import { useMutation } from "@tanstack/preact-query";
import type { ConversationViewUpdateArgs } from "@humansandmachines/gsv/protocol";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { canConfigure } from "../settings/settingsModel";
import type { ContactReplyDraft } from "../zen/ContactNotice";

export type ContactReplies = ReturnType<typeof useContactReplies>;

/** Drafts live above the keyed Zen view; messages and unread state stay in the shared query cache. */
export function useContactReplies(viewer: ConsoleAccount | undefined) {
  const { client } = useGateway();
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ContactReplyDraft>>(() => new Map());
  const setDraft = useCallback((contactId: string, draft: ContactReplyDraft | null) => setDrafts((current) => {
    const next = new Map(current);
    if (draft) next.set(contactId, draft); else next.delete(contactId);
    return next;
  }), []);
  const clearSentDraft = useCallback((contactId: string, intent: NonNullable<ContactReplyDraft["intent"]>) => setDrafts((current) => {
    const draft = current.get(contactId);
    if (draft?.intent?.idempotencyKey !== intent.idempotencyKey || draft.text.trim() !== intent.text) return current;
    const next = new Map(current);
    next.delete(contactId);
    return next;
  }), []);
  const read = useMutation({ mutationFn: (args: ConversationViewUpdateArgs) => client.conversation.view.update(args) });
  const markRead = (conversationId: string, through: number) => {
    if (viewer && viewer.uid >= 1000 && canConfigure(viewer, "conversation.view.update")) {
      read.mutate({ conversationId, readThroughSequence: through });
    }
  };
  const dirty = [...drafts.values()].some((draft) => draft.text.trim() !== "");
  return { drafts, setDraft, clearSentDraft, markRead, readError: read.error, dismissReadError: read.reset, dirty };
}
