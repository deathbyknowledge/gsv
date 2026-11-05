import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../../installation/lifecycle";
import type { DurableTaskOptions } from "../../shared/durable-tasks";
import { deliverEventToProcess } from "../../shared/utils";
import type { ChatSend } from "../adapter-delivery";
import type { KernelContext } from "../context";
import type { Kernel } from "../do";
import { ensurePersonalController } from "../personal-controller";
import { deliveryId, parseConsumer, type EventConsumer } from "./consumers";
import { EVENT_REGISTRY, isWithdrawn, type DeliveryEnd, type EventDefinition, type EventRegistry, type PreparedContent } from "./registry";
import { EVENT_BODY_RETENTION_MS, type EventInput, type LoggedEvent, type PendingDelivery } from "./store";

/** What the runtime reaches on its Kernel. */
export type EventRuntimeHost = Pick<
  Kernel,
  | "installationId" | "events" | "auth" | "procs" | "onboarding" | "buildKernelContext" | "schedule" | "cancelSchedule"
  | "responsibilities" | "adapterDelivery"
>;

/** What producers reach through their Kernel context. */
export type KernelEvents = Pick<
  EventRuntime,
  | "append" | "kick" | "deliverNow" | "transaction" | "pending" | "withdraw" | "keyed" | "countSince" | "recent" | "forget"
  | "failedInARow"
>;

/** How a delivery made in its producer's call went; a pending one is the runner's to retry. */
export type InlineDelivery =
  | { state: "delivered"; runId: string | null; queued: boolean }
  | { state: "withdrawn"; reason: string }
  | { state: "pending" };

/** A Process delivery retries without limit: 2 s, doubling to 256 s. */
const PROCESS_RETRY = { baseMs: 2_000, capMs: 256_000 };
/**
 * A chat send retries a blip twice, after 2 s and then 8 s, and then ends unsent for its producer
 * to follow up. A send that may have reached the chat never retries, so a message can't arrive twice.
 */
const CHAT_RETRY_DELAYS_MS = [2_000, 8_000];
/** A pass that throws is tried again after this long. */
const FAILED_PASS_RETRY_MS = 60_000;
/** Retention runs once something is due, at most this often. */
const PRUNE_SPACING_MS = 60 * 60_000;

type AttemptResult =
  | { kind: "delivered"; runId: string | null; outcome: JsonObject; responsibilities?: { ledgerRevision: number; ids: string[] } }
  | { kind: "withdrawn"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "unsent"; failure: Exclude<ChatSend, { state: "sent" }> };

/** Appends Kernel events and delivers them: one task, one gate check, one retry rule per kind of consumer. */
export class EventRuntime {
  private running: Promise<void> | null = null;
  /** When retention next has work, read from the log once; null until then. Events appended or settled since only bring it forward. */
  private retention: { dueAt: number | null; ranAt: number } | null = null;

  constructor(
    private readonly host: EventRuntimeHost,
    private readonly registry: EventRegistry = EVENT_REGISTRY,
  ) {}

  /** Appends an event and its deliveries once per type and key. Call inside the producer's transaction, then `kick`. */
  append(input: EventInput): LoggedEvent {
    const definition = this.registry[input.type];
    if (!definition) throw new Error(`Event type ${input.type} is not registered`);
    const { event } = this.host.events.append(input, definition.routes(input), Date.now());
    this.retainUntil(event);
    return event;
  }

  /** Arms the runner for whatever the log has due next; call after the producer's transaction commits. */
  async kick(): Promise<void> {
    await this.arm(this.nextRunAt());
  }

  /** Runs a producer's domain write and its append as one transaction. */
  transaction<T>(operation: () => T): T {
    return this.host.events.transaction(operation);
  }

  /**
   * Delivers an event to one consumer in its producer's call, as a request path needs, then
   * kicks the runner. Call after the append commits. A delivery behind an older one in its
   * lane, or one the gate holds, waits for the runner, which also retries a failed attempt.
   * A producer that already holds what the delivery's `prepare` reads hands it over as
   * `held`, so this attempt skips the read; a retry reads it again.
   */
  async deliverNow(event: LoggedEvent, consumer: string, held?: PreparedContent): Promise<InlineDelivery> {
    const due = this.host.events.dueDelivery(event.seq, consumer, Date.now());
    if (due && (await this.host.onboarding.managedWorkGate()).allowed) await this.attempt(due, held);
    await this.kick();
    const record = this.host.events.delivery(event.seq, consumer);
    if (record?.state === "delivered") return { state: "delivered", runId: record.runId, queued: record.outcome?.queued === true };
    if (record?.state === "withdrawn" || record?.state === "failed") return { state: "withdrawn", reason: record.lastError ?? "withdrawn" };
    return { state: "pending" };
  }

  /** Pending deliveries of one type about one subject, oldest first. */
  pending(type: string, subject: string): PendingDelivery[] {
    return this.host.events.pending(type, subject);
  }

  /** Ends a pending delivery its producer no longer wants to go, without a call. */
  withdraw(delivery: PendingDelivery, reason: string): void {
    this.host.events.withdrawn(delivery.event.seq, delivery.consumer, reason, Date.now());
    this.retainUntil(delivery.event);
  }

  /** The event a producer appended under one key, while the log keeps it. */
  keyed(type: string, key: string): LoggedEvent | null {
    return this.host.events.keyed(type, key);
  }

  /** How many events of one type an owner's producers appended after a time. */
  countSince(type: string, ownerUid: number, since: number): number {
    return this.host.events.countSince(type, ownerUid, since);
  }

  /** The newest events of one type that still have their bodies, about one subject or for one owner. */
  recent(type: string, of: { subject: string } | { ownerUid: number }, limit: number): LoggedEvent[] {
    return this.host.events.recent(type, of, limit);
  }

  /** Deletes one subject's events of a type with their deliveries, as when what they came from is removed. */
  forget(type: string, subject: string): void {
    this.host.events.forget(type, subject);
  }

  /** How many of a consumer's latest ended deliveries failed in a row, counting at most `limit`. */
  failedInARow(consumer: string, limit: number): number {
    return this.host.events.failedInARow(consumer, limit);
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
    } catch (error) {
      // A kick during the pass found this task, so the runner must stay armed.
      console.warn("[Kernel] Event pass failed; trying again in a minute:", error instanceof Error ? error.message : String(error));
      await this.arm(Date.now() + FAILED_PASS_RETRY_MS, task.id);
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
    this.pruneWhenDue(Date.now());
    // Lanes run concurrently, each one row at a time and in order; every lane ends before the pass does.
    const drained = await Promise.allSettled(this.host.events.dueHeads(Date.now()).map((head) => this.drain(head)));
    const failure = drained.find((outcome) => outcome.status === "rejected");
    if (failure) throw failure.reason;
    await this.arm(this.nextRunAt(), taskId);
  }

  private async drain(head: PendingDelivery): Promise<void> {
    for (let next: PendingDelivery | null = head; next;) {
      if (!await this.attempt(next)) return;
      next = next.lane === null ? null : this.host.events.dueHead(next.consumer, next.lane, Date.now());
    }
  }

  /** Makes one attempt; true once the delivery has ended and its lane may move on. */
  private async attempt(delivery: PendingDelivery, held?: PreparedContent): Promise<boolean> {
    const { event, consumer } = delivery;
    const definition = this.registry[event.type];
    const target = parseConsumer(consumer);
    if (!definition || !target) {
      const error = definition ? `Event consumer ${consumer} is not known` : `Event type ${event.type} is not registered`;
      this.host.events.failed(event.seq, consumer, error, null, Date.now());
      this.retainUntil(event);
      console.warn(`[Kernel] Ended event delivery ${event.id} to ${consumer}: ${error}`);
      return true;
    }
    const ctx = this.host.buildKernelContext({ callerOwnerUid: event.ownerUid });
    let result: AttemptResult;
    try {
      result = await this.deliver(definition, delivery, target, ctx, held);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (target.kind !== "chat") {
        const retryAt = Date.now() + Math.min(PROCESS_RETRY.capMs, PROCESS_RETRY.baseMs * 2 ** delivery.attemptCount);
        this.host.events.failed(event.seq, consumer, message, retryAt, Date.now());
        console.warn(`[Kernel] Event delivery ${event.id} to ${consumer} failed:`, message);
        return false;
      }
      // Nothing was handed to the chat's messenger, so its rule retries this as a blip.
      result = { kind: "unsent", failure: { state: "retryable", stage: "route", error: message, diagnostics: exceptionDiagnostics(error) } };
    }
    let end: DeliveryEnd;
    if (result.kind === "unsent") {
      const { failure } = result;
      const retryIn = failure.state === "retryable" ? CHAT_RETRY_DELAYS_MS[delivery.attemptCount] : undefined;
      const now = Date.now();
      this.host.events.failed(event.seq, consumer, failure.error, retryIn === undefined ? null : now + retryIn, now);
      if (retryIn !== undefined) return false;
      end = {
        state: "failed",
        reason: failure.error,
        unsent: {
          outcome: failure.state === "retryable" ? "exhausted" : failure.state,
          attempts: delivery.attemptCount + 1,
          stage: failure.stage,
          ...(failure.diagnostics === undefined ? undefined : { diagnostics: failure.diagnostics }),
        },
      };
    } else if (result.kind === "withdrawn") {
      this.host.events.withdrawn(event.seq, consumer, result.reason, Date.now());
      end = { state: "withdrawn", reason: result.reason };
    } else if (result.kind === "refused") {
      // Its Process can never take it, so another attempt would only be refused again.
      this.host.events.failed(event.seq, consumer, result.reason, null, Date.now());
      console.warn(`[Kernel] Event delivery ${event.id} to ${consumer} was refused:`, result.reason);
      end = { state: "failed", reason: result.reason };
    } else {
      const { responsibilities } = result;
      const now = Date.now();
      this.host.events.transaction(() => {
        this.host.events.delivered(event.seq, consumer, result, now);
        // The ledger's recovery wake covers a run that never settles what it was handed.
        if (responsibilities) this.host.responsibilities.markEventDelivered(event.ownerUid, responsibilities.ids, now);
      });
      end = { state: "delivered", ignored: result.outcome.ignored === true };
    }
    this.retainUntil(event);
    if (definition.settled) {
      try {
        await definition.settled(event, ctx, end);
      } catch (error) {
        // The delivery stands; the producer's own recovery, at the latest the next start-up, catches up.
        console.warn(`[Kernel] Event ${event.id} settled, but its producer could not follow up:`, error instanceof Error ? error.message : String(error));
      }
    }
    return true;
  }

  /** Delivers once; the Process call or chat send is made synchronously after the last withdrawal check. */
  private async deliver(
    definition: EventDefinition<PreparedContent | undefined>, delivery: PendingDelivery, target: EventConsumer, ctx: KernelContext,
    held?: PreparedContent,
  ): Promise<AttemptResult> {
    const { event } = delivery;
    const early = this.withdrawal(definition, delivery, target, ctx);
    if (early) return { kind: "withdrawn", reason: early };
    // Read before finding the Ship, so content that is gone never starts one.
    const prepared = held ?? (definition.prepare ? await definition.prepare(event, ctx) : undefined);
    if (isWithdrawn(prepared)) return { kind: "withdrawn", reason: prepared.withdrawn };
    if (target.kind === "chat") {
      const late = this.withdrawal(definition, delivery, target, ctx);
      if (late) return { kind: "withdrawn", reason: late };
      if (!definition.present) return { kind: "refused", reason: `Event type ${event.type} has nothing for a chat` };
      const message = definition.present(event, prepared, ctx);
      if (isWithdrawn(message)) return { kind: "withdrawn", reason: message.withdrawn };
      const sent = await this.host.adapterDelivery.sendToChat(message);
      return sent.state === "sent" ? { kind: "delivered", runId: null, outcome: {} } : { kind: "unsent", failure: sent };
    }
    const pid = target.kind === "process" ? target.pid : await ensurePersonalController(target.ownerUid, ctx);
    const late = this.withdrawal(definition, delivery, target, ctx);
    if (late) return { kind: "withdrawn", reason: late };
    if (!definition.admit) return { kind: "refused", reason: `Event type ${event.type} has nothing for a process` };
    const eventId = delivery.legacyId ?? deliveryId(event.id, delivery.consumer);
    const admitted = definition.admit(event, prepared, ctx, eventId);
    if (isWithdrawn(admitted)) return { kind: "withdrawn", reason: admitted.withdrawn };
    const result = await deliverEventToProcess(this.host.installationId, pid, { eventId, ...admitted });
    if ("unavailable" in result) throw new Error(result.message);
    if (result.refused !== undefined) return { kind: "refused", reason: result.refused };
    const responsibilities = "event" in admitted ? admitted.responsibilities : undefined;
    return {
      kind: "delivered",
      runId: result.runId,
      outcome: { pid, queued: result.queued, ...(result.ignored ? { ignored: true } : undefined) },
      ...(responsibilities ? { responsibilities } : undefined),
    };
  }

  /**
   * Why a delivery should not go, read from current state; null while it may. Removing an
   * account fences deliveries with no failed attempt. One whose attempt failed may have
   * reached its Process, so it retries until it ends, and the Process dedupes it. An attempt
   * cut off before it recorded anything counts as fresh.
   */
  private withdrawal(
    definition: EventDefinition<PreparedContent | undefined>, { event, attemptCount }: PendingDelivery, target: EventConsumer, ctx: KernelContext,
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
    const due = [this.host.events.nextDueAt(), this.retentionDueAt()].filter((at): at is number => at !== null);
    return due.length ? Math.min(...due) : null;
  }

  private retentionDueAt(): number | null {
    this.retention ??= { dueAt: this.host.events.nextPruneAt(), ranAt: 0 };
    const { dueAt, ranAt } = this.retention;
    return dueAt === null ? null : Math.max(dueAt, ranAt + PRUNE_SPACING_MS);
  }

  private pruneWhenDue(now: number): void {
    const due = this.retentionDueAt();
    if (due === null || due > now) return;
    this.host.events.prune(now);
    this.retention = { dueAt: this.host.events.nextPruneAt(), ranAt: now };
  }

  /** An event appended or settled may bring retention forward; a body is kept 30 days from its append. */
  private retainUntil(event: LoggedEvent): void {
    if (!this.retention) return;
    const at = event.createdAt + EVENT_BODY_RETENTION_MS;
    this.retention.dueAt = this.retention.dueAt === null ? at : Math.min(this.retention.dueAt, at);
  }

  /** Keeps one pending task, moved earlier when a delivery falls due sooner. */
  private async arm(at: number | null, excludeTaskId?: string): Promise<void> {
    if (at === null) return;
    // Task times are whole seconds, rounded down, so a later deadline is armed for the second after
    // it: an alarm before the deadline would find nothing due and arm again at once until it passed.
    const now = Date.now();
    const due = at <= now ? now : Math.ceil(at / 1_000) * 1_000;
    const options: DurableTaskOptions = excludeTaskId ? { idempotent: true, excludeTaskId } : { idempotent: true };
    const existing = await this.host.schedule(new Date(due), "onEvents", null, options);
    // Task times are whole seconds; a pending task due no later than this one stands.
    if (existing.time * 1_000 <= due + 1_000) return;
    await this.host.cancelSchedule(existing.id);
    await this.host.schedule(new Date(due), "onEvents", null, options);
  }
}
