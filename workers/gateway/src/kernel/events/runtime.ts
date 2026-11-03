import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../../installation/lifecycle";
import type { DurableTaskOptions } from "../../shared/durable-tasks";
import { deliverEventToProcess } from "../../shared/utils";
import type { Kernel } from "../do";
import { ensurePersonalController } from "../personal-controller";
import { EVENT_REGISTRY, parseConsumer, type EventConsumer, type EventDefinition, type EventRegistry } from "./registry";
import type { EventInput, LoggedEvent, PendingDelivery } from "./store";

/** What the runtime reaches on its Kernel. */
export type EventRuntimeHost = Pick<
  Kernel,
  "installationId" | "events" | "auth" | "procs" | "onboarding" | "buildKernelContext" | "schedule" | "cancelSchedule"
>;

/** A Process delivery retries without limit: 2 s, doubling to 256 s. */
const PROCESS_RETRY = { baseMs: 2_000, capMs: 256_000 };

type AttemptResult =
  | { kind: "delivered"; runId: string | null; outcome: JsonObject }
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
    try {
      const result = await this.deliver(definition, delivery, target);
      if (result.kind === "withdrawn") this.host.events.withdrawn(event.seq, consumer, result.reason, Date.now());
      else this.host.events.delivered(event.seq, consumer, result, Date.now());
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAt = Date.now() + Math.min(PROCESS_RETRY.capMs, PROCESS_RETRY.baseMs * 2 ** delivery.attemptCount);
      this.host.events.failed(event.seq, consumer, message, retryAt, Date.now());
      console.warn(`[Kernel] Event delivery ${event.id} to ${consumer} failed:`, message);
      return false;
    }
  }

  /** Delivers once; the Process call is made synchronously after the last withdrawal check. */
  private async deliver(definition: EventDefinition, delivery: PendingDelivery, target: EventConsumer): Promise<AttemptResult> {
    const early = this.withdrawal(definition, delivery.event, target);
    if (early) return { kind: "withdrawn", reason: early };
    const pid = target.kind === "process"
      ? target.pid
      : await ensurePersonalController(target.ownerUid, this.host.buildKernelContext({ callerOwnerUid: target.ownerUid }));
    const late = this.withdrawal(definition, delivery.event, target);
    if (late) return { kind: "withdrawn", reason: late };
    const result = await deliverEventToProcess(this.host.installationId, pid, {
      // One id per delivery: the Process dedupes by it and runs under it.
      eventId: `${delivery.event.id}:${delivery.consumer}`,
      ...definition.process(delivery.event),
    });
    if ("unavailable" in result) throw new Error(result.message);
    return {
      kind: "delivered",
      runId: result.runId,
      outcome: { pid, queued: result.queued, ...(result.ignored ? { ignored: true } : undefined) },
    };
  }

  /** Why a delivery should not go, read from current state; null while it may. */
  private withdrawal(definition: EventDefinition, event: LoggedEvent, target: EventConsumer): string | null {
    if (this.host.auth.isAccountDisabled(event.ownerUid)) return "the owner's account was removed";
    if (target.kind === "process") {
      const process = this.host.procs.get(target.pid);
      if (!process) return "the process is gone";
      if (this.host.auth.isAccountDisabled(process.uid) || this.host.auth.isAccountDisabled(process.ownerUid)) {
        return "the process's account was removed";
      }
    }
    if (definition.wanted && !definition.wanted(event, this.host.buildKernelContext({ callerOwnerUid: event.ownerUid }))) {
      return "its subject no longer wants it";
    }
    return null;
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
