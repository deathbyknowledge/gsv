import { contactDisplayName, type ContactSummary } from "@humansandmachines/gsv/protocol";
import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { randomId } from "../../../services/ids";
import { canConfigure } from "../settings/settingsModel";
import type { ContactNotice } from "./useContactNotices";
import "../shared/senderBadge.css";

/* the same ceiling the People composer applies */
const MAX_REPLY_BYTES = 32_768;

/** The local alias when the person set one, else the name the peer sent. */
export function noticeName(notice: ContactNotice, contact: ContactSummary | undefined): string {
  return contact ? contactDisplayName(contact) : notice.displayName;
}

/* inline markup rather than a component, so the badge reads in the moment's own tree */
function senderBadge(byShip: boolean) {
  return <span class="sender-badge">{byShip && <span class="sender-dot" />}{byShip ? "GSV" : "PERSON"}</span>;
}

/**
 * A contact wrote while the person was here: their name and badge the way any sender shows,
 * how many messages are waiting, and what to do about it. The reply box, when open, renders
 * as children between the line and the actions.
 */
export function ContactNoticeMoment({ notice, contact, open, onReply, onGoToChat, children }: {
  notice: ContactNotice;
  contact: ContactSummary | undefined;
  /** the reply box is showing, so the reply action steps aside */
  open: boolean;
  onReply: () => void;
  onGoToChat: () => void;
  children?: ComponentChildren;
}) {
  const name = noticeName(notice, contact);
  return (
    <div class="zen-moment is-contact-notice" role="status">
      <div class="who">{name}{senderBadge(notice.byShip)}</div>
      <div class="text">{`Sent ${notice.count} ${notice.count === 1 ? "message" : "messages"}`}{notice.replied && <span class="replied">(replied)</span>}</div>
      {children}
      <div class="keys">
        {!notice.replied && !open && <button type="button" class="fleet-text-action" onClick={onReply}>reply</button>}
        <button type="button" class="fleet-text-action" onClick={onGoToChat}>go to chat</button>
      </div>
    </div>
  );
}

/** The message and a reply box inline under the notice; sending threads the reply to that message. */
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
      await client.contact.send({ contactId: notice.contactId, text: body, idempotencyKey: randomId(), replyTo: notice.reference });
      onSent();
    } catch (cause) {
      setState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div class="reply-box">
      <p class="ask">{notice.text || "(an attachment, with no text)"}</p>
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
