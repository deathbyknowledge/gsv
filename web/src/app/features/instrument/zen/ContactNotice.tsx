import { contactDisplayName, type ContactSummary } from "@humansandmachines/gsv/protocol";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { randomId } from "../../../services/ids";
import { FleetDialog } from "../fleet/FleetDialog";
import { canConfigure } from "../settings/settingsModel";
import type { ContactNotice } from "./useContactNotices";
import "../shared/senderBadge.css";

/* the same ceiling the People composer applies */
const MAX_REPLY_BYTES = 32_768;

/** The local alias when the person set one, else the name the peer sent. */
export function noticeName(notice: ContactNotice, contact: ContactSummary | undefined): string {
  return contact ? contactDisplayName(contact) : notice.displayName;
}

/* inline markup rather than a component, so the badge reads in the row's own tree */
function senderBadge(byShip: boolean) {
  return <span class="sender-badge">{byShip && <span class="sender-dot" />}{byShip ? "GSV" : "PERSON"}</span>;
}

/** One line per contact with new messages: who wrote, how many, and what to do about it. */
export function ContactNoticeRow({ notice, contact, onShow, onGoToChat }: {
  notice: ContactNotice;
  contact: ContactSummary | undefined;
  onShow: () => void;
  onGoToChat: () => void;
}) {
  const name = noticeName(notice, contact);
  return (
    <div class="zen-moment is-contact-notice" role="status">
      <span class="text">{notice.count > 1 ? `${notice.count} new messages` : "new message"} from <strong>{name}</strong>{senderBadge(notice.byShip)}</span>
      <span class="keys">
        <button type="button" class="fleet-text-action" onClick={onShow}>show</button>
        <button type="button" class="fleet-text-action" onClick={onGoToChat}>go to chat</button>
      </span>
    </div>
  );
}

/** The message itself with a reply beneath it; sending threads the reply to that message. */
export function ContactNoticeDialog({ notice, contact, account, open, onClose, onSent }: {
  notice: ContactNotice;
  contact: ContactSummary | undefined;
  account: ConsoleAccount | undefined;
  open: boolean;
  onClose: () => void;
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
  useEffect(() => {
    if (!open) return;
    setText(""); setState("idle"); setError(null);
  }, [open, notice.messageId]);

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
    <FleetDialog open={open} title={`message from ${name}`} onClose={onClose}>
      <div class="zen-contact-dialog">
        <div class="q">{name}{senderBadge(notice.byShip)}{notice.count > 1 && <span class="more">latest of {notice.count}</span>}</div>
        <p class="ask">{notice.text || "(an attachment, with no text)"}</p>
        <textarea class="reply" rows={3} placeholder={`reply to ${name}`} value={text} disabled={!maySend || state === "sending"}
          onInput={(event: JSX.TargetedEvent<HTMLTextAreaElement>) => setText(event.currentTarget.value)} />
        <div class="keys">
          <button type="button" class="ibtn is-primary" disabled={!maySend || !text.trim() || tooLong || state === "sending"} onClick={() => void send()}>
            {state === "sending" ? "sending…" : `send to ${name}`}
          </button>
          {!maySend && <span>{!contact ? "contact not loaded yet" : contact.state !== "active" ? "this connection has ended" : "you can't send here"}</span>}
          {tooLong && <span class="error">too long to send</span>}
          {error && <span class="error" role="alert">{error}</span>}
        </div>
      </div>
    </FleetDialog>
  );
}
