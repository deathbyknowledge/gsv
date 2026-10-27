import { describeChatError, describeHistoryEventError, type ChatErrorContext, type ChatErrorPresentation } from "../../../services/chat/domain/errorPresentation";
import { historyEventText } from "../../../services/chat/domain/typedHistory";
import { adapterDisplayName, type ProcHistoryEvent, type ProcHistoryEventLink } from "@humansandmachines/gsv/protocol";
import { useT, type TextKey, type Translate } from "../../../i18n/locale";
import { Hint } from "../../../components/ui/Tooltip";
import { AppLink } from "../../../services/navigation/appNavigation";
import { peoplePath } from "../people/peopleNavigation";
import { memo } from "preact/compat";
import { momentTime, noteSummary, type Moment } from "./zenModel";

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

/** When the moment was sent, read in the owner's zone. Always in the label row so nothing moves; the stylesheet reveals it on hover, focus or the browse cursor. */
export const MomentTime = memo(function MomentTime({ timestamp, today, timeZone }: { timestamp: number; today: number; timeZone: string }) {
  useT(); // the label names its month in the interface language, so a language change renders it again
  const when = momentTime(timestamp, timeZone, today);
  return <time class="when" dateTime={new Date(timestamp).toISOString()} title={when.title}>{when.label}</time>;
});

/** The owner's zone and the start of their day, which moment times are read in. */
export type MomentClock = { today: number; timeZone: string };

export function NoteMoment({
  moment,
  open,
  focus,
  index,
  phase,
  clock,
  onToggle,
}: {
  moment: Moment;
  /** Absent where no clock is known, such as a preview. */
  clock?: MomentClock;
  open: boolean;
  focus: boolean;
  index: number;
  /** Where the note is in the load cascade: waiting its turn, taking it, or settled. */
  phase: "pending" | "materialising" | "settled";
  onToggle: () => void;
}) {
  const t = useT();
  if (moment.event?.kind === "owner.notified") return ownerNoticeCard(t, moment, moment.event, { focus, index, phase, clock });
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

/** A notice GSV sent the person, shown whole and opened as a whole: who wrote, what they said, and which messenger carried it. */
function ownerNoticeCard(t: Translate, moment: Moment, event: OwnerNotified, { focus, index, phase, clock }: {
  focus: boolean; index: number; phase: "pending" | "materialising" | "settled"; clock?: MomentClock;
}) {
  const { payload } = event;
  const link = event.link ? eventLink(event.link) : null;
  const messenger = adapterDisplayName(payload.adapter);
  const count = payload.messages !== undefined && payload.messages > 1 ? t("chat.notice.messages", { count: String(payload.messages) }) : null;
  const content = <>
    <div class="notice-head">
      <span class="notice-from">{payload.from}</span>
      {payload.handle ? <span class="notice-handle">{`@${payload.handle}`}</span> : null}
    </div>
    {payload.topic === "contact.message" ? (
      <p class="notice-body">
        {count ? <span class="notice-count">{count}</span> : null}
        {payload.preview ? <q>{payload.preview}</q> : <span class="notice-quiet">{t("chat.notice.attachment")}</span>}
      </p>
    ) : (
      <p class="notice-body">{t(payload.topic === "contact.request" ? "chat.notice.request" : "chat.notice.accepted")}</p>
    )}
  </>;
  return (
    <div
      data-index={index}
      data-moment-id={moment.id}
      class={`zen-moment is-note is-owner-notice${focus ? " is-focus" : ""}${phase === "pending" ? " is-pending" : phase === "materialising" ? " is-materialising" : ""}`}
    >
      <div class="who">
        {t("chat.note.notice")}
        {clock ? <MomentTime timestamp={payload.sentAtMs} today={clock.today} timeZone={clock.timeZone} /> : null}
      </div>
      <div class="notice-card">
        {link ? <AppLink class="notice-open" href={link.href}>{content}<span class="notice-go">{t(link.label)}</span></AppLink> : <div class="notice-open">{content}</div>}
        <span class="notice-carrier">
          <Hint text={messenger} position="left">
            <span class="notice-carrier-mark" tabIndex={0} role="img" aria-label={t("chat.notice.sentOn", { channel: messenger })}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 8 14 2l-3 12-3-5-6-1Zm6 1 6-7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>
            </span>
          </Hint>
        </span>
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
