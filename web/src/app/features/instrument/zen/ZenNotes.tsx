import { describeChatError, describeHistoryEventError, type ChatErrorContext, type ChatErrorPresentation } from "../../../services/chat/domain/errorPresentation";
import { historyEventText } from "../../../services/chat/domain/typedHistory";
import type { ProcHistoryEvent, ProcHistoryEventLink } from "@humansandmachines/gsv/protocol";
import { useT, type TextKey, type Translate } from "../../../i18n/locale";
import { AppLink } from "../../../services/navigation/appNavigation";
import { peoplePath } from "../people/peopleNavigation";
import { noteSummary, type Moment } from "./zenModel";

type NoticeValues = Readonly<Record<string, string>>;

/** A line above the prompt: a plain notice, or a failure with its next step and the original text folded away. */
export type ZenNote =
  | { kind: "notice"; message: TextKey; values?: NoticeValues }
  | { kind: "text"; text: string }
  | { kind: "failure"; failure: ChatErrorPresentation };

export function zenNotice(message: TextKey, values?: NoticeValues): ZenNote {
  return { kind: "notice", message, values };
}

/** An error's own message, shown as it was raised. */
export function zenErrorText(text: string): ZenNote {
  return { kind: "text", text };
}

/** A failure reported by the gateway, described by what was being attempted when its cause is not recognised. */
export function zenFailure(detail: string, context: ChatErrorContext): ZenNote {
  return { kind: "failure", failure: describeChatError(detail, context) };
}

export function NoteMoment({
  moment,
  open,
  focus,
  index,
  phase,
  onToggle,
}: {
  moment: Moment;
  open: boolean;
  focus: boolean;
  index: number;
  /** Where the note is in the load cascade: waiting its turn, taking it, or settled. */
  phase: "pending" | "materialising" | "settled";
  onToggle: () => void;
}) {
  const t = useT();
  if (moment.event?.kind === "owner.notified") return ownerNoticeCard(t, moment, moment.event, focus, index, phase);
  /* the event rather than its cached row text, so the note follows the interface language */
  const text = moment.event ? historyEventText(moment.event) : moment.text;
  /* a failure reads as what happened and what to do; the gateway's own words stay one click away */
  const failure = moment.event ? describeHistoryEventError(moment.event, text) : null;
  const link = moment.event?.link ? eventLink(moment.event.link) : null;
  return (
    <div
      data-index={index}
      data-moment-id={moment.id}
      class={`zen-moment is-note${failure ? " is-error" : ""}${open ? " is-open" : ""}${focus ? " is-focus" : ""}${phase === "pending" ? " is-pending" : phase === "materialising" ? " is-materialising" : ""}`}
    >
      <div class="who">{t(moment.event && moment.event.kind !== "history.compacted" ? moment.event.severity === "error" ? "chat.note.error" : "chat.note.event" : "chat.note.memory")}</div>
      <button type="button" class="note-line" aria-expanded={open} onClick={onToggle}>
        <span class="tri">{open ? "▾" : "▸"}</span>
        <span class="note-summary">{failure ? t(failure.summary) : noteSummary(text)}</span>
        {failure ? <span class="note-hint">{t(open ? "chat.note.hide" : "chat.note.details")}</span> : null}
      </button>
      {failure ? <p class="note-action">{t(failure.action)}</p> : null}
      {link ? <AppLink class="note-link" href={link.href}>{t(link.label)}</AppLink> : null}
      {open ? <div class="note-text">{text}</div> : null}
    </div>
  );
}

type OwnerNotified = Extract<ProcHistoryEvent, { kind: "owner.notified" }>;

/** A notice GSV sent the person, shown whole: who wrote, where the person heard, what they said, and where to answer. */
function ownerNoticeCard(t: Translate, moment: Moment, event: OwnerNotified, focus: boolean, index: number, phase: "pending" | "materialising" | "settled") {
  const { payload } = event;
  const link = event.link ? eventLink(event.link) : null;
  const sent = new Date(payload.sentAtMs);
  const count = payload.messages !== undefined && payload.messages > 1 ? t("chat.notice.messages", { count: String(payload.messages) }) : null;
  return (
    <div
      data-index={index}
      data-moment-id={moment.id}
      class={`zen-moment is-note is-owner-notice${focus ? " is-focus" : ""}${phase === "pending" ? " is-pending" : phase === "materialising" ? " is-materialising" : ""}`}
    >
      <div class="who">{t("chat.note.notice")}</div>
      <div class="notice-card">
        <div class="notice-head">
          <span class="notice-from">{payload.from}</span>
          {payload.handle ? <span class="notice-handle">{`@${payload.handle}`}</span> : null}
          <span class="notice-meta">
            {t("chat.notice.via", { channel: payload.channel })} · <time dateTime={sent.toISOString()}>{sent.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
          </span>
        </div>
        {payload.topic === "contact.message" ? (
          <p class="notice-body">
            {count ? <span class="notice-count">{count}</span> : null}
            {payload.preview ? <q>{payload.preview}</q> : <span class="notice-quiet">{t("chat.notice.attachment")}</span>}
          </p>
        ) : (
          <p class="notice-body">{t(payload.topic === "contact.request" ? "chat.notice.request" : "chat.notice.accepted")}</p>
        )}
        {link ? <AppLink class="note-link" href={link.href}>{t(link.label)}</AppLink> : null}
      </div>
    </div>
  );
}

/** Where what an event is about lives in GSV. */
function eventLink(link: ProcHistoryEventLink): { href: string; label: TextKey } {
  return link.kind === "contact.request"
    ? { href: peoplePath({ view: "requests", requestId: link.requestId }), label: "chat.event.link.request" }
    : { href: peoplePath({ contactId: link.contactId }), label: "chat.event.link.contact" };
}

/** The status line's message. It is text, not a control; only a failure's details fold open. */
export function FeedbackNote({ note }: { note: ZenNote }) {
  const t = useT();
  if (note.kind === "notice") return <span class="zen-feedback-note is-err" role="alert">{t(note.message, note.values)}</span>;
  if (note.kind === "text") return <span class="zen-feedback-note is-err" role="alert">{note.text}</span>;
  const { detail } = note.failure;
  const summary = t(note.failure.summary);
  return (
    <div class="zen-feedback-note zen-feedback-error" role="alert">
      <span class="is-err">{summary}</span>
      <span class="action">{t(note.failure.action)}</span>
      {detail && detail !== summary ? (
        <details>
          <summary>{t("chat.note.details")}</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
    </div>
  );
}
