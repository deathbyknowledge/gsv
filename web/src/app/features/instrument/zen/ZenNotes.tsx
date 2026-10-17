import { describeChatError, describeHistoryEventError, type ChatErrorContext, type ChatErrorPresentation } from "../../../services/chat/domain/errorPresentation";
import { noteSummary, type Moment } from "./zenModel";

/** A line above the prompt: a plain notice, or a failure with its next step and the original text folded away. */
export type ZenNote = { kind: "notice"; text: string } | { kind: "failure"; failure: ChatErrorPresentation };

export function zenNotice(text: string): ZenNote {
  return { kind: "notice", text };
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
  /* a failure reads as what happened and what to do; the gateway's own words stay one click away */
  const failure = moment.event ? describeHistoryEventError(moment.event, moment.text) : null;
  return (
    <div
      data-index={index}
      data-moment-id={moment.id}
      class={`zen-moment is-note${failure ? " is-error" : ""}${open ? " is-open" : ""}${focus ? " is-focus" : ""}${phase === "pending" ? " is-pending" : phase === "materialising" ? " is-materialising" : ""}`}
    >
      <div class="who">{moment.event && moment.event.kind !== "history.compacted" ? moment.event.severity === "error" ? "error" : "event" : "memory"}</div>
      <button type="button" class="note-line" aria-expanded={open} onClick={onToggle}>
        <span class="tri">{open ? "▾" : "▸"}</span>
        <span class="note-summary">{failure ? failure.summary : noteSummary(moment.text)}</span>
        {failure ? <span class="note-hint">{open ? "hide details" : "details"}</span> : null}
      </button>
      {failure ? <p class="note-action">{failure.action}</p> : null}
      {open ? <div class="note-text">{moment.text}</div> : null}
    </div>
  );
}

/** The status line's message. It is text, not a control; only a failure's details fold open. */
export function FeedbackNote({ note }: { note: ZenNote }) {
  if (note.kind === "notice") return <span class="zen-feedback-note is-err" role="alert">{note.text}</span>;
  const { summary, action, detail } = note.failure;
  return (
    <div class="zen-feedback-note zen-feedback-error" role="alert">
      <span class="is-err">{summary}</span>
      <span class="action">{action}</span>
      {detail && detail !== summary ? (
        <details>
          <summary>details</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
    </div>
  );
}
