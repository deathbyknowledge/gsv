import { linkReceiptRetries, type CallEvent, type Moment, type MomentEvent } from "./zenModel";

export type RunReceipt = {
  key: string;
  anchorId: string;
  work: Moment;
  replies: Moment[];
};

type ReceiptProjection = {
  moments: Moment[];
  receipts: ReadonlyMap<string, RunReceipt>;
};

/** Conversation messages keep their identity and attribution; only their work shares one disclosure per run. */
export function groupRunReceipts(moments: readonly Moment[], activeRunId: string | null, processId: string | null): ReceiptProjection {
  const groups = new Map<string, Moment[]>();
  for (const moment of moments) {
    if (moment.role !== "ship" || moment.activities.some((activity) => activity.you)) continue;
    const key = `receipt:${JSON.stringify([moment.processId ?? processId, moment.runId, moment.runId ? null : moment.id])}`;
    const group = groups.get(key) ?? [];
    group.push(moment);
    groups.set(key, group);
  }
  const receipts = new Map<string, RunReceipt>();
  const hidden = new Set<string>();
  for (const [key, group] of groups) {
    if (!group.some((moment) => moment.activities.length || moment.narration || moment.attribution)) continue;
    const replies = group.filter((moment) => moment.text.trim() || moment.media?.length || moment.streaming);
    const anchor = replies[0] ?? group[0];
    const receipt: RunReceipt = {
      key, anchorId: anchor.id, replies,
      work: {
        ...anchor, id: key, text: "", media: undefined, streaming: false, attribution: undefined,
        processId: anchor.processId ?? processId ?? undefined,
        thinking: anchor.runId !== null && anchor.runId === activeRunId && (anchor.processId ?? processId) === processId,
        activities: group.flatMap((moment) => moment.activities),
        narration: group.map((moment) => moment.narration).filter(Boolean).join("\n\n"),
        timeline: linkReceiptRetries(group.flatMap((moment) => moment.timeline ?? [])),
      },
    };
    for (const moment of group) {
      receipts.set(moment.id, receipt);
      if (moment !== anchor && !replies.includes(moment)) hidden.add(moment.id);
    }
  }
  return { moments: moments.filter((moment) => !hidden.has(moment.id)), receipts };
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
