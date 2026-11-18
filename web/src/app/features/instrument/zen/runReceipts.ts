import { linkReceiptRetries, timelineCalls, type CallEvent, type Moment, type MomentEvent } from "./zenModel";

export type RunReceipt = {
  key: string;
  anchorId: string;
  work: Moment;
  replies: Moment[];
  relatedCalls: CallEvent[];
};

/** Messages separate receipts; the run connects retry evidence without combining their work. */
export function receiptsForMoments(moments: readonly Moment[], activeRunId: string | null, processId: string | null): ReadonlyMap<string, RunReceipt> {
  const groups = new Map<string, Moment[]>();
  for (const moment of moments) {
    if (moment.role !== "ship" || moment.activities.some((activity) => activity.you)) continue;
    const key = `receipt:${JSON.stringify([moment.processId ?? processId, moment.runId, moment.runId ? null : moment.id])}`;
    const group = groups.get(key) ?? [];
    group.push(moment);
    groups.set(key, group);
  }
  const receipts = new Map<string, RunReceipt>();
  for (const group of groups.values()) {
    const relatedCalls = linkReceiptRetries(group.flatMap((moment) => moment.timeline ?? []))
      .filter((event): event is CallEvent => event.kind === "call");
    const calls = new Map(relatedCalls.map((event) => [event.call.callId, event]));
    for (const moment of group) {
      if (!moment.activities.length && !moment.narration && !moment.attribution) continue;
      const key = moment.receiptId ?? `receipt:${JSON.stringify([moment.processId ?? processId, moment.runId, moment.id])}`;
      receipts.set(moment.id, {
        key, anchorId: moment.id, relatedCalls,
        replies: moment.text.trim() || moment.media?.length || moment.streaming ? [moment] : [],
        work: {
          ...moment, id: key, text: "", media: undefined, streaming: false, attribution: undefined,
          processId: moment.processId ?? processId ?? undefined,
          thinking: moment.runId !== null && moment.runId === activeRunId && (moment.processId ?? processId) === processId
            && (moment.thinking || moment.activities.some((activity) => activity.live)),
          timeline: (moment.timeline ?? []).map((event) => event.kind === "call" ? calls.get(event.call.callId)! : event),
        },
      });
    }
  }
  return receipts;
}

/** How many of a receipt's calls hit an error that Ship did not try again. A command's exit code is never one. */
export function unresolvedErrors(receipt: RunReceipt): number {
  return timelineCalls(receipt.work).filter((event) => event.call.ending === "error"
    && !receipt.relatedCalls.some((later) => later.retryOf === event.call.callId)).length;
}

/**
 * Where a receipt shows. Work that ended in a message folds behind that message's receipt control. Work under way,
 * waiting on the person, or stopped on an error with nothing said stays a line in the conversation. Work that
 * finished cleanly with nothing said is Work's to show.
 */
export type ReceiptPlacement = "line" | "message" | "work";

export function receiptPlacement(receipt: RunReceipt, waiting: boolean): ReceiptPlacement {
  if (receipt.work.thinking || waiting) return "line";
  if (receipt.replies.length > 0) return "message";
  return unresolvedErrors(receipt) > 0 ? "line" : "work";
}

/** A ship moment with nothing to read: no words, media or stream, no work in progress, and no receipt the conversation keeps. */
export function silentWork(moment: Moment, receipt: RunReceipt | undefined): boolean {
  if (moment.role !== "ship" || moment.text || moment.media?.length || moment.streaming || moment.thinking) return false;
  if (moment.activities.some((activity) => activity.you)) return false;
  return !receipt || receiptPlacement(receipt, false) === "work";
}

export type ReceiptNote = Extract<MomentEvent, { kind: "thought" }>;
export type ReceiptAction = { event: CallEvent; notes: ReceiptNote[] };
type ReceiptActions = { actions: ReceiptAction[]; trailingNotes: ReceiptNote[] };

/** Keep notes before their next action; notes without a following call remain inspectable on the run. */
export function receiptActions(events: readonly MomentEvent[]): ReceiptActions {
  const actions: ReceiptAction[] = [];
  let notes: ReceiptNote[] = [];
  for (const event of events) {
    if (event.kind === "thought") notes.push(event);
    else {
      actions.push({ event, notes });
      notes = [];
    }
  }
  return { actions, trailingNotes: notes };
}
