import type { FleetReference } from "../fleet/fleetModel";
import { placeLabel, type CallEvent, type Moment, type Place } from "./zenModel";
import { receiptActions, type ReceiptNote } from "./runReceipts";
import { CallWorking } from "./ActivityWorking";

export type ReceiptLayout = "timeline" | "grouped";
/**
 * How an open receipt lays the run out. "timeline" is one chronological list: each note where it was
 * written, each call with its place and state. "grouped" is the earlier layout, calls gathered
 * by place with the narration apart. Flip here to compare.
 */
export const RECEIPT_LAYOUT: ReceiptLayout = "timeline";

/** The run as it happened: each purpose opens its readable request, result and notes. */
export function ReceiptTimeline({ moment, who, places, relatedCalls, onFleet, scope, expanded, onToggle, waitingCallId }: {
  moment: Moment;
  who: string;
  places: readonly Place[];
  relatedCalls: readonly CallEvent[];
  onFleet: (reference: FleetReference) => void;
  scope: string;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  waitingCallId?: string;
}) {
  const events = moment.timeline ?? [];
  const { actions, trailingNotes } = receiptActions(events);
  return (
    <>
      <ol class="receipt-timeline">
        {actions.map(({ event, notes }) => (
          <CallRow key={event.call.callId} event={event} notes={notes} who={who} places={places} live={moment.thinking} onFleet={onFleet}
              open={expanded.has(`${scope}:call:${event.call.callId}`)} onToggle={() => onToggle(`${scope}:call:${event.call.callId}`)}
              waiting={waitingCallId === event.call.callId}
              retryOf={event.retryOf !== null}
              retried={relatedCalls.some((later) => later.retryOf === event.call.callId)} />
        ))}
      </ol>
      {trailingNotes.length > 0 ? (
        <div class="tl-run-notes">
          <button type="button" class="work-link" aria-expanded={expanded.has(`${scope}:notes`)} onClick={() => onToggle(`${scope}:notes`)}>working notes</button>
          {expanded.has(`${scope}:notes`) ? <Notes notes={trailingNotes} /> : null}
        </div>
      ) : null}
    </>
  );
}

function CallRow({ event, notes, who, places, live, onFleet, retryOf, retried, open, onToggle, waiting }: {
  event: CallEvent;
  notes: ReceiptNote[];
  who: string;
  places: readonly Place[];
  live: boolean;
  onFleet: (reference: FleetReference) => void;
  /** Whether this repeats a failed attempt, including one in an earlier receipt. */
  retryOf: boolean;
  retried: boolean;
  open: boolean;
  onToggle: () => void;
  waiting: boolean;
}) {
  const { call } = event;
  const state = call.failed ? "failed" : call.finished ? "done" : waiting ? "waiting" : live ? "running" : "unfinished";
  const meta = [
    retryOf ? "retry of an earlier action" : null,
    retried ? "retried" : null,
  ].filter(Boolean);
  const stateLabel = state === "done" ? (retryOf ? "retried" : null)
    : state === "waiting" ? "needs approval"
    : state === "failed" && retried ? "failed · retried" : state;
  return (
    <li class={`tl-row is-call is-${state}${open ? " is-open" : ""}${event.retryOf ? " is-retry" : ""}`}>
      <button type="button" class="tl-toggle" aria-expanded={open} onClick={onToggle}>
        <span class="tl-chevron" aria-hidden="true">›</span>
        <span class={`dot is-${state}${state === "running" ? " blink" : ""}`} aria-hidden="true" />
        <span class="tl-purpose">{call.description}</span>
        {stateLabel ? <span class="tl-state">{stateLabel}</span> : null}
      </button>
      {open ? (
        <div class="tl-body">
          <div class="tl-meta">
            {event.target !== null ? (
              <button type="button" class="work-link tl-place" onClick={() => onFleet(`target:${event.target}`)}>{placeLabel(event.target, places)}</button>
            ) : <span class="tl-place">the process</span>}
            {meta.length > 0 ? <span> · {meta.join(" · ")}</span> : null}
          </div>
          <CallWorking call={call} who={who} target={event.target} />
          {notes.length > 0 ? (
            <>
              <div class="tl-label">notes before this action</div>
              <Notes notes={notes} />
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Notes({ notes }: { notes: ReceiptNote[] }) {
  return <div class="tl-notes">{notes.map((note, index) => (
    <p key={index} class="tl-thought">{note.text}</p>
  ))}</div>;
}
