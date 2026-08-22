import type {
  AdapterInboundResult,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
} from "./types";
import { shouldReplaceAlarm } from "./alarm";

export type PendingInboundResponse<ResponseContext = never> = {
  message: AdapterOutboundMessage;
  expiresAt?: number;
  context?: ResponseContext;
};

type PendingInboundDelivery<Payload, ResponseContext> =
  | {
      state: "provider";
      payload: Payload;
      createdAt: number;
    }
  | {
      state: "responses";
      responses: PendingInboundResponse<ResponseContext>[];
      /** Number of provider-delivery rounds durably started. */
      attempt: number;
      createdAt: number;
    }
  | {
      state: "completed";
      createdAt: number;
      expiresAt: number;
    };

export type InboundDeliveryDisposition<ResponseContext = never> = {
  terminal: boolean;
  error?: string;
  responses?: PendingInboundResponse<ResponseContext>[];
};

type InboundDeliveryAttempt =
  | { state: "completed" }
  | { state: "pending"; error?: string }
  | { state: "active" }
  | { state: "missing" };

const MAX_ERROR_LENGTH = 1_024;
const MAX_RESPONSE_DELIVERY_ATTEMPTS = 10;

/**
 * Adapter-owned durable handoff for provider ingress.
 *
 * The compact provider payload (never a one-shot body stream) is recorded
 * before the first Gateway RPC. A terminal Kernel result atomically advances
 * that record to normalized outbound responses before provider delivery. A
 * response retry therefore never re-enters the Kernel or renormalizes actor
 * identity. Scheduling uses the adapter Durable Object's existing alarm.
 */
export class InboundDeliveryLedger<Payload, ResponseContext = never> {
  private readonly active = new Set<string>();
  private resetGeneration = 0;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly prefix: string,
    private readonly options: {
      completedRetentionMs?: number;
      maxRecords?: number;
      pendingOrder?: "created" | "key";
    } = {},
  ) {
    if (!prefix) {
      throw new Error("Inbound delivery prefix is required");
    }
  }

  async enqueueAndArm(
    deliveryId: string,
    payload: Payload,
    alarmAt: number,
  ): Promise<void> {
    const normalizedId = requireDeliveryId(deliveryId);
    const normalizedAlarmAt = requireAlarmTime(alarmAt);
    const key = this.recordKey(normalizedId);
    await this.storage.transaction(async (txn) => {
      const now = Date.now();
      const records = this.options.maxRecords
        ? await txn.list<PendingInboundDelivery<Payload, ResponseContext>>({ prefix: this.prefix })
        : null;
      if (records) {
        const expired = [...records.entries()]
          .filter(([, record]) => record.state === "completed" && record.expiresAt <= now)
          .map(([recordKey]) => recordKey);
        if (expired.length > 0) await txn.delete(expired);
        if (
          !records.has(key)
          && records.size - expired.length >= (this.options.maxRecords ?? Infinity)
        ) {
          throw new Error("Inbound delivery ledger is at capacity");
        }
      }
      const existing = await txn.get<PendingInboundDelivery<Payload, ResponseContext>>(key);
      if (existing?.state === "completed" && existing.expiresAt <= now) {
        await txn.delete(key);
      }
      if (!existing || (existing.state === "completed" && existing.expiresAt <= now)) {
        await txn.put(key, {
          state: "provider",
          payload,
          createdAt: now,
        } satisfies PendingInboundDelivery<Payload, ResponseContext>);
      }
      const currentAlarm = await txn.getAlarm();
      if (shouldReplaceAlarm(currentAlarm, normalizedAlarmAt, now)) {
        await txn.setAlarm(normalizedAlarmAt);
      }
    });
  }

  async arm(alarmAt: number): Promise<void> {
    const normalizedAlarmAt = requireAlarmTime(alarmAt);
    await this.storage.transaction(async (txn) => {
      const now = Date.now();
      const currentAlarm = await txn.getAlarm();
      if (shouldReplaceAlarm(currentAlarm, normalizedAlarmAt, now)) {
        await txn.setAlarm(normalizedAlarmAt);
      }
    });
  }

  async armIfPending(alarmAt: number): Promise<boolean> {
    const normalizedAlarmAt = requireAlarmTime(alarmAt);
    return await this.storage.transaction(async (txn) => {
      const now = Date.now();
      const records = await txn.list<PendingInboundDelivery<Payload, ResponseContext>>({
        prefix: this.prefix,
      });
      const expired = [...records.entries()]
        .filter(([, record]) => record.state === "completed" && record.expiresAt <= now)
        .map(([key]) => key);
      if (expired.length > 0) await txn.delete(expired);
      const hasPending = [...records.entries()].some(
        ([key, record]) => !expired.includes(key) && record.state !== "completed",
      );
      if (!hasPending) return false;
      const currentAlarm = await txn.getAlarm();
      if (shouldReplaceAlarm(currentAlarm, normalizedAlarmAt, now)) {
        await txn.setAlarm(normalizedAlarmAt);
      }
      return true;
    });
  }

  /** Drops every pending handoff and fences attempts started before the reset. */
  async clear(): Promise<number> {
    this.resetGeneration += 1;
    return await this.storage.transaction(async (txn) => {
      const records = await txn.list({ prefix: this.prefix });
      const keys = [...records.keys()];
      if (keys.length > 0) await txn.delete(keys);
      return keys.length;
    });
  }

  async attempt(
    deliveryId: string,
    deliver: (
      payload: Payload,
    ) => Promise<InboundDeliveryDisposition<ResponseContext>>,
    send?: (
      message: AdapterOutboundMessage,
      context: ResponseContext | undefined,
    ) => Promise<AdapterSendResult>,
  ): Promise<InboundDeliveryAttempt> {
    const normalizedId = requireDeliveryId(deliveryId);
    if (this.active.has(normalizedId)) {
      return { state: "active" };
    }

    this.active.add(normalizedId);
    const resetGeneration = this.resetGeneration;
    try {
      const key = this.recordKey(normalizedId);
      const pending = await this.storage.get<
        PendingInboundDelivery<Payload, ResponseContext>
      >(key);
      if (!pending) {
        return { state: "missing" };
      }
      if (pending.state === "completed") {
        if (pending.expiresAt > Date.now()) return { state: "completed" };
        await this.storage.delete(key);
        return { state: "missing" };
      }

      if (pending.state === "responses") {
        return await this.deliverResponses(key, pending, send, resetGeneration);
      }

      let disposition: InboundDeliveryDisposition<ResponseContext>;
      try {
        disposition = await deliver(pending.payload);
      } catch (error) {
        disposition = {
          terminal: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (resetGeneration !== this.resetGeneration) {
        await this.storage.delete(key);
        return { state: "completed" };
      }

      if (disposition.terminal) {
        const responses = disposition.responses ?? [];
        if (responses.length === 0) {
          await this.completeRecord(key, pending.createdAt);
          return { state: "completed" };
        }
        const responseState: PendingInboundDelivery<Payload, ResponseContext> = {
          state: "responses",
          responses,
          attempt: 0,
          createdAt: pending.createdAt,
        };
        await this.storage.put(key, responseState);
        return await this.deliverResponses(key, responseState, send, resetGeneration);
      }

      const error = disposition.error?.slice(0, MAX_ERROR_LENGTH);
      const result: InboundDeliveryAttempt = { state: "pending" };
      if (error) result.error = error;
      return result;
    } finally {
      this.active.delete(normalizedId);
    }
  }

  async pendingIds(limit = 100): Promise<string[]> {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const records = await this.storage.list<
      PendingInboundDelivery<Payload, ResponseContext>
    >({
      prefix: this.prefix,
    });
    return [...records.entries()]
      .filter(([, record]) => record.state !== "completed")
      .sort(([leftKey, left], [rightKey, right]) => this.options.pendingOrder === "key"
        ? leftKey.localeCompare(rightKey)
        : left.createdAt - right.createdAt || leftKey.localeCompare(rightKey))
      .slice(0, normalizedLimit)
      .map(([key]) => key.slice(this.prefix.length));
  }

  private recordKey(deliveryId: string): string {
    return `${this.prefix}${deliveryId}`;
  }

  private async deliverResponses(
    key: string,
    pending: Extract<
      PendingInboundDelivery<Payload, ResponseContext>,
      { state: "responses" }
    >,
    send: ((
      message: AdapterOutboundMessage,
      context: ResponseContext | undefined,
    ) => Promise<AdapterSendResult>) | undefined,
    resetGeneration: number,
  ): Promise<InboundDeliveryAttempt> {
    if (resetGeneration !== this.resetGeneration) {
      await this.completeRecord(key, pending.createdAt);
      return { state: "completed" };
    }
    if (!send) {
      return { state: "pending", error: "Adapter response delivery is unavailable" };
    }
    if (pending.attempt >= MAX_RESPONSE_DELIVERY_ATTEMPTS) {
      console.warn(JSON.stringify({
        component: "adapter",
        event: "inbound_response_retries_exhausted",
        attempts: pending.attempt,
      }));
      await this.completeRecord(key, pending.createdAt);
      return { state: "completed" };
    }

    // Count the round before provider I/O. A crash can consume an attempt, but
    // cannot exceed the durable retry bound.
    const attempted = {
      ...pending,
      attempt: pending.attempt + 1,
    } satisfies PendingInboundDelivery<Payload, ResponseContext>;
    await this.storage.put(key, attempted);

    let retryError: string | undefined;
    for (const response of attempted.responses) {
      if (resetGeneration !== this.resetGeneration) break;
      if (response.expiresAt !== undefined && response.expiresAt <= Date.now()) {
        console.warn(JSON.stringify({
          component: "adapter",
          event: "inbound_response_expired",
        }));
        continue;
      }

      let delivery: AdapterSendResult;
      try {
        delivery = await send(response.message, response.context);
      } catch (error) {
        retryError ??= toErrorMessage(error);
        continue;
      }
      if (delivery.ok) continue;
      if (delivery.retryable) {
        retryError ??= delivery.error;
        continue;
      }
      console.warn(JSON.stringify({
        component: "adapter",
        event: "inbound_response_rejected",
      }));
    }

    if (resetGeneration !== this.resetGeneration) {
      await this.completeRecord(key, pending.createdAt);
      return { state: "completed" };
    }

    if (
      retryError !== undefined
      && attempted.attempt < MAX_RESPONSE_DELIVERY_ATTEMPTS
    ) {
      const detail = retryError.slice(0, MAX_ERROR_LENGTH);
      const result: InboundDeliveryAttempt = { state: "pending" };
      if (detail) result.error = detail;
      return result;
    }
    if (retryError !== undefined) {
      console.warn(JSON.stringify({
        component: "adapter",
        event: "inbound_response_retries_exhausted",
        attempts: attempted.attempt,
      }));
    }
    await this.completeRecord(key, pending.createdAt);
    return { state: "completed" };
  }

  private async completeRecord(key: string, createdAt: number): Promise<void> {
    const retentionMs = this.options.completedRetentionMs ?? 0;
    if (retentionMs <= 0) {
      await this.storage.delete(key);
      return;
    }
    await this.storage.put(key, {
      state: "completed",
      createdAt,
      expiresAt: Date.now() + retentionMs,
    } satisfies PendingInboundDelivery<Payload, ResponseContext>);
  }
}

/** An in-progress replay is an acknowledgement of ownership, not completion. */
export function isTerminalAdapterInboundResult(
  result: AdapterInboundResult,
): boolean {
  return result.replayed !== "in_progress";
}

/** Converts a terminal Kernel result into durable, provider-ready responses. */
export function adapterInboundResultDisposition(
  result: AdapterInboundResult,
  input: {
    surface: AdapterSurface;
    providerMessageId: string;
    actorId?: string;
  },
): InboundDeliveryDisposition {
  if (!isTerminalAdapterInboundResult(result)) {
    return {
      terminal: false,
      error: "Kernel receipt is still in progress",
    };
  }

  const responses: PendingInboundResponse[] = [];
  if (result.challenge?.prompt) {
    const message: AdapterOutboundMessage = {
      deliveryId: result.challenge.deliveryId,
      surface: input.surface,
      text: result.challenge.prompt,
      replyToId: input.providerMessageId,
    };
    if (input.actorId) message.actorId = input.actorId;
    responses.push({
      message,
      expiresAt: result.challenge.expiresAt,
    });
  }
  if (result.reply?.text) {
    const message: AdapterOutboundMessage = {
      deliveryId: result.reply.deliveryId,
      surface: input.surface,
      text: result.reply.text,
      replyToId: result.reply.replyToId || input.providerMessageId,
    };
    if (input.actorId) message.actorId = input.actorId;
    responses.push({
      message,
    });
  }
  const disposition: InboundDeliveryDisposition = { terminal: true };
  if (responses.length > 0) disposition.responses = responses;
  return disposition;
}

function requireDeliveryId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Inbound delivery id is required");
  }
  return normalized;
}

function requireAlarmTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Inbound delivery alarm time must be a non-negative number");
  }
  return value;
}

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
