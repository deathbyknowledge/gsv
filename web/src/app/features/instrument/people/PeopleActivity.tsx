import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { canConfigure } from "../settings/settingsModel";
import { useDismissOnOutsideClick } from "../shared/useDismissOnOutsideClick";
import { ContactNoticePanel, ContactReplyBox, EMPTY_REPLY, preview } from "../zen/ContactNotice";
import type { ContactReplies } from "./useContactReplies";
import { useContactHistory } from "./useContactHistory";
import type { PeopleActivity as Activity } from "./usePeopleActivity";
import type { PeopleOpenRequest } from "./People";
import { conversationNotice, peopleConversations, type PeopleConversationItem } from "./peopleActivityModel";
import { useT } from "../../../i18n/locale";

export function PeopleActivity({ activity, replies, account, onOpen }: {
  activity: Activity; replies: ContactReplies; account: ConsoleAccount | undefined;
  onOpen: (request?: PeopleOpenRequest) => void;
}) {
  const t = useT();
  const conversations = peopleConversations(activity, replies.drafts);
  /* the contact whose reply box is open under its notice */
  const [selected, setSelected] = useState<{ contactId: string } | null>(null);
  const root = useRef<HTMLElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setSelected(null), []);
  const current = conversations.find((item) => item.contactId === selected?.contactId);
  useEffect(() => { if (selected && !current) setSelected(null); }, [selected, current]);
  useDismissOnOutsideClick(!!current, () => [root.current], close);
  if (!conversations.length && !activity.requests.length && !activity.error && !replies.readError) return null;
  return <aside class="zen-people" ref={root} aria-label={t("people.activity.label")} onKeyDown={(event) => {
    if (event.key === "Escape" && selected) { event.preventDefault(); event.stopPropagation(); close(); opener.current?.focus(); }
  }}>
    {current && <PeopleConversation key={current.contactId} item={current} replies={replies} account={account}
      onAnswered={() => setSelected((active) => active === selected ? null : active)}
      onClose={() => { close(); opener.current?.focus(); }} onOpen={() => { close(); onOpen({ contactId: current.contactId }); }} />}
    <button class="zen-people-title" onClick={() => onOpen()}>{t("people.activity.title")} <span>{conversations.length + activity.requests.length}{activity.hasMore ? "+" : ""}</span></button>
    <div class="zen-people-items">
      {activity.requests.map((request) => <button key={request.id} class="zen-people-item" onClick={() => onOpen({ requestId: request.id })}>
        <span class="zen-people-name">{request.displayName}</span><small>{t(request.connection === "failed" ? "people.activity.retryConnection" : "people.activity.wantsToConnect")}</small><span aria-hidden="true">↗</span>
      </button>)}
      {conversations.map((item) => <button key={item.contactId} class={`zen-people-item${selected?.contactId === item.contactId ? " is-open" : ""}`}
        aria-label={t(item.draft ? "people.activity.continueReply" : "people.activity.readFrom", { name: item.name })}
        aria-expanded={selected?.contactId === item.contactId} aria-controls={selected?.contactId === item.contactId ? "zen-people-conversation" : undefined} onClick={(event) => {
          opener.current = event.currentTarget; setSelected(selected?.contactId === item.contactId ? null : { contactId: item.contactId });
        }}>
        <span class="zen-people-name">{item.name}</span>{item.draft && <span class="zen-people-draft">{t("people.activity.draft")}</span>}
        <small>{preview(item.text, item.attachmentCount)}</small><span class="zen-people-toggle" aria-hidden="true">{selected?.contactId === item.contactId ? "−" : "+"}</span>
      </button>)}
      {activity.error && <span class="zen-people-error" role="status">{t("people.activity.refreshFailed")} <button onClick={() => onOpen()}>{t("people.activity.open")}</button></span>}
      {replies.readError && <span class="zen-people-error" role="alert">{t("people.activity.readFailed", { error: replies.readError.message })} <button onClick={() => { replies.dismissReadError(); onOpen(); }}>{t("people.activity.open")}</button></span>}
    </div>
  </aside>;
}

function PeopleConversation({ item, replies, account, onClose, onOpen, onAnswered }: {
  item: PeopleConversationItem; replies: ContactReplies; account: ConsoleAccount | undefined;
  onClose: () => void; onOpen: () => void; onAnswered: () => void;
}) {
  const t = useT();
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);
  const mayRead = !!account && canConfigure(account, "conversation.history");
  const history = useContactHistory(item.conversationId, mayRead);
  const recent = history.data?.pages[0];
  const notice = conversationNotice(item, recent?.messages ?? []);
  const draft = { ...(replies.drafts.get(item.contactId) ?? EMPTY_REPLY), readThroughSequence: item.readThroughSequence };
  return <ContactNoticePanel id="zen-people-conversation" panelRef={panel} name={item.name} notice={notice} onClose={onClose} onGoToChat={onOpen}>
    {history.isPending && !notice ? <LoadingState variant="panel">{t("people.conversation.loading")}</LoadingState>
      : notice ? <ContactReplyBox notice={notice} contact={item.contact} account={account} draft={draft}
        onDraft={(next) => replies.setDraft(item.contactId, next)} onSent={(through, intent) => {
          replies.markRead(item.conversationId, through);
          replies.clearSentDraft(item.contactId, intent); onAnswered();
        }} /> : <p class="zen-people-note">{t("people.activity.openToReply")}</p>}
    {history.error && <p class="zen-people-error" role="alert">{t("people.activity.loadFailed")} <button onClick={() => void history.refetch()}>{t("people.retry")}</button></p>}
    {recent?.hasMore && <p class="zen-people-note">{t("people.activity.recentOnly")}</p>}
  </ContactNoticePanel>;
}
