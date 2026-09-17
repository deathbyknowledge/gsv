import { linkReceiptRetries, type CallEvent, type Moment, type MomentEvent } from "./zenModel";

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
