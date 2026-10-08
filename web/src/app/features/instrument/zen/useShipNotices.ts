import { useCallback, useMemo, useState } from "preact/hooks";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { canConfigure } from "../settings/settingsModel";
import type { ContactReplyDraft } from "./ContactNotice";
import { useContactNotices, type ContactNotice } from "./useContactNotices";

export type ShipNotices = {
  notices: ContactNotice[];
  markReplied: (contactId: string, through: number) => void;
  /** what the person typed under each notice, kept while its box is closed */
  drafts: ReadonlyMap<string, ContactReplyDraft>;
  setDraft: (contactId: string, draft: ContactReplyDraft | null) => void;
  markRead: (notice: ContactNotice, through: number) => void;
  /** typed text is waiting under a notice: unsaved work */
  dirty: boolean;
};

const NO_NOTICES: ContactNotice[] = [];

/**
 * Ship's contact notices and the replies typed under them. Owned above the keyed Zen view, so
 * opening a helper and coming back loses nothing. Listening starts with the connection; what
 * the person may see is settled once their account is known.
 */
export function useShipNotices({ viewer, listening }: { viewer: ConsoleAccount | undefined; listening: boolean }): ShipNotices {
  const { client } = useGateway();
  const human = !!viewer && viewer.uid >= 1000;
  const may = (syscall: string) => human && canConfigure(viewer!, syscall);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ContactReplyDraft>>(() => new Map());
  const setDraft = useCallback((contactId: string, draft: ContactReplyDraft | null) => setDrafts((current) => {
    const next = new Map(current);
    if (draft) next.set(contactId, draft); else next.delete(contactId);
    return next;
  }), []);
  /* a notice that still holds typed text stays, with that text and its send intent, until the person sends or clears it */
  const holding = useMemo(() => new Set([...drafts].filter(([, draft]) => draft.text.trim() !== "").map(([contactId]) => contactId)), [drafts]);
  const { notices, markReplied } = useContactNotices({ listening, holding, mayReadView: may("conversation.view.get") });
  const markRead = (notice: ContactNotice, through: number) => {
    if (!may("conversation.view.update")) return;
    /* a failed read mark changes nothing the person can see; the notice still clears when they act on it */
    void client.conversation.view.update({ conversationId: notice.conversationId, readThroughSequence: through }).catch(() => undefined);
  };
  const dirty = [...drafts.values()].some((draft) => draft.text.trim() !== "");
  return { notices: may("contact.list") ? notices : NO_NOTICES, markReplied, drafts, setDraft, markRead, dirty };
}
