import type { FleetReference } from "../fleet/fleetModel";
import { formatSeconds, offsetLabel, placeLabel, receiptFirstAt, type CallEvent, type Moment, type Place } from "./zenModel";
import { receiptActions, type ReceiptNote } from "./runReceipts";

export type ReceiptLayout = "timeline" | "grouped";
/**
 * How an open receipt lays the run out. "timeline" is one chronological list: each note where it was
 * written, each call with its place, state and timing. "grouped" is the earlier layout, calls gathered
 * by place with the narration apart. Flip here to compare.
 */
export const RECEIPT_LAYOUT: ReceiptLayout = "timeline";

/** The run as it happened: one row per note or call, timed from the first of them. */
export function ReceiptTimeline({ moment, places, now, onFleet, scope, expanded, onToggle, waitingCallId }: {
  moment: Moment;
  places: readonly Place[];
  now: number;
  onFleet: (reference: FleetReference) => void;
  scope: string;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  waitingCallId?: string;
}) {
  const events = moment.timeline ?? [];
  const { actions, trailingNotes } = receiptActions(events);
  const base = receiptFirstAt(moment);
  const calls = events.filter((event): event is CallEvent => event.kind === "call");
  const startOf = (callId: string) => offsetLabel(calls.find((event) => event.call.callId === callId)?.startedAt ?? null, base);
  return (
    <>
      <ol class="receipt-timeline">
        {actions.map(({ event, notes }) => (
          <CallRow key={event.call.callId} event={event} notes={notes} base={base} places={places} live={moment.thinking} now={now} onFleet={onFleet}
            open={expanded.has(`${scope}:call:${event.call.callId}`)} onToggle={() => onToggle(`${scope}:call:${event.call.callId}`)}
            waiting={waitingCallId === event.call.callId}
            retryOf={event.retryOf ? startOf(event.retryOf) : null}
            retriedAt={calls.find((later) => later.retryOf === event.call.callId)?.startedAt ?? null} />
        ))}
      </ol>
      {trailingNotes.length > 0 ? (
        <div class="tl-run-notes">
          <button type="button" class="work-link" aria-expanded={expanded.has(`${scope}:notes`)} onClick={() => onToggle(`${scope}:notes`)}>working notes</button>
          {expanded.has(`${scope}:notes`) ? <Notes notes={trailingNotes} base={base} /> : null}
        </div>
      ) : null}
    </>
  );
}

function CallRow({ event, notes, base, places, live, now, onFleet, retryOf, retriedAt, open, onToggle, waiting }: {
  event: CallEvent;
  notes: ReceiptNote[];
  base: number | null;
  places: readonly Place[];
  live: boolean;
  now: number;
  onFleet: (reference: FleetReference) => void;
  /** The offset of the failed attempt this call repeats, when it is a retry. */
  retryOf: string | null;
  /** When a later call repeated this failed one. */
  retriedAt: number | null;
  open: boolean;
  onToggle: () => void;
  waiting: boolean;
}) {
  const { call } = event;
  const state = call.failed ? "failed" : call.finished ? "done" : waiting ? "waiting" : live ? "running" : "unfinished";
  const shell = call.syscall === "shell.exec";
  const duration = call.finished && event.startedAt !== null && event.endedAt !== null && event.endedAt > event.startedAt
    ? formatSeconds(event.endedAt - event.startedAt)
    : state === "running" && event.startedAt !== null ? formatSeconds(now - event.startedAt) : null;
  const meta = [
    offsetLabel(event.startedAt, base),
    duration,
    call.operation?.detail ?? null,
    retryOf ? `again, after the failure at ${retryOf}` : null,
    retriedAt !== null ? `retried at ${offsetLabel(retriedAt, base)}` : null,
  ].filter(Boolean);
  const stateLabel = state === "done" ? (retryOf ? "retried" : null)
    : state === "waiting" ? "needs approval"
    : state === "failed" && retriedAt !== null ? "failed · retried" : state;
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
          <div class="tl-label">{shell ? "command" : "request"}</div>
          <pre class="work-source tl-evidence"><code>{call.request}</code></pre>
          {call.output ? (
            <>
              <div class="tl-label">result</div>
              <pre class="work-output tl-evidence">{call.output}</pre>
            </>
          ) : call.finished && call.operation ? (
            <p class="tl-confirmation">{call.operation.label} {call.operation.subject}{call.operation.detail ? ` · ${call.operation.detail}` : ""}</p>
          ) : null}
          {notes.length > 0 ? (
            <>
              <div class="tl-label">notes before this action</div>
              <Notes notes={notes} base={base} />
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Notes({ notes, base }: { notes: ReceiptNote[]; base: number | null }) {
  return <div class="tl-notes">{notes.map((note, index) => (
    <p key={index} class="tl-thought"><span class="tl-note-time">{offsetLabel(note.at, base)}</span>{note.text}</p>
  ))}</div>;
}
