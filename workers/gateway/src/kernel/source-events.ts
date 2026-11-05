import { z } from "zod";
import type { EventInput, EventRecord } from "@humansandmachines/gsv/protocol";
import type { EventDefinition } from "./events/registry";
import type { LoggedEvent } from "./events/store";

export const SOURCE_EVENT = "source.event";

/** Every event from one source shares a subject, which its list reads and its removal forgets. */
export function sourceSubject(sourceId: string): string {
  return `source:${sourceId}`;
}

/** A sender's ids are unique only within its source. */
export function sourceEventKey(sourceId: string, eventId: string): string {
  return `${sourceId}:${eventId}`;
}

const bodySchema = z.strictObject({
  eventId: z.string(),
  title: z.string(),
  preview: z.string().optional(),
  body: z.string().optional(),
  emittedBy: z.enum(["client", "process", "schedule", "webhook"]),
});

/** What the log keeps of one event: what its source's list shows. */
export function sourceEventBody(event: EventInput & { id: string }, emittedBy: EventRecord["emittedBy"]): z.infer<typeof bodySchema> {
  return {
    eventId: event.id,
    title: event.title,
    ...(event.preview === undefined ? undefined : { preview: event.preview }),
    ...(event.body === undefined ? undefined : { body: event.body }),
    emittedBy,
  };
}

/** One event as its source's list shows it. */
export function sourceEventRecord(event: LoggedEvent): EventRecord {
  if (event.actor.kind !== "source") throw new Error(`Source event ${event.id} names no source`);
  const { eventId, title, preview, body, emittedBy } = bodySchema.parse(event.body);
  return {
    sourceId: event.actor.sourceId,
    eventId,
    title,
    ...(preview === undefined ? undefined : { preview }),
    ...(body === undefined ? undefined : { body }),
    emittedBy,
    receivedAtMs: event.createdAt,
  };
}

/**
 * What arrived from a source, kept for its list and to refuse a repeat. It goes to no
 * one: Ship hears of it through the to-do or the notice its source asks for.
 */
export const sourceEventDefinition: EventDefinition = {
  routes: () => [],
  admit: () => ({ withdrawn: "a source event goes to no one" }),
};
