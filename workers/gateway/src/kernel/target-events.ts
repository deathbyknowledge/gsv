import { z } from "zod";
import {
  procHistoryTargetEventRegistry, type ProcHistoryEventPayload,
} from "@humansandmachines/gsv/protocol";
import { hasCapability } from "./capabilities";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import { processConsumer } from "./events/consumers";
import type { EventDefinition } from "./events/registry";
import type { LoggedEvent } from "./events/store";
import type { SignalWatchRecord } from "./signal-watches";

export const TARGET_STATUS = "target.status";

const definition = procHistoryTargetEventRegistry[TARGET_STATUS];

/** A target's connection changes share a subject, so a newer one replaces any still waiting. */
function targetSubject(targetId: string): string {
  return `target:${targetId}`;
}

const changeSchema = z.strictObject({
  watchId: z.string(),
  revision: z.number().int().positive(),
  pid: z.string(),
  connection: z.custom<ProcHistoryEventPayload<"target.connection">>((value) => definition.payloadSchema.safeParse(value).success),
});

const UNAUTHORIZED = "target watch authorization no longer permits delivery";

/**
 * Appends a target's connection change for each watch on it, in one transaction. A change
 * still waiting gives way, whichever watch it was for, so a watching process hears how the
 * target is now. Kernel lifecycle changes are the only producer; claimed machine frames
 * never enter this path.
 */
export function appendTargetConnection(
  host: Pick<Kernel, "ctx" | "eventRuntime" | "signalWatches">,
  connection: ProcHistoryEventPayload<"target.connection">,
): void {
  const subject = targetSubject(connection.targetId);
  const change = crypto.randomUUID();
  const appended = host.eventRuntime.transaction(() => {
    for (const waiting of host.eventRuntime.pending(TARGET_STATUS, subject)) {
      host.eventRuntime.withdraw(waiting, "a newer connection change replaced it");
    }
    const watches = host.signalWatches.matchTarget(connection.targetId, TARGET_STATUS);
    for (const watch of watches) {
      host.eventRuntime.append({
        type: TARGET_STATUS,
        ownerUid: watch.uid,
        subject,
        actor: { kind: "kernel" },
        key: `${change}:${watch.watchId}`,
        body: { watchId: watch.watchId, revision: watch.revision, pid: watch.targetProcessId, connection },
      });
    }
    return watches.length;
  });
  if (appended === 0) return;
  host.ctx.waitUntil(host.eventRuntime.kick().catch((error) => {
    console.warn("[Kernel] Failed to arm target event delivery:", error instanceof Error ? error.message : String(error));
  }));
}

/** The watch a change was appended for, while it stands at that revision. */
function standingWatch(event: LoggedEvent, ctx: KernelContext): SignalWatchRecord | null {
  const { watchId, revision } = changeSchema.parse(event.body);
  return ctx.signalWatches.active(watchId, revision);
}

/** The watching process may still see the target: its owner, capability and access are read at every delivery. */
function permitted(watch: SignalWatchRecord, targetId: string, ctx: KernelContext): boolean {
  const process = ctx.procs.get(watch.targetProcessId);
  const identity = ctx.procs.getIdentity(watch.targetProcessId);
  return process?.ownerUid === watch.uid && identity !== null
    && hasCapability(ctx.caps.resolve(identity.gids), "signal.watch")
    && ctx.targets.canAccess(targetId, identity.uid, identity.gids)
    && ctx.targets.get(targetId) !== null;
}

/**
 * A watched target's connection change, for the process that watches it. It starts or
 * joins a run when the model may see it. Once it goes, a one-time watch ends, unless its
 * process ignored the change; once it is withdrawn, as when the process is gone or lost
 * its authorization, its watch is marked failed.
 */
export const targetStatusEvent: EventDefinition = {
  routes: (event) => [{ consumer: processConsumer(changeSchema.parse(event.body).pid), lane: "background" }],
  withdrawal: (event, ctx) => standingWatch(event, ctx) ? null : "the watch was removed, changed or expired",
  admit(event, _prepared, ctx) {
    const { connection } = changeSchema.parse(event.body);
    const watch = standingWatch(event, ctx);
    if (!watch) return { withdrawn: "the watch was removed, changed or expired" };
    if (!permitted(watch, connection.targetId, ctx)) return { withdrawn: UNAUTHORIZED };
    return {
      event: { kind: definition.kind, payload: connection, severity: definition.severity, audience: watch.audience },
      admission: { idle: "start", busy: "join" },
    };
  },
  async settled(event, ctx, end) {
    const watch = standingWatch(event, ctx);
    if (!watch) return;
    if (end.state === "withdrawn") ctx.signalWatches.markFailed(watch.watchId, end.reason, watch.revision);
    else if (watch.once && !end.ignored) ctx.signalWatches.deleteHandled(watch.watchId, watch.revision);
  },
};
