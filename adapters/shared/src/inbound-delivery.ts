import type { AdapterInboundResult } from "./types";

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

  async enqueue(deliveryId: string, payload: Payload): Promise<void> {
    const normalizedId = requireDeliveryId(deliveryId);
    const key = this.recordKey(normalizedId);
    await this.storage.transaction(async (txn) => {
      if (await txn.get(key)) return;
      const now = Date.now();
      await txn.put(key, {
        payload,
        createdAt: now,
      } satisfies PendingInboundDelivery<Payload>);
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
): boolean {
  if (!result || typeof result !== "object") return false;
  const inbound = result as Partial<AdapterInboundResult>;
  return typeof inbound.ok === "boolean"
    && (inbound.replayed === undefined || inbound.replayed === "completed");
}

function requireDeliveryId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Inbound delivery id is required");
  }
  return normalized;
}
