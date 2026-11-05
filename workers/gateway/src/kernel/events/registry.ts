import type { ExceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { ProcessEventDelivery } from "../../protocol/process-frames";
import type { ChatDelivery, ChatSendStage } from "../adapter-delivery";
import { CHAT_REPLY, chatReplyEvent } from "../chat-replies";
import type { KernelContext } from "../context";
import { DELIVERY_FAILED, deliveryFailedEvent } from "../delivery-events";
import { contactMessageEvent } from "../federation/attention";
import { ipcEventDefinitions } from "../ipc-events";
import { messageEventDefinitions } from "../message-events";
import { ownerNotifiedEvent } from "../owner-notice-runtime";
import { responsibilityReadyEvent } from "../responsibility-runtime";
import { scheduleFiredEvent } from "../schedule-events";
import { sourceEventDefinition } from "../source-events";
import { TARGET_STATUS, targetStatusEvent } from "../target-events";
import { WORK_RETURNED, workReturnedEvent } from "../work-return-events";
import type { EventInput, EventRoute, LoggedEvent } from "./store";

export type { ProcessEventDelivery } from "../../protocol/process-frames";

/** A delivery that should not go, and why. */
export type Withdrawn = { withdrawn: string };

/** Why a chat send ended unsent: refused for good, possibly sent already, or still failing after its retries. */
export type ChatUnsent = {
  outcome: "permanent" | "ambiguous" | "exhausted";
  attempts: number;
  stage: ChatSendStage;
  diagnostics?: ExceptionDiagnostics;
};

/** How a delivery ended: taken, though its Process may have ignored it; withdrawn; or refused by its Process or left unsent by its chat. */
export type DeliveryEnd =
  | { state: "delivered"; ignored: boolean }
  | { state: "withdrawn"; reason: string }
  | { state: "failed"; reason: string; unsent?: ChatUnsent };

/**
 * One registered event type: where it goes and what it hands each consumer there.
 * An attempt checks `withdrawal`, runs `prepare`, finds the Ship, checks
 * `withdrawal` again and runs `admit`, then calls the Process without another await.
 * A chat's attempt runs `present` in place of `admit` and sends what it builds.
 * Once the delivery ends, delivered or withdrawn, `settled` lets its producer follow up.
 */
/** What a definition's `prepare` reads for a delivery; a producer that already holds it may hand it over. */
export type PreparedContent = object;

export type EventDefinition<Prepared extends PreparedContent | undefined = undefined> = {
  /** The consumers an event goes to, each with the lane that orders it there; read once, at append. */
  routes(event: EventInput): readonly EventRoute[];
  /** Why the event's subject no longer wants it, read from current state; null while it does. */
  withdrawal?(event: LoggedEvent, ctx: KernelContext): string | null;
  /** Reads what the delivery needs from the store that holds it. */
  prepare?(event: LoggedEvent, ctx: KernelContext): Promise<Prepared | Withdrawn>;
  /** Builds a process's delivery from current state, which it may rebind: the call follows at once. Required to route to a process or Ship. */
  admit?(event: LoggedEvent, prepared: Prepared, ctx: KernelContext): ProcessEventDelivery | Withdrawn;
  /** Builds what a messenger chat receives. Required to route to a chat. */
  present?(event: LoggedEvent, prepared: Prepared, ctx: KernelContext): ChatDelivery | Withdrawn;
  /** Runs after the delivery has ended, such as to let work that waited on it go. It can't undo the delivery. */
  settled?(event: LoggedEvent, ctx: KernelContext, end: DeliveryEnd): Promise<void>;
};

export type EventRegistry = Readonly<Record<string, EventDefinition<PreparedContent | undefined>>>;

/** Event types the Kernel appends. Each type is defined beside the producer that appends it. */
export const EVENT_REGISTRY = {
  [CHAT_REPLY]: chatReplyEvent,
  "contact.message": contactMessageEvent,
  [DELIVERY_FAILED]: deliveryFailedEvent,
  ...ipcEventDefinitions,
  ...messageEventDefinitions,
  "owner.notified": ownerNotifiedEvent,
  "responsibility.ready": responsibilityReadyEvent,
  "schedule.fired": scheduleFiredEvent,
  "source.event": sourceEventDefinition,
  [TARGET_STATUS]: targetStatusEvent,
  [WORK_RETURNED]: workReturnedEvent,
} satisfies EventRegistry;

export function isWithdrawn<Value extends object | undefined>(value: Value | Withdrawn): value is Withdrawn {
  return value !== undefined && "withdrawn" in value;
}
