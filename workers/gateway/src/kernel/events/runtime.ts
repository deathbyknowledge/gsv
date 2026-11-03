import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../../installation/lifecycle";
import type { DurableTaskOptions } from "../../shared/durable-tasks";
import { deliverEventToProcess } from "../../shared/utils";
import type { KernelContext } from "../context";
import type { Kernel } from "../do";
import { ensurePersonalController } from "../personal-controller";
import { parseConsumer, type EventConsumer } from "./consumers";
import { EVENT_REGISTRY, isWithdrawn, type EventDefinition, type EventRegistry, type ProcessEventDelivery } from "./registry";
import type { EventInput, LoggedEvent, PendingDelivery } from "./store";

/** What the runtime reaches on its Kernel. */
export type EventRuntimeHost = Pick<
  Kernel,
  | "installationId" | "events" | "auth" | "procs" | "onboarding" | "buildKernelContext" | "schedule" | "cancelSchedule"
  | "responsibilities" | "responsibilityRuntime"
>;

/** What producers reach through their Kernel context. */
export type KernelEvents = Pick<EventRuntime, "append" | "kick" | "pending" | "withdraw">;

/** A Process delivery retries without limit: 2 s, doubling to 256 s. */
const PROCESS_RETRY = { baseMs: 2_000, capMs: 256_000 };

type AttemptResult =
  | { kind: "delivered"; runId: string | null; outcome: JsonObject; responsibilities?: ProcessEventDelivery["responsibilities"] }
  | { kind: "withdrawn"; reason: string };

/** Appends Kernel events and delivers them: one task, one gate check, one retry rule per consumer. */
export class EventRuntime {
  private running: Promise<void> | null = null;

  constructor(
    private readonly host: EventRuntimeHost,
    private readonly registry: EventRegistry = EVENT_REGISTRY,
  ) {}

  /** Appends an event and its deliveries once per type and key. Call inside the producer's transaction, then `kick`. */
  append(input: EventInput): LoggedEvent {
    const definition = this.registry[input.type];
    if (!definition) throw new Error(`Event type ${input.type} is not registered`);
    return this.host.events.append(input, definition.routes(input), Date.now()).event;
  }

  /** Runs due deliveries soon; call after the producer's transaction commits. */
  async kick(): Promise<void> {
    await this.arm(Date.now());
  }

  /** Pending deliveries of one type about one subject, oldest first. */
  pending(type: string, subject: string): PendingDelivery[] {
    return this.host.events.pending(type, subject);
  }

  /** Ends a pending delivery its producer no longer wants to go, without a call. */
  withdraw(delivery: PendingDelivery, reason: string): void {
    this.host.events.withdrawn(delivery.event.seq, delivery.consumer, reason, Date.now());
  }

  /** Re-arms the runner from the stored deliveries when the Kernel starts. */
  async recover(): Promise<void> {
    await this.arm(this.nextRunAt());
  }

  async onEvents(task: { id: string }): Promise<void> {
    // The running pass re-arms when it finishes, so a lane never receives one row twice.
    if (this.running) return;
    this.running = this.pass(task.id);
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private async pass(taskId: string): Promise<void> {
    const gate = await this.host.onboarding.managedWorkGate();
    if (!gate.allowed) {
      await this.arm(Date.now() + MANAGED_LIFECYCLE_RECHECK_MS, taskId);
      return;
    }
    this.host.events.prune(Date.now());
    // Lanes run concurrently, each one row at a time and in order.
    await Promise.all(this.host.events.dueHeads(Date.now()).map((head) => this.drain(head)));
    await this.arm(this.nextRunAt(), taskId);
  }

  private async drain(head: PendingDelivery): Promise<void> {
    for (let next: PendingDelivery | null = head; next;) {
      if (!await this.attempt(next)) return;
      next = next.lane === null ? null : this.host.events.dueHead(next.consumer, next.lane, Date.now());
    }
  }

  /** Makes one attempt; true once the delivery has ended and its lane may move on. */
  private async attempt(delivery: PendingDelivery): Promise<boolean> {
    const { event, consumer } = delivery;
    const definition = this.registry[event.type];
    const target = parseConsumer(consumer);
    if (!definition || !target) {
      const error = definition ? `Event consumer ${consumer} is not known` : `Event type ${event.type} is not registered`;
      this.host.events.failed(event.seq, consumer, error, null, Date.now());
      console.warn(`[Kernel] Ended event delivery ${event.id} to ${consumer}: ${error}`);
      return true;
    }
    let result: AttemptResult;
    try {
      result = await this.deliver(definition, delivery, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAt = Date.now() + Math.min(PROCESS_RETRY.capMs, PROCESS_RETRY.baseMs * 2 ** delivery.attemptCount);
      this.host.events.failed(event.seq, consumer, message, retryAt, Date.now());
      console.warn(`[Kernel] Event delivery ${event.id} to ${consumer} failed:`, message);
      return false;
    }
    if (result.kind === "withdrawn") {
      this.host.events.withdrawn(event.seq, consumer, result.reason, Date.now());
      return true;
    }
    const { responsibilities } = result;
    const now = Date.now();
    this.host.events.transaction(() => {
      this.host.events.delivered(event.seq, consumer, result, now);
      // The ledger's recovery wake covers a run that never settles what it was handed.
      if (responsibilities) this.host.responsibilities.markEventDelivered(event.ownerUid, responsibilities.ids, now);
    });
    if (responsibilities) {
      try {
        await this.host.responsibilityRuntime.reconcileResponsibilityWake(event.ownerUid);
      } catch (error) {
        // The delivery stands; a later reconcile, or the next start-up, arms the wake this one missed.
        console.warn(`[Kernel] Could not arm responsibility recovery after event ${event.id}:`, error instanceof Error ? error.message : String(error));
      }
    }
    return true;
  }

  /** Delivers once; the Process call is made synchronously after the last withdrawal check. */
  private async deliver(definition: EventDefinition<object | undefined>, delivery: PendingDelivery, target: EventConsumer): Promise<AttemptResult> {
    const { event } = delivery;
    const ctx = this.host.buildKernelContext({ callerOwnerUid: event.ownerUid });
    const early = this.withdrawal(definition, delivery, target, ctx);
    if (early) return { kind: "withdrawn", reason: early };
    // Read before finding the Ship, so content that is gone never starts one.
    const prepared = definition.prepare ? await definition.prepare(event, ctx) : undefined;
    if (isWithdrawn(prepared)) return { kind: "withdrawn", reason: prepared.withdrawn };
    const pid = target.kind === "process" ? target.pid : await ensurePersonalController(target.ownerUid, ctx);
    const late = this.withdrawal(definition, delivery, target, ctx);
    if (late) return { kind: "withdrawn", reason: late };
    const admitted = definition.admit(event, prepared, ctx);
    if (isWithdrawn(admitted)) return { kind: "withdrawn", reason: admitted.withdrawn };
    const result = await deliverEventToProcess(this.host.installationId, pid, {
      // One id per delivery: the Process dedupes by it and runs under it.
      eventId: `${event.id}:${delivery.consumer}`,
      ...admitted,
    });
    if ("unavailable" in result) throw new Error(result.message);
    return {
      kind: "delivered",
      runId: result.runId,
      outcome: { pid, queued: result.queued, ...(result.ignored ? { ignored: true } : undefined) },
      ...(admitted.responsibilities ? { responsibilities: admitted.responsibilities } : undefined),
    };
  }

  /**
   * Why a delivery should not go, read from current state; null while it may. Removing an
   * account fences deliveries not yet attempted. One already attempted may have reached its
   * Process, so it retries until it ends, and the Process dedupes it.
   */
  private withdrawal(
    definition: EventDefinition<object | undefined>, { event, attemptCount }: PendingDelivery, target: EventConsumer, ctx: KernelContext,
  ): string | null {
    const fresh = attemptCount === 0;
    if (fresh && this.host.auth.isAccountDisabled(event.ownerUid)) return "the owner's account was removed";
    if (target.kind === "process") {
      const process = this.host.procs.get(target.pid);
      if (!process) return "the process is gone";
      if (fresh && (this.host.auth.isAccountDisabled(process.uid) || this.host.auth.isAccountDisabled(process.ownerUid))) {
        return "the process's account was removed";
      }
    }
    return definition.withdrawal?.(event, ctx) ?? null;
  }

  private nextRunAt(): number | null {
    const due = [this.host.events.nextDueAt(), this.host.events.nextPruneAt()].filter((at): at is number => at !== null);
    return due.length ? Math.min(...due) : null;
  }

  /** Keeps one pending task, moved earlier when a delivery falls due sooner. */
  private async arm(at: number | null, excludeTaskId?: string): Promise<void> {
    if (at === null) return;
    const due = Math.max(Date.now(), at);
    const options: DurableTaskOptions = excludeTaskId ? { idempotent: true, excludeTaskId } : { idempotent: true };
    const existing = await this.host.schedule(new Date(due), "onEvents", null, options);
    // Task times are whole seconds; a pending task due no later than this one stands.
    if (existing.time * 1_000 <= due + 1_000) return;
    await this.host.cancelSchedule(existing.id);
    await this.host.schedule(new Date(due), "onEvents", null, options);
  }
}
