import type { ProcessEventDeliverArgs } from "../../protocol/process-frames";
import type { KernelContext } from "../context";
import { contactMessageEvent } from "../federation/attention";
import { ownerNotifiedEvent } from "../owner-notice-runtime";
import { responsibilityReadyEvent } from "../responsibility-runtime";
import type { EventInput, EventRoute, LoggedEvent } from "./store";

/** What a receiving Process records for an event, and whether it starts or joins a run. */
export type ProcessEventDelivery = Omit<ProcessEventDeliverArgs, "eventId">;

/** A delivery that should not go, and why. */
export type Withdrawn = { withdrawn: string };

/**
 * One registered event type: where it goes and what it hands the Process there.
 * An attempt checks `withdrawal`, runs `prepare`, finds the Ship, checks
 * `withdrawal` again and runs `admit`, then calls the Process without another await.
 * Once the delivery ends, delivered or withdrawn, `settled` lets its producer follow up.
 */
export type EventDefinition<Prepared extends object | undefined = undefined> = {
  /** The consumers an event goes to, each with the lane that orders it there; read once, at append. */
  routes(event: EventInput): readonly EventRoute[];
  /** Why the event's subject no longer wants it, read from current state; null while it does. */
  withdrawal?(event: LoggedEvent, ctx: KernelContext): string | null;
  /** Reads what the delivery needs from the store that holds it. */
  prepare?(event: LoggedEvent, ctx: KernelContext): Promise<Prepared | Withdrawn>;
  /** Builds the delivery from current state, which it may rebind: the call follows at once. */
  admit(event: LoggedEvent, prepared: Prepared, ctx: KernelContext): ProcessEventDelivery | Withdrawn;
  /** Runs after the delivery has ended, such as to let work that waited on it go. It can't undo the delivery. */
  settled?(event: LoggedEvent, ctx: KernelContext): Promise<void>;
};

export type EventRegistry = Readonly<Record<string, EventDefinition<object | undefined>>>;

/** Event types the Kernel appends. Each type is defined beside the producer that appends it. */
export const EVENT_REGISTRY = {
  "contact.message": contactMessageEvent,
  "owner.notified": ownerNotifiedEvent,
  "responsibility.ready": responsibilityReadyEvent,
} satisfies EventRegistry;

export function isWithdrawn<Value extends object | undefined>(value: Value | Withdrawn): value is Withdrawn {
  return value !== undefined && "withdrawn" in value;
}
