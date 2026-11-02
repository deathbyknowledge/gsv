import type { NoticeDelivery, ShipOutcome } from "./notify";

/**
 * How a source accepts events from the public network, by how a delivery proves its sender:
 * `none` has no public address, `url` by a secret address, `standard` by the Standard Webhooks
 * signature, and `hmac` by the HMAC-SHA256 signature its `hmac` describes.
 */
export type EventSourceWebhook = "none" | "url" | "standard" | "hmac";

/**
 * How an `hmac` source's sender signs a delivery, with the source's secret, in `header`.
 * Without `pairs`, the signature covers the body. With them, the header holds comma-separated
 * KEY=VALUE pairs, a Unix timestamp under `timestamp` and a signature under each `signature`,
 * and each signature covers `TIMESTAMP.BODY`.
 */
export type WebhookHmac = {
  header: string;
  encoding: "hex" | "base64";
  /** Text before the signature, such as `sha256=`. */
  prefix?: string;
  pairs?: { timestamp: string; signature: string };
  /** A header holding each delivery's stable id; otherwise the body's `id`. */
  idHeader?: string;
  /** A header naming the kind of event, which with the body's `action` makes its title. */
  typeHeader?: string;
};

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
  hmac?: WebhookHmac;
  /** The sender issues the secret, rather than this Ship. */
  senderSecret?: true;
  /** A sender-issued secret hasn't been given yet, so every delivery is refused. */
  awaitingSecret?: true;
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
  /** Required with, and only with, `webhook: "hmac"`. */
  hmac?: WebhookHmac;
  /** The sender issues the secret: give it here, or later with `event.source.rotate`. */
  senderSecret?: boolean;
  /** A secret the sender issued; implies `senderSecret`. */
  secret?: string;
  expectEveryMs?: number;
};
/** `secret` and `webhookUrl` are returned once; a url source's address is its secret. A sender-issued secret is never returned. */
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

/** With `secret`, use one the sender issued instead of making a new one. A source whose sender issues it requires one. */
export type EventSourceRotateArgs = { name: string; secret?: string };

export type EventSourceRemoveArgs = { name: string };
export type EventSourceRemoveResult = { removed: boolean };

export type EventEmitArgs = { source: string; events: EventInput[] };
export type EventEmitResult = { accepted: number; duplicates: number };

export type EventListArgs = { source?: string; limit?: number };
export type EventListResult = { events: EventRecord[] };
