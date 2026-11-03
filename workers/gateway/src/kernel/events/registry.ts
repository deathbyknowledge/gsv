import type { ProcessEventDeliverArgs } from "../../protocol/process-frames";
import type { KernelContext } from "../context";
import type { EventInput, EventRoute, LoggedEvent } from "./store";

/** What a receiving Process records for an event, and whether it starts or joins a run. */
export type ProcessEventDelivery = Omit<ProcessEventDeliverArgs, "eventId">;

/** One registered event type: where it goes and what it does there. */
export type EventDefinition = {
  /** The consumers an event goes to, each with the lane that orders it there; read once, at append. */
  routes(event: EventInput): readonly EventRoute[];
  /** What a Ship or process delivery hands the Process. */
  process(event: LoggedEvent): ProcessEventDelivery;
  /** Whether the event's subject still wants it; read before each attempt and again after its last await. */
  wanted?(event: LoggedEvent, ctx: KernelContext): boolean;
};

export type EventRegistry = Readonly<Record<string, EventDefinition>>;

/** Event types the Kernel appends. Each type arrives with the producer that appends it. */
export const EVENT_REGISTRY: EventRegistry = {};

/** The owner's Ship, whichever pid it has when the delivery goes. */
export function shipConsumer(ownerUid: number): string {
  return `personal:${ownerUid}`;
}

/** One process; the delivery is withdrawn once that pid is gone. */
export function processConsumer(pid: string): string {
  return `proc:${pid}`;
}

export type EventConsumer = { kind: "ship"; ownerUid: number } | { kind: "process"; pid: string };

export function parseConsumer(consumer: string): EventConsumer | null {
  const ship = /^personal:(\d+)$/.exec(consumer);
  if (ship) return { kind: "ship", ownerUid: Number(ship[1]) };
  if (consumer.startsWith("proc:") && consumer.length > "proc:".length) return { kind: "process", pid: consumer.slice("proc:".length) };
  return null;
}
