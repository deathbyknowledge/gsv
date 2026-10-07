import { contactDisplayName, type ContactSummary } from "@humansandmachines/gsv/protocol";
import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { randomId } from "../../../services/ids";
import { canConfigure } from "../settings/settingsModel";
import { latestOf, type ContactNotice } from "./useContactNotices";
import "../shared/senderBadge.css";

/* the same ceiling the People composer applies */
const MAX_REPLY_BYTES = 32_768;
/* how much of the newest message the notice line shows */
const PREVIEW_WORDS = 8;

/** The local alias when the person set one, else the name the peer sent. */
export function noticeName(notice: ContactNotice, contact: ContactSummary | undefined): string {
  return contact ? contactDisplayName(contact) : notice.displayName;
}

/** The first words of a message, clipped; an attachment with no text says so. */
export function preview(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "(an attachment, with no text)";
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
export function ContactNoticeMoment({ notice, contact, open, onShow, onGoToChat, children }: {
  notice: ContactNotice;
  contact: ContactSummary | undefined;
  /** the messages are showing, so the show action steps aside */
  open: boolean;
  onShow: () => void;
  onGoToChat: () => void;
  children?: ComponentChildren;
}) {
  const name = noticeName(notice, contact);
  const latest = latestOf(notice);
  const count = notice.messages.length;
  return (
    <div class="zen-moment is-contact-notice" role="status">
      <div class="who">{name}{senderBadge(latest.byShip)}</div>
      <div class="text">{preview(latest.text)}{notice.replied && <span class="replied">(replied)</span>}</div>
      {children}
      <div class="keys">
        {!notice.replied && !open && <button type="button" class="fleet-text-action" onClick={onShow}>{count === 1 ? "show message" : `show ${count} messages`}</button>}
        <button type="button" class="fleet-text-action" onClick={onGoToChat}>go to chat</button>
      </div>
    </div>
  );
}

/** The waiting messages in full and a reply box, inline under the notice; sending threads the reply to the newest one. */
export function ContactReplyBox({ notice, contact, account, onSent }: {
  notice: ContactNotice;
  contact: ContactSummary | undefined;
  account: ConsoleAccount | undefined;
  onSent: () => void;
}) {
  const { client, connected } = useGateway();
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const name = noticeName(notice, contact);
  const maySend = connected && !!account && !!contact && contact.state === "active" && !contact.blocked
    && canConfigure(account, "contact.send") && (account.uid === 0 || account.uid === contact.ownerUid);
  const tooLong = new TextEncoder().encode(text).length > MAX_REPLY_BYTES;

  const send = async () => {
    const body = text.trim();
    if (!maySend || !body || tooLong || state === "sending") return;
    setState("sending"); setError(null);
    try {
      await client.contact.send({ contactId: notice.contactId, text: body, idempotencyKey: randomId(), replyTo: latestOf(notice).reference });
      onSent();
    } catch (cause) {
      setState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div class="reply-box">
      {notice.messages.map((message) => <p key={message.messageId} class="ask">{message.text || "(an attachment, with no text)"}</p>)}
      <textarea class="reply" rows={3} placeholder={`reply to ${name}`} value={text} disabled={!maySend || state === "sending"}
        onInput={(event: JSX.TargetedEvent<HTMLTextAreaElement>) => setText(event.currentTarget.value)} />
      <div class="send">
        <button type="button" class="ibtn is-primary" disabled={!maySend || !text.trim() || tooLong || state === "sending"} onClick={() => void send()}>
          {state === "sending" ? "sending…" : `send to ${name}`}
        </button>
        {!maySend && <span>{!contact ? "contact not loaded yet" : contact.state !== "active" ? "this connection has ended" : "you can't send here"}</span>}
        {tooLong && <span class="error">too long to send</span>}
        {error && <span class="error" role="alert">{error}</span>}
      </div>
    </div>
  );
}
