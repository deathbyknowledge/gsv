import { z } from "zod";
import type { ScheduleRecord, ScheduleTarget } from "@humansandmachines/gsv/protocol";
import { adapterMessageDestinationAllowed, identityLinkRouteGeneration } from "./adapter-destinations";
import type { KernelContext } from "./context";
import { deliveryId, processConsumer } from "./events/consumers";
import type { EventDefinition, Withdrawn } from "./events/registry";

export const SCHEDULE_FIRED = "schedule.fired";

/** Every firing of one schedule shares a subject, so a newer one can replace one still waiting. */
export function scheduleSubject(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

const firingSchema = z.strictObject({
  scheduleId: z.string(),
  pid: z.string(),
  scheduledAtMs: z.number().nullable(),
  firedAtMs: z.number(),
});

/** What a firing records: the schedule and process it is for, and when it was due and fired. */
export type ScheduleFiring = z.infer<typeof firingSchema>;

/** The schedule a waiting firing still goes for, or why it no longer should. */
function firingSchedule(
  firing: ScheduleFiring, ctx: KernelContext,
): { record: ScheduleRecord; target: Extract<ScheduleTarget, { kind: "process.event" }> } | Withdrawn {
  const record = ctx.schedules.getStored(firing.scheduleId);
  if (!record) return { withdrawn: "its schedule was removed" };
  const { target } = record;
  if (target.kind !== "process.event" || target.pid !== firing.pid) return { withdrawn: "its schedule no longer goes to this process" };
  return { record, target };
}

/**
 * A schedule's firing for one process. It names its schedule instead of copying the
 * message and data, which have no size limit, so the process gets the schedule as it
 * stands. With a reply destination, the firing takes its own run, which replies there.
 */
export const scheduleFiredEvent: EventDefinition = {
  routes: (event) => [{ consumer: processConsumer(firingSchema.parse(event.body).pid), lane: "background" }],
  withdrawal(event, ctx) {
    const found = firingSchedule(firingSchema.parse(event.body), ctx);
    return "withdrawn" in found ? found.withdrawn : null;
  },
  admit(event, _prepared, ctx) {
    const firing = firingSchema.parse(event.body);
    const found = firingSchedule(firing, ctx);
    if ("withdrawn" in found) return found;
    const { record, target } = found;
    const { replyTo } = target;
    const runId = deliveryId(event.id, processConsumer(firing.pid));
    if (replyTo) {
      if (!adapterMessageDestinationAllowed(replyTo, record.ownerUid, ctx)) return { withdrawn: "its reply destination is no longer allowed" };
      const link = ctx.adapters.identityLinks.get(replyTo.adapter, replyTo.accountId, replyTo.actorId);
      const routeGeneration = link ? identityLinkRouteGeneration(link, replyTo.surface) : undefined;
      // The delivery's run replies where its schedule says.
      ctx.runRoutes.setAdapterRoute({
        runId,
        processId: firing.pid,
        uid: record.ownerUid,
        destination: replyTo,
        ...(routeGeneration === undefined ? undefined : { routeGeneration }),
      });
    }
    return {
      event: {
        kind: "schedule.fired", severity: "info", audience: "model",
        payload: {
          runId, scheduleId: record.id, scheduleName: record.name, message: target.message,
          ...(target.data === undefined ? undefined : { data: target.data }),
          ...(replyTo ? { replyTo } : undefined),
          scheduledAtMs: firing.scheduledAtMs, firedAtMs: firing.firedAtMs,
        },
      },
      admission: { idle: "start", busy: replyTo ? "after" : "join" },
    };
  },
};
