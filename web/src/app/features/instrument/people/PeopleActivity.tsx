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

export function PeopleActivity({ activity, replies, account, onOpen }: {
  activity: Activity; replies: ContactReplies; account: ConsoleAccount | undefined;
  onOpen: (request?: PeopleOpenRequest) => void;
}) {
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
  return <aside class="zen-people" ref={root} aria-label="People waiting for you" onKeyDown={(event) => {
    if (event.key === "Escape" && selected) { event.preventDefault(); event.stopPropagation(); close(); opener.current?.focus(); }
  }}>
    {current && <PeopleConversation key={current.contactId} item={current} replies={replies} account={account}
      onAnswered={() => setSelected((active) => active === selected ? null : active)}
      onClose={() => { close(); opener.current?.focus(); }} onOpen={() => { close(); onOpen({ contactId: current.contactId }); }} />}
    <button class="zen-people-title" onClick={() => onOpen()}>people <span>{conversations.length + activity.requests.length}{activity.hasMore ? "+" : ""}</span></button>
    <div class="zen-people-items">
      {activity.requests.map((request) => <button key={request.id} class="zen-people-item" onClick={() => onOpen({ requestId: request.id })}>
        <span class="zen-people-name">{request.displayName}</span><small>{request.connection === "failed" ? "retry connection" : "wants to connect"}</small><span aria-hidden="true">↗</span>
      </button>)}
      {conversations.map((item) => <button key={item.contactId} class={`zen-people-item${selected?.contactId === item.contactId ? " is-open" : ""}`}
        aria-label={`${item.draft ? "Continue reply to" : "Read messages from"} ${item.name}`}
        aria-expanded={selected?.contactId === item.contactId} aria-controls={selected?.contactId === item.contactId ? "zen-people-conversation" : undefined} onClick={(event) => {
          opener.current = event.currentTarget; setSelected(selected?.contactId === item.contactId ? null : { contactId: item.contactId });
        }}>
        <span class="zen-people-name">{item.name}</span>{item.draft && <span class="zen-people-draft">draft</span>}
        <small>{preview(item.text, item.attachmentCount)}</small><span class="zen-people-toggle" aria-hidden="true">{selected?.contactId === item.contactId ? "−" : "+"}</span>
      </button>)}
      {activity.error && <span class="zen-people-error" role="status">Couldn’t refresh People. <button onClick={() => onOpen()}>open People</button></span>}
      {replies.readError && <span class="zen-people-error" role="alert">Reply sent, but couldn’t mark the conversation read: {replies.readError.message} <button onClick={() => { replies.dismissReadError(); onOpen(); }}>open People</button></span>}
    </div>
  </aside>;
}

function PeopleConversation({ item, replies, account, onClose, onOpen, onAnswered }: {
  item: PeopleConversationItem; replies: ContactReplies; account: ConsoleAccount | undefined;
  onClose: () => void; onOpen: () => void; onAnswered: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);
  const mayRead = !!account && canConfigure(account, "conversation.history");
  const history = useContactHistory(item.conversationId, mayRead);
  const recent = history.data?.pages[0];
  const notice = conversationNotice(item, recent?.messages ?? []);
  const draft = { ...(replies.drafts.get(item.contactId) ?? EMPTY_REPLY), readThroughSequence: item.readThroughSequence };
  return <ContactNoticePanel id="zen-people-conversation" panelRef={panel} name={item.name} notice={notice} onClose={onClose} onGoToChat={onOpen}>
    {history.isPending && !notice ? <LoadingState variant="panel">Loading messages…</LoadingState>
      : notice ? <ContactReplyBox notice={notice} contact={item.contact} account={account} draft={draft}
        onDraft={(next) => replies.setDraft(item.contactId, next)} onSent={(through, intent) => {
          replies.markRead(item.conversationId, through);
          replies.clearSentDraft(item.contactId, intent); onAnswered();
        }} /> : <p class="zen-people-note">Open the conversation to read and reply.</p>}
    {history.error && <p class="zen-people-error" role="alert">Couldn’t load messages. <button onClick={() => void history.refetch()}>retry</button></p>}
    {recent?.hasMore && <p class="zen-people-note">Showing recent messages. Open the conversation for the full history.</p>}
  </ContactNoticePanel>;
}
