import type {
  AdapterInboundResult,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
} from "./types";
import { isAdapterInboundResult } from "../../../packages/gsv/src/protocol/adapters.js";

type PendingInboundResponse = {
  message: AdapterOutboundMessage;
  expiresAt?: number;
};

type PendingInboundDelivery<Payload> =
  | {
      state: "provider";
      payload: Payload;
      createdAt: number;
    }
  | {
      state: "responses";
      responses: PendingInboundResponse[];
      /** Number of provider-delivery rounds durably started. */
      attempt: number;
      createdAt: number;
    };

type InboundDeliveryDisposition = {
  terminal: boolean;
  error?: string;
  responses?: PendingInboundResponse[];
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
export class InboundDeliveryLedger<Payload> {
  private readonly active = new Set<string>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly prefix: string,
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
      if (!await txn.get(key)) {
        await txn.put(key, {
          state: "provider",
          payload,
          createdAt: Date.now(),
        } satisfies PendingInboundDelivery<Payload>);
      }
      const currentAlarm = await txn.getAlarm();
      if (currentAlarm === null || currentAlarm > normalizedAlarmAt) {
        await txn.setAlarm(normalizedAlarmAt);
      }
    });
  }

  async arm(alarmAt: number): Promise<void> {
    const normalizedAlarmAt = requireAlarmTime(alarmAt);
    await this.storage.transaction(async (txn) => {
      const currentAlarm = await txn.getAlarm();
      if (currentAlarm === null || currentAlarm > normalizedAlarmAt) {
        await txn.setAlarm(normalizedAlarmAt);
      }
    });
  }

  async armIfPending(alarmAt: number): Promise<boolean> {
    const normalizedAlarmAt = requireAlarmTime(alarmAt);
    return await this.storage.transaction(async (txn) => {
      const pending = await txn.list({ prefix: this.prefix, limit: 1 });
      if (pending.size === 0) return false;
      const currentAlarm = await txn.getAlarm();
      if (currentAlarm === null || currentAlarm > normalizedAlarmAt) {
        await txn.setAlarm(normalizedAlarmAt);
      }
      return true;
    });
  }

  async attempt(
    deliveryId: string,
    deliver: (payload: Payload) => Promise<InboundDeliveryDisposition>,
    send?: (message: AdapterOutboundMessage) => Promise<AdapterSendResult>,
  ): Promise<InboundDeliveryAttempt> {
    const normalizedId = requireDeliveryId(deliveryId);
    if (this.active.has(normalizedId)) {
      return { state: "active" };
    }

    this.active.add(normalizedId);
    try {
      const key = this.recordKey(normalizedId);
      const pending = await this.storage.get<PendingInboundDelivery<Payload>>(key);
      if (!pending) {
        return { state: "missing" };
      }

      if (pending.state === "responses") {
        return await this.deliverResponses(key, pending, send);
      }

      let disposition: InboundDeliveryDisposition;
      try {
        disposition = await deliver(pending.payload);
      } catch (error) {
        disposition = {
          terminal: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (disposition.terminal) {
        const responses = disposition.responses ?? [];
        if (responses.length === 0) {
          await this.storage.delete(key);
          return { state: "completed" };
        }
        const responseState: PendingInboundDelivery<Payload> = {
          state: "responses",
          responses,
          attempt: 0,
          createdAt: pending.createdAt,
        };
        await this.storage.put(key, responseState);
        return await this.deliverResponses(key, responseState, send);
      }

      const error = disposition.error?.slice(0, MAX_ERROR_LENGTH);
      return { state: "pending", ...(error ? { error } : {}) };
    } finally {
      this.active.delete(normalizedId);
    }
  }

  async pendingIds(limit = 100): Promise<string[]> {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const records = await this.storage.list<PendingInboundDelivery<Payload>>({
      prefix: this.prefix,
      limit: normalizedLimit,
    });
    return [...records.entries()]
      .sort(([leftKey, left], [rightKey, right]) =>
        left.createdAt - right.createdAt
        || leftKey.localeCompare(rightKey)
      )
      .map(([key]) => key.slice(this.prefix.length));
  }

  private recordKey(deliveryId: string): string {
    return `${this.prefix}${deliveryId}`;
  }

  private async deliverResponses(
    key: string,
    pending: Extract<PendingInboundDelivery<Payload>, { state: "responses" }>,
    send: ((message: AdapterOutboundMessage) => Promise<AdapterSendResult>) | undefined,
  ): Promise<InboundDeliveryAttempt> {
    if (!send) {
      return { state: "pending", error: "Adapter response delivery is unavailable" };
    }
    if (pending.attempt >= MAX_RESPONSE_DELIVERY_ATTEMPTS) {
      console.warn(
        `[Adapter] Inbound responses stopped after ${pending.attempt} attempts`,
      );
      await this.storage.delete(key);
      return { state: "completed" };
    }

    // Count the round before provider I/O. A crash can consume an attempt, but
    // cannot exceed the durable retry bound.
    const attempted = {
      ...pending,
      attempt: pending.attempt + 1,
    } satisfies PendingInboundDelivery<Payload>;
    await this.storage.put(key, attempted);

    let retryError: string | undefined;
    for (const response of attempted.responses) {
      if (response.expiresAt !== undefined && response.expiresAt <= Date.now()) {
        console.warn(
          `[Adapter] Inbound response ${response.message.deliveryId} expired before delivery`,
        );
        continue;
      }

      let delivery: AdapterSendResult;
      try {
        delivery = await send(response.message);
      } catch (error) {
        retryError ??= toErrorMessage(error);
        continue;
      }
      if (delivery.ok) continue;
      if (delivery.retryable) {
        retryError ??= delivery.error;
        continue;
      }
      console.warn(
        `[Adapter] Inbound response ${response.message.deliveryId} was not delivered: ${delivery.error}`,
      );
    }

    if (
      retryError !== undefined
      && attempted.attempt < MAX_RESPONSE_DELIVERY_ATTEMPTS
    ) {
      const detail = retryError.slice(0, MAX_ERROR_LENGTH);
      return { state: "pending", ...(detail ? { error: detail } : {}) };
    }
    if (retryError !== undefined) {
      console.warn(
        `[Adapter] Inbound responses stopped after ${attempted.attempt} attempts: ${retryError}`,
      );
    }
    await this.storage.delete(key);
    return { state: "completed" };
  }
}

/** An in-progress replay is an acknowledgement of ownership, not completion. */
export function isTerminalAdapterInboundResult(
  result: unknown,
): result is AdapterInboundResult {
  return isAdapterInboundResult(result) && result.replayed !== "in_progress";
}

/** Converts a terminal Kernel result into durable, provider-ready responses. */
export function adapterInboundResultDisposition(
  result: unknown,
  input: {
    surface: AdapterSurface;
    providerMessageId: string;
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
    responses.push({
      message: {
        deliveryId: result.challenge.deliveryId,
        surface: input.surface,
        text: result.challenge.prompt,
        replyToId: input.providerMessageId,
      },
      expiresAt: result.challenge.expiresAt,
    });
  }
  if (result.reply?.text) {
    responses.push({
      message: {
        deliveryId: result.reply.deliveryId,
        surface: input.surface,
        text: result.reply.text,
        replyToId: result.reply.replyToId || input.providerMessageId,
      },
    });
  }
  return { terminal: true, ...(responses.length > 0 ? { responses } : {}) };
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
