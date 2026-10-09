import { contactDisplayName, type ContactSummary, type ConversationMessage } from "@humansandmachines/gsv/protocol";
import type { ComponentChildren, JSX, RefObject } from "preact";
import { useState } from "preact/hooks";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { selectContactSendIntent, type ContactDraftSendIntent } from "../../../services/contacts/contactSendIntent";
import { sendContactMessage } from "../../../services/contacts/contactsService";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { StagedResourceUpload } from "../../../services/gateway/stagedResources";
import { canConfigure } from "../settings/settingsModel";
import { ZenMedia } from "./ZenMedia";
import "../shared/senderBadge.css";

/* the same ceiling the People composer applies */
const MAX_REPLY_BYTES = 32_768;
/* how much of the newest message the notice line shows */
const PREVIEW_WORDS = 8;
type ReplyMedia = StagedResourceUpload & { id: string };
/* replies from a notice are text only; attachments belong to the full chat */
const NO_MEDIA: readonly ReplyMedia[] = [];

export type ContactNoticeMessage = ConversationMessage & { social: NonNullable<ConversationMessage["social"]> };
export type ContactNotice = {
  contactId: string;
  conversationId: string;
  displayName: string;
  messages: ContactNoticeMessage[];
};

type ReplyIntent = ContactDraftSendIntent<ReplyMedia> & {
  /** The sequence of the message a reply answers; the newest when the reference is no longer held. */
  // The submitted intent now retains that sequence even after the message leaves the recent history page.
  throughSequence: number;
};

/** What the person typed under a notice, and the send it last became, so a retry reuses its key. */
export type ContactReplyDraft = { text: string; intent: ReplyIntent | null; readThroughSequence: number };
export const EMPTY_REPLY: ContactReplyDraft = { text: "", intent: null, readThroughSequence: 0 };

/**
 * The send a reply becomes. A retry of the same text keeps the intent it was submitted with —
 * its key and the message it answers — even if the contact wrote again meanwhile, so an
 * uncertain send cannot land twice. New text is a new message, answering the newest one.
 */
export function replyIntentFor(previous: ReplyIntent | null, notice: ContactNotice, body: string): ReplyIntent {
  if (previous && previous.contactId === notice.contactId && previous.text === body) return previous;
  const latest = notice.messages[notice.messages.length - 1];
  return { ...selectContactSendIntent(null, notice.contactId, body, NO_MEDIA, latest.social.reference), throughSequence: latest.sequence };
}

/** The local alias when the person set one, else the name the peer sent. */
export function noticeName(notice: ContactNotice, contact: ContactSummary | undefined): string {
  return contact ? contactDisplayName(contact) : notice.displayName;
}

/** The first words of a message, clipped; one with no text is named by what it carries. */
export function preview(text: string, attachments = 0): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return attachments === 0 ? "(an empty message)" : attachments === 1 ? "(an attachment)" : `(${attachments} attachments)`;
  return words.length > PREVIEW_WORDS ? `${words.slice(0, PREVIEW_WORDS).join(" ")}…` : words.join(" ");
}

/* inline markup rather than a component, so the badge reads in the moment's own tree */
function senderBadge(byShip: boolean) {
  return <span class="sender-badge">{byShip && <span class="sender-dot" />}{byShip ? "GSV" : "PERSON"}</span>;
}

/**
 * A contact wrote while the person was here: their name and badge the way any sender shows,
 * the start of the newest message, and what to do about it. The opened messages and reply box
 * render as children between the line and the actions.
 */
export function ContactNoticePanel({ id, name, notice, panelRef, onClose, onGoToChat, children }: {
  id: string;
  name: string;
  notice: ContactNotice | null;
  panelRef?: RefObject<HTMLElement>;
  /** the messages are showing, so the show action steps aside */
  onClose: () => void;
  onGoToChat: () => void;
  children?: ComponentChildren;
}) {
  const latest = notice?.messages.at(-1);
  return (
    <section id={id} ref={panelRef} tabIndex={-1} class="zen-people-panel" aria-label={`Messages from ${name}`}>
      <header class="zen-people-heading"><span>{name}{latest && senderBadge(latest.social.provenance.kind === "process")}</span>
        <button type="button" class="fleet-text-action" onClick={onClose}>close</button></header>
      {children}
      <footer class="zen-people-foot"><span>{notice ? `${notice.messages.length} message${notice.messages.length === 1 ? "" : "s"}` : ""}</span>
        <button type="button" class="fleet-text-action" onClick={onGoToChat}>open conversation <span aria-hidden="true">↗</span></button></footer>
    </section>
  );
}

/**
 * The waiting messages in full and a reply box, inline under the notice. Sending threads the
 * reply to the newest message. The draft lives with the caller so it survives the box closing;
 * a retry of the same text reuses its idempotency key, so an uncertain send never doubles up.
 */
export function ContactReplyBox({ notice, contact, account, draft, onDraft, onSent }: {
  notice: ContactNotice;
  contact: ContactSummary | undefined;
  account: ConsoleAccount | undefined;
  draft: ContactReplyDraft;
  onDraft: (draft: ContactReplyDraft) => void;
  /** the reply went out, answering the batch through this sequence */
  onSent: (through: number, intent: NonNullable<ContactReplyDraft["intent"]>) => void;
}) {
  const { client, connected } = useGateway();
  const [state, setState] = useState<"idle" | "sending" | "undelivered" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const name = noticeName(notice, contact);
  const maySend = connected && !!account && !!contact && contact.state === "active" && !contact.blocked
    && canConfigure(account, "contact.send") && (account.uid === 0 || account.uid === contact.ownerUid);
  const body = draft.text.trim();
  const tooLong = new TextEncoder().encode(draft.text).length > MAX_REPLY_BYTES;
  /* the Kernel recorded this exact text as a failed delivery; the chat has the retry, new text is a new message */
  const undelivered = state === "undelivered" && draft.intent?.text === body;

  const send = async () => {
    if (!maySend || !body || tooLong || state === "sending" || undelivered) return;
    const intent = replyIntentFor(draft.intent, notice, body);
    onDraft({ ...draft, intent });
    setState("sending"); setError(null);
    try {
      const result = await sendContactMessage(client, notice.contactId, intent);
      if (result.state === "failed") {
        setState("undelivered");
        setError("not delivered — open the chat to retry");
        return;
      }
      setState("idle");
      onSent(intent.throughSequence, intent);
    } catch (cause) {
      setState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div class="reply-box">
      <div class="reply-messages">{notice.messages.map((message) => (
        <div key={message.id} class="message">
          <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
          {message.text && <p class="ask">{message.text}</p>}
          {message.media?.map((media, index) => <ZenMedia key={index} media={media} processId="" />)}
        </div>
      ))}</div>
      <textarea class="reply" rows={2} aria-label={`Reply to ${name}`} placeholder={`Reply to ${name}…`} value={draft.text} disabled={!maySend || state === "sending"}
        onInput={(event: JSX.TargetedEvent<HTMLTextAreaElement>) => {
          onDraft({ ...draft, text: event.currentTarget.value });
          if (state !== "sending") setState("idle");
        }} />
      <div class="send">
        <button type="button" class="ibtn is-primary" disabled={!maySend || !body || tooLong || state === "sending" || undelivered} onClick={() => void send()}>
          {state === "sending" ? "sending…" : `send to ${name}`}
        </button>
        {!maySend && <span>{!contact ? "contact not loaded yet" : contact.state !== "active" ? "this connection has ended" : "you can't send here"}</span>}
        {tooLong && <span class="error">too long to send</span>}
        {error && <span class="error" role="alert">{error}</span>}
      </div>
    </div>
  );
}
