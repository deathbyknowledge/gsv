import type {
  AdapterDeliveryClaimArgs,
  AdapterDeliveryReportArgs,
} from "../../../packages/gsv/src/protocol/syscalls/adapter.js";
import type {
  AdapterPeerDeliveryContext,
  AdapterPeerSignalFrame,
  AdapterInstallationContext,
  AdapterSendResult,
  BinaryBody,
} from "./types";
import { shouldReplaceAlarm } from "./alarm";
import { callAdapterGateway, type AdapterGatewayBinding } from "./gateway-rpc";
import { cancelBinaryBody, validateAdapterMediaBody } from "./media-body";

export type AdapterPeerSignalDelivery = {
  installation: AdapterInstallationContext;
  context: AdapterPeerDeliveryContext;
  frame: AdapterPeerSignalFrame;
};

export type AdapterPeerDeliveryOutcome = Pick<
  AdapterDeliveryReportArgs,
  "state" | "messageId" | "error" | "attempts"
>;

type StoredBody = {
  stageId: string;
  chunks: number;
  length: number;
};

type PendingRecord = {
  state: "pending";
  fingerprint: string;
  delivery: AdapterPeerSignalDelivery;
  body?: StoredBody;
  attempts: number;
  createdAt: number;
};

type ReportingRecord = {
  state: "reporting";
  fingerprint: string;
  delivery: AdapterPeerSignalDelivery;
  body?: StoredBody;
  outcome: AdapterPeerDeliveryOutcome;
  createdAt: number;
};

type CompletedRecord = {
  state: "completed";
  fingerprint: string;
  outcome?: AdapterPeerDeliveryOutcome;
  createdAt: number;
  expiresAt: number;
};

type DeliveryRecord = PendingRecord | ReportingRecord | CompletedRecord;

type StagingRecord = {
  deliveryId: string;
  createdAt: number;
};

export type AdapterPeerDeliveryAttemptHandlers = {
  claim(delivery: AdapterPeerSignalDelivery): Promise<boolean>;
  deliver(
    delivery: AdapterPeerSignalDelivery,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
  report(
    delivery: AdapterPeerSignalDelivery,
    outcome: AdapterPeerDeliveryOutcome,
  ): Promise<void>;
};

export const ADAPTER_PEER_DELIVERY_RECORD_PREFIX = "peer_delivery:v1:record:";
export const ADAPTER_PEER_DELIVERY_PENDING_KEY = "peer_delivery:v1:pending";
const RECORD_PREFIX = ADAPTER_PEER_DELIVERY_RECORD_PREFIX;
const STAGING_PREFIX = "peer_delivery:v1:stage:";
const BODY_PREFIX = "peer_delivery:v1:body:";
const BODY_CHUNK_BYTES = 128 * 1024;
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STAGING_RETENTION_MS = 60 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 10;

/**
 * Durable adapter-owned queue for routed protocol signals. Acceptance stores
 * the exact signal, trusted route projection, and body bytes before returning
 * to the Kernel. Provider delivery and outcome reporting then survive eviction.
 */
export class AdapterPeerDeliveryQueue {
  private readonly active = new Set<string>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly retryDelayMs = 10_000,
  ) {}

  async enqueueAndArm(
    delivery: AdapterPeerSignalDelivery,
    body: BinaryBody | undefined,
    alarmAt: number,
  ): Promise<void> {
    const deliveryId = requireDeliveryId(delivery.context.deliveryId);
    validateAdapterMediaBody(delivery.context.media, body, {
      maxBytes: 48 * 1024 * 1024,
      maxPartBytes: 48 * 1024 * 1024,
    });

    const stageId = crypto.randomUUID();
    const stageKey = `${STAGING_PREFIX}${stageId}`;
    await this.storage.transaction(async (txn) => {
      const now = Date.now();
      await txn.put(stageKey, { deliveryId, createdAt: now } satisfies StagingRecord);
      const current = await txn.getAlarm();
      if (shouldReplaceAlarm(current, alarmAt, now)) await txn.setAlarm(alarmAt);
    });

    let storedBody: StoredBody | undefined;
    try {
      storedBody = await this.storeBody(stageId, body);
      const fingerprint = await deliveryFingerprint(delivery, storedBody, this.storage);
      let duplicate = false;
      await this.storage.transaction(async (txn) => {
        const key = recordKey(deliveryId);
        const now = Date.now();
        const existing = await txn.get<DeliveryRecord>(key);
        let pending = false;
        if (existing && (existing.state !== "completed" || existing.expiresAt > now)) {
          if (existing.fingerprint !== fingerprint) {
            throw new Error("Adapter deliveryId is already bound to a different signal");
          }
          duplicate = true;
          pending = existing.state !== "completed";
        } else {
          const record: PendingRecord = {
            state: "pending",
            fingerprint,
            delivery,
            attempts: 0,
            createdAt: now,
          };
          if (storedBody) record.body = storedBody;
          await txn.put(key, record);
          pending = true;
        }
        if (pending) {
          await txn.put(ADAPTER_PEER_DELIVERY_PENDING_KEY, true);
          // The staging alarm can fire while a streamed body is still being
          // persisted. Arm again with the durable record in the same
          // transaction so acceptance can never leave work without an owner.
          const current = await txn.getAlarm();
          if (shouldReplaceAlarm(current, alarmAt, now)) await txn.setAlarm(alarmAt);
        }
        await txn.delete(stageKey);
      });
      if (duplicate && storedBody) await this.deleteStoredBody(storedBody);
    } catch (error) {
      await cancelBinaryBody(body, error);
      if (storedBody) await this.deleteStoredBody(storedBody).catch(() => {});
      await this.deleteStage(stageId).catch(() => {});
      throw error;
    }
  }

  async pendingIds(limit = 100): Promise<string[]> {
    const records = await this.storage.list<DeliveryRecord>({ prefix: RECORD_PREFIX });
    return [...records.entries()]
      .filter(([, record]) => record.state !== "completed")
      .sort(([leftKey, left], [rightKey, right]) =>
        left.createdAt - right.createdAt || leftKey.localeCompare(rightKey)
      )
      .slice(0, Math.max(1, Math.min(100, Math.floor(limit))))
      .map(([key]) => key.slice(RECORD_PREFIX.length));
  }

  async attempt(
    deliveryId: string,
    handlers: AdapterPeerDeliveryAttemptHandlers,
  ): Promise<"completed" | "pending" | "active" | "missing"> {
    const normalized = requireDeliveryId(deliveryId);
    if (this.active.has(normalized)) return "active";
    this.active.add(normalized);
    try {
      const key = recordKey(normalized);
      let record = await this.storage.get<DeliveryRecord>(key);
      if (!record) return "missing";
      if (record.state === "completed") {
        if (record.expiresAt > Date.now()) return "completed";
        await this.storage.delete(key);
        await this.refreshPendingMarker();
        return "missing";
      }
      if (record.state === "reporting") {
        return await this.reportRecord(key, record, handlers);
      }

      if (!await handlers.claim(record.delivery)) {
        await this.completeWithoutReport(key, record);
        return "completed";
      }

      const attempted: PendingRecord = { ...record, attempts: record.attempts + 1 };
      await this.storage.put(key, attempted);
      record = attempted;
      const body = record.body ? this.openStoredBody(record.body) : undefined;
      let result: AdapterSendResult;
      try {
        result = await handlers.deliver(record.delivery, body);
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
      } finally {
        await cancelBinaryBody(body, "Adapter peer delivery attempt completed");
      }

      if (!result.ok && result.retryable && attempted.attempts < MAX_DELIVERY_ATTEMPTS) {
        await this.arm(Date.now() + this.retryDelayMs);
        return "pending";
      }

      const outcome = deliveryOutcome(result, attempted.attempts);
      const reporting: ReportingRecord = {
        state: "reporting",
        fingerprint: attempted.fingerprint,
        delivery: attempted.delivery,
        outcome,
        createdAt: attempted.createdAt,
      };
      if (attempted.body) reporting.body = attempted.body;
      await this.storage.put(key, reporting);
      return await this.reportRecord(key, reporting, handlers);
    } finally {
      this.active.delete(normalized);
    }
  }

  async arm(alarmAt: number): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const now = Date.now();
      const current = await txn.getAlarm();
      if (shouldReplaceAlarm(current, alarmAt, now)) await txn.setAlarm(alarmAt);
    });
  }

  async armIfPending(alarmAt: number): Promise<boolean> {
    await this.prune();
    const records = await this.storage.list<DeliveryRecord>({ prefix: RECORD_PREFIX });
    const pending = [...records.values()].some((record) => record.state !== "completed");
    if (pending) {
      await this.storage.put(ADAPTER_PEER_DELIVERY_PENDING_KEY, true);
      await this.arm(alarmAt);
    } else {
      await this.storage.delete(ADAPTER_PEER_DELIVERY_PENDING_KEY);
    }
    return pending;
  }

  private async reportRecord(
    key: string,
    record: ReportingRecord,
    handlers: AdapterPeerDeliveryAttemptHandlers,
  ): Promise<"completed" | "pending"> {
    try {
      await handlers.report(record.delivery, record.outcome);
    } catch {
      await this.arm(Date.now() + this.retryDelayMs);
      return "pending";
    }
    // Keep the body reference in the reporting record until cleanup succeeds.
    // A crash before this point safely replays the idempotent Kernel report;
    // a crash after deletion can repeat the no-op deletion on the next alarm.
    if (record.body) await this.deleteStoredBody(record.body);
    await this.storage.put(key, {
      state: "completed",
      fingerprint: record.fingerprint,
      outcome: record.outcome,
      createdAt: record.createdAt,
      expiresAt: Date.now() + COMPLETED_RETENTION_MS,
    } satisfies CompletedRecord);
    await this.refreshPendingMarker();
    return "completed";
  }

  private async completeWithoutReport(key: string, record: PendingRecord): Promise<void> {
    if (record.body) await this.deleteStoredBody(record.body);
    await this.storage.put(key, {
      state: "completed",
      fingerprint: record.fingerprint,
      createdAt: record.createdAt,
      expiresAt: Date.now() + COMPLETED_RETENTION_MS,
    } satisfies CompletedRecord);
    await this.refreshPendingMarker();
  }

  private async storeBody(
    stageId: string,
    body: BinaryBody | undefined,
  ): Promise<StoredBody | undefined> {
    if (!body) return undefined;
    const reader = body.stream.getReader();
    let chunk = new Uint8Array(BODY_CHUNK_BYTES);
    let used = 0;
    let chunks = 0;
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        let offset = 0;
        while (offset < next.value.byteLength) {
          const copied = Math.min(chunk.byteLength - used, next.value.byteLength - offset);
          chunk.set(next.value.subarray(offset, offset + copied), used);
          used += copied;
          offset += copied;
          length += copied;
          if (used === chunk.byteLength) {
            await this.storage.put(bodyKey(stageId, chunks), chunk);
            chunks += 1;
            chunk = new Uint8Array(BODY_CHUNK_BYTES);
            used = 0;
          }
        }
      }
      if (used > 0) {
        await this.storage.put(bodyKey(stageId, chunks), chunk.slice(0, used));
        chunks += 1;
      }
      if (body.length !== undefined && body.length !== length) {
        throw new Error("Adapter signal body length did not match its descriptor");
      }
      return { stageId, chunks, length };
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private openStoredBody(body: StoredBody): BinaryBody {
    let index = 0;
    const storage = this.storage;
    return {
      length: body.length,
      stream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index >= body.chunks) {
            controller.close();
            return;
          }
          const value = await storage.get<Uint8Array>(bodyKey(body.stageId, index));
          if (!value) {
            controller.error(new Error("Adapter signal body chunk is missing"));
            return;
          }
          index += 1;
          controller.enqueue(value);
        },
      }),
    };
  }

  private async deleteStoredBody(body: StoredBody): Promise<void> {
    if (body.chunks === 0) return;
    const keys = Array.from({ length: body.chunks }, (_, index) => bodyKey(body.stageId, index));
    for (let offset = 0; offset < keys.length; offset += 128) {
      await this.storage.delete(keys.slice(offset, offset + 128));
    }
  }

  private async deleteStage(stageId: string): Promise<void> {
    const chunks = await this.storage.list({ prefix: `${BODY_PREFIX}${stageId}:` });
    const keys = [...chunks.keys(), `${STAGING_PREFIX}${stageId}`];
    for (let offset = 0; offset < keys.length; offset += 128) {
      await this.storage.delete(keys.slice(offset, offset + 128));
    }
  }

  private async prune(): Promise<void> {
    const now = Date.now();
    const [records, stages] = await Promise.all([
      this.storage.list<DeliveryRecord>({ prefix: RECORD_PREFIX }),
      this.storage.list<StagingRecord>({ prefix: STAGING_PREFIX }),
    ]);
    const expired = [...records.entries()]
      .filter(([, record]) => record.state === "completed" && record.expiresAt <= now)
      .map(([key]) => key);
    for (let offset = 0; offset < expired.length; offset += 128) {
      await this.storage.delete(expired.slice(offset, offset + 128));
    }
    for (const [key, stage] of stages) {
      if (stage.createdAt + STAGING_RETENTION_MS > now) continue;
      await this.deleteStage(key.slice(STAGING_PREFIX.length));
    }
  }

  private async refreshPendingMarker(): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const records = await txn.list<DeliveryRecord>({ prefix: RECORD_PREFIX });
      if ([...records.values()].some((record) => record.state !== "completed")) {
        await txn.put(ADAPTER_PEER_DELIVERY_PENDING_KEY, true);
      } else {
        await txn.delete(ADAPTER_PEER_DELIVERY_PENDING_KEY);
      }
    });
  }
}

export function adapterDeliveryClaimArgs(
  adapter: string,
  delivery: AdapterPeerSignalDelivery,
): AdapterDeliveryClaimArgs {
  const { context, frame } = delivery;
  if (!context.actorId || !context.processId || !context.runId) {
    throw new Error("Adapter signal route context is incomplete");
  }
  const result: AdapterDeliveryClaimArgs = {
    adapter,
    accountId: context.accountId,
    deliveryId: context.deliveryId,
    actorId: context.actorId,
    surface: context.surface,
    processId: context.processId,
    runId: context.runId,
    kind: frame.signal === "proc.run.hil.requested" ? "hil" : "message",
  };
  if (context.routeGeneration) result.routeGeneration = context.routeGeneration;
  if (frame.signal === "proc.run.hil.requested") result.requestId = frame.payload.requestId;
  return result;
}

export function gatewayPeerDeliveryHandlers(input: {
  adapter: string;
  gateway: AdapterGatewayBinding;
  deliver(
    delivery: AdapterPeerSignalDelivery,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
}): AdapterPeerDeliveryAttemptHandlers {
  return {
    claim: async (delivery) => {
      const result = await callAdapterGateway(
        input.gateway,
        delivery.installation,
        "adapter.delivery.claim",
        adapterDeliveryClaimArgs(input.adapter, delivery),
      );
      return result.deliver;
    },
    deliver: input.deliver,
    report: async (delivery, outcome) => {
      const args: AdapterDeliveryReportArgs = {
        ...adapterDeliveryClaimArgs(input.adapter, delivery),
        state: outcome.state,
        attempts: outcome.attempts,
      };
      if (outcome.messageId !== undefined) args.messageId = outcome.messageId;
      if (outcome.error !== undefined) args.error = outcome.error;
      await callAdapterGateway(
        input.gateway,
        delivery.installation,
        "adapter.delivery.report",
        args,
      );
    },
  };
}

async function deliveryFingerprint(
  delivery: AdapterPeerSignalDelivery,
  body: StoredBody | undefined,
  storage: DurableObjectStorage,
): Promise<string> {
  const chunkHashes: string[] = [];
  if (body) {
    for (let index = 0; index < body.chunks; index += 1) {
      const chunk = await storage.get<Uint8Array>(bodyKey(body.stageId, index));
      if (!chunk) throw new Error("Adapter signal body chunk disappeared during acceptance");
      chunkHashes.push(await sha256(chunk));
    }
  }
  return await sha256(new TextEncoder().encode(JSON.stringify({
    version: 1,
    delivery,
    bodyLength: body?.length ?? null,
    chunkHashes,
  })));
}

function deliveryOutcome(
  result: AdapterSendResult,
  attempts: number,
): AdapterPeerDeliveryOutcome {
  if (result.ok) {
    return {
      state: result.deduplicated ? "deduplicated" : "sent",
      attempts,
      ...(result.messageId === undefined ? undefined : { messageId: result.messageId }),
    };
  }
  return {
    state: result.ambiguous
      ? "ambiguous"
      : result.retryable
        ? "exhausted"
        : "failed",
    attempts,
    error: result.error.slice(0, 1_000),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function recordKey(deliveryId: string): string {
  return `${RECORD_PREFIX}${deliveryId}`;
}

function bodyKey(stageId: string, index: number): string {
  return `${BODY_PREFIX}${stageId}:${index.toString().padStart(6, "0")}`;
}

function requireDeliveryId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new Error("Adapter deliveryId is invalid");
  }
  return normalized;
}
