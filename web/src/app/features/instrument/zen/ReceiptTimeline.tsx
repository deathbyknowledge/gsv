import { useState } from "preact/hooks";
import type { FleetReference } from "../fleet/fleetModel";
import { formatSeconds, offsetLabel, placeLabel, receiptFirstAt, type CallEvent, type Moment, type Place } from "./zenModel";

export type ReceiptLayout = "timeline" | "grouped";
/**
 * How an open receipt lays the run out. "timeline" is one chronological list: each note where it was
 * written, each call with its place, state and timing. "grouped" is the earlier layout, calls gathered
 * by place with the narration apart. Flip here to compare.
 */
export const RECEIPT_LAYOUT: ReceiptLayout = "timeline";

const PREVIEW_CHARS = 96;

/** The run as it happened: one row per note or call, timed from the first of them. */
export function ReceiptTimeline({ moment, places, now, onFleet }: {
  moment: Moment;
  places: readonly Place[];
  now: number;
  onFleet: (reference: FleetReference) => void;
}) {
  const events = moment.timeline ?? [];
  const base = receiptFirstAt(moment);
  const calls = events.filter((event): event is CallEvent => event.kind === "call");
  const startOf = (callId: string) => offsetLabel(calls.find((event) => event.call.callId === callId)?.startedAt ?? null, base);
  return (
    <ol class="receipt-timeline">
      {events.map((event, index) => event.kind === "thought" ? (
        <li key={`thought:${index}`} class="tl-row is-thought">
          <span class="tl-at">{offsetLabel(event.at, base)}</span>
          <span class="tl-mark" aria-hidden="true" />
          <p class="tl-thought">{event.text}</p>
        </li>
      ) : (
        <CallRow key={event.call.callId} event={event} base={base} places={places} live={moment.thinking} now={now} onFleet={onFleet}
          retryOf={event.retryOf ? startOf(event.retryOf) : null}
          retriedAt={calls.find((later) => later.retryOf === event.call.callId)?.startedAt ?? null} />
      ))}
    </ol>
  );
}

function CallRow({ event, base, places, live, now, onFleet, retryOf, retriedAt }: {
  event: CallEvent;
  base: number | null;
  places: readonly Place[];
  live: boolean;
  now: number;
  onFleet: (reference: FleetReference) => void;
  /** The offset of the failed attempt this call repeats, when it is a retry. */
  retryOf: string | null;
  /** When a later call repeated this failed one. */
  retriedAt: number | null;
}) {
  const [all, setAll] = useState(false);
  const { call } = event;
  const state = call.failed ? "failed" : call.finished ? "done" : live ? "running" : "unfinished";
  const code = call.syscall === "codemode.exec" || call.syscall === "codemode.run" || call.syscall === "CodeMode";
  const shell = call.syscall === "shell.exec";
  const subject = call.operation?.subject ?? (call.summary === call.syscall ? "" : call.summary);
  const duration = call.finished && event.startedAt !== null && event.endedAt !== null && event.endedAt > event.startedAt
    ? formatSeconds(event.endedAt - event.startedAt)
    : state === "running" && event.startedAt !== null ? formatSeconds(now - event.startedAt) : null;
  const lines = call.output ? call.output.split("\n") : [];
  const folded = lines.length > 1 || (lines[0]?.length ?? 0) > PREVIEW_CHARS;
  const preview = lines.length === 0 ? "" : lines[0].length > PREVIEW_CHARS ? `${lines[0].slice(0, PREVIEW_CHARS)}…` : lines.length > 1 ? `${lines[0]} …` : lines[0];
  const meta = [
    state === "running" ? "running…" : state === "failed" ? "failed" : state === "unfinished" ? "unfinished" : null,
    duration,
    retryOf ? `again, after the failure at ${retryOf}` : null,
    retriedAt !== null ? `retried at ${offsetLabel(retriedAt, base)}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <li class={`tl-row is-call is-${state}${event.retryOf ? " is-retry" : ""}`}>
      <span class="tl-at">{offsetLabel(event.startedAt, base)}</span>
      <span class={`dot is-${state}${state === "running" ? " blink" : ""}`} aria-hidden="true" />
      <div class="tl-body">
        <div class="tl-head">
          {event.target !== null ? (
            <button type="button" class="work-link tl-place" onClick={() => onFleet(`target:${event.target}`)}>{placeLabel(event.target, places)}</button>
          ) : <span class="tl-place">the process</span>}
          {shell ? (
            <span class="tl-what"><span class="shell-prompt">$</span> {call.summary}</span>
          ) : code ? (
            <span class="tl-what">CodeMode</span>
          ) : (
            <span class="tl-what">{call.operation?.label ?? call.syscall}{subject ? <> <span class="tl-subject">{subject}</span></> : null}{call.operation?.detail ? <span class="n"> · {call.operation.detail}</span> : null}</span>
          )}
          {meta.length > 0 ? <span class="tl-meta">{meta.join(" · ")}</span> : null}
        </div>
        {code && call.summary ? <pre class="work-source"><code>{call.summary}</code></pre> : null}
        {call.output ? (
          <div class="tl-result">
            <pre class="work-output">{all ? call.output : preview}</pre>
            {folded ? <button type="button" class="work-link" onClick={() => setAll((current) => !current)}>{all ? "less" : "all"}</button> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
