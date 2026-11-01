import type { NoticeDelivery, ShipOutcome } from "./notify";

/** How a source accepts events from the public network; `none` has no public address at all. */
export type EventSourceWebhook = "none" | "standard" | "github" | "stripe" | "url";

/** Somewhere an owner's custom events come from, whichever way each one arrives. */
export type EventSource = {
  sourceId: string;
  /** What commands call it, unique for its owner. */
  name: string;
  label: string;
  notify: NoticeDelivery;
  ship: ShipOutcome;
  /** The outcomes this source allows; an unsigned webhook never starts a run. */
  shipChoices: ShipOutcome[];
  webhook: EventSourceWebhook;
  enabled: boolean;
  /** Tell the owner when this long passes without an event. */
  expectEveryMs?: number;
  lastEventAtMs?: number;
  createdBy: "person" | "ship";
  changedBy?: "person" | "ship";
  updatedAtMs: number;
};

export type EventInput = {
  /** The sender's stable id; repeating one is ignored, so a poller needs no memory of its own. */
  id?: string;
  title: string;
  preview?: string;
  body?: string;
};

export type EventRecord = {
  sourceId: string;
  eventId: string;
  title: string;
  preview?: string;
  body?: string;
  /** Set by the Kernel from the caller, never by the sender. */
  emittedBy: "client" | "process" | "schedule" | "webhook";
  receivedAtMs: number;
};

export type EventSourceListArgs = Record<string, never>;
export type EventSourceListResult = { sources: EventSource[] };

export type EventSourceAddArgs = {
  name: string;
  label?: string;
  notify?: NoticeDelivery;
  ship?: ShipOutcome;
  webhook?: EventSourceWebhook;
  expectEveryMs?: number;
};
/** `secret` and `webhookUrl` are returned once; a url source's address is its secret. */
export type EventSourceSecretResult = { source: EventSource; secret?: string; webhookUrl?: string };

export type EventSourceUpdateArgs = {
  name: string;
  label?: string;
  notify?: NoticeDelivery;
  ship?: ShipOutcome;
  enabled?: boolean;
  expectEveryMs?: number | null;
};
export type EventSourceUpdateResult = { source: EventSource };

export type EventSourceRotateArgs = { name: string };

export type EventSourceRemoveArgs = { name: string };
export type EventSourceRemoveResult = { removed: boolean };

export type EventEmitArgs = { source: string; events: EventInput[] };
export type EventEmitResult = { accepted: number; duplicates: number };

export type EventListArgs = { source?: string; limit?: number };
export type EventListResult = { events: EventRecord[] };
