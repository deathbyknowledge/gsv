import type {
  AdapterInboundResult,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
} from "./types";
import { isAdapterInboundResult } from "../../../packages/gsv/src/protocol/adapters.js";

type PendingInboundDelivery<Payload> = {
  payload: Payload;
  createdAt: number;
};

export type InboundDeliveryDisposition = {
  terminal: boolean;
  error?: string;
};

export type InboundDeliveryAttempt =
  | { state: "completed" }
  | { state: "pending"; error?: string }
  | { state: "active" }
  | { state: "missing" };

const MAX_ERROR_LENGTH = 1_024;

/**
 * Adapter-owned durable handoff for provider ingress.
 *
 * The compact provider payload (never a one-shot body stream) is recorded
 * before the first Gateway RPC and removed only after the Kernel returns a
 * terminal receipt disposition. Scheduling is deliberately left to the
 * adapter Durable Object's existing alarm.
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

  async attempt(
    deliveryId: string,
    deliver: (payload: Payload) => Promise<InboundDeliveryDisposition>,
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
        await this.storage.delete(key);
        return { state: "completed" };
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

  async hasPending(): Promise<boolean> {
    const records = await this.storage.list({ prefix: this.prefix, limit: 1 });
    return records.size > 0;
  }

  private recordKey(deliveryId: string): string {
    return `${this.prefix}${deliveryId}`;
  }
}

/** An in-progress replay is an acknowledgement of ownership, not completion. */
export function isTerminalAdapterInboundResult(
  result: unknown,
): result is AdapterInboundResult {
  return isAdapterInboundResult(result) && result.replayed !== "in_progress";
}

/**
 * Completes the provider-facing half of an inbound handoff.
 *
 * The caller must keep its durable inbound payload until this returns terminal.
 * Stable response delivery ids make replay through the account-local outbound
 * ledger safe after a transport failure or Durable Object restart.
 */
export async function deliverAdapterInboundResponses(
  result: unknown,
  input: {
    surface: AdapterSurface;
    providerMessageId: string;
    send: (message: AdapterOutboundMessage) => Promise<AdapterSendResult>;
  },
): Promise<InboundDeliveryDisposition> {
  if (!isTerminalAdapterInboundResult(result)) {
    return {
      terminal: false,
      error: "Kernel receipt is still in progress",
    };
  }

  const responses: AdapterOutboundMessage[] = [];
  if (result.challenge?.prompt) {
    responses.push({
      deliveryId: result.challenge.deliveryId,
      surface: input.surface,
      text: result.challenge.prompt,
      replyToId: input.providerMessageId,
    });
  }
  if (result.reply?.text) {
    responses.push({
      deliveryId: result.reply.deliveryId,
      surface: input.surface,
      text: result.reply.text,
      replyToId: result.reply.replyToId || input.providerMessageId,
    });
  }

  for (const response of responses) {
    let delivery: AdapterSendResult;
    try {
      delivery = await input.send(response);
    } catch (error) {
      return { terminal: false, error: toErrorMessage(error) };
    }
    if (delivery.ok) continue;
    if (delivery.retryable) {
      return { terminal: false, error: delivery.error };
    }
    console.warn(
      `[Adapter] Inbound response ${response.deliveryId} was not delivered: ${delivery.error}`,
    );
  }

  return { terminal: true };
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
