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

type DeliveryJsonRow = {
  record_json: string;
};

type DeliveryIdRow = {
  delivery_id: string;
};

type BodyChunkRow = {
  content: ArrayBuffer;
};

type MinimumTimeRow = {
  value: number | null;
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
  private readonly sql: SqlStorage;
  private drainPromise?: Promise<void>;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly retryDelayMs = 10_000,
  ) {
    this.sql = storage.sql;
  }

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
    await this.storage.transaction(async (txn) => {
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO adapter_peer_delivery_stages (stage_id, delivery_id, created_at)
         VALUES (?, ?, ?)`,
        stageId,
        deliveryId,
        now,
      );
      const current = await txn.getAlarm();
      if (shouldReplaceAlarm(current, alarmAt, now)) await txn.setAlarm(alarmAt);
    });

    let storedBody: StoredBody | undefined;
    try {
      storedBody = await this.storeBody(stageId, body);
      const fingerprint = await deliveryFingerprint(delivery, storedBody, this.sql);
      let duplicate = false;
      await this.storage.transaction(async (txn) => {
        const now = Date.now();
        const existing = readDeliveryRecord(this.sql, deliveryId);
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
          writeDeliveryRecord(this.sql, deliveryId, record);
          pending = true;
        }
        if (pending) {
          // The staging alarm can fire while a streamed body is still being
          // persisted. Arm again atomically with accepting the durable record.
          const current = await txn.getAlarm();
          if (shouldReplaceAlarm(current, alarmAt, now)) await txn.setAlarm(alarmAt);
        }
        if (duplicate && storedBody) this.deleteStoredBody(storedBody);
        this.sql.exec(
          "DELETE FROM adapter_peer_delivery_stages WHERE stage_id = ?",
          stageId,
        );
      });
    } catch (error) {
      await cancelBinaryBody(body, error);
      try {
        if (storedBody) this.deleteStoredBody(storedBody);
        this.deleteStage(stageId);
      } catch {
        // The retained stage alarm remains the cleanup owner.
      }
      throw error;
    }
  }

  async pendingIds(limit = 100): Promise<string[]> {
    return this.sql.exec<DeliveryIdRow>(
      `SELECT delivery_id
       FROM adapter_peer_deliveries
       WHERE state IN ('pending', 'reporting')
       ORDER BY created_at, delivery_id
       LIMIT ?`,
      Math.max(1, Math.min(100, Math.floor(limit))),
    ).toArray().map((row) => row.delivery_id);
  }

  async drain(handlers: AdapterPeerDeliveryAttemptHandlers): Promise<void> {
    if (this.drainPromise) return await this.drainPromise;
    const running = (async () => {
      for (const deliveryId of await this.pendingIds()) {
        const result = await this.attempt(deliveryId, handlers);
        if (result === "pending") break;
      }
    })();
    this.drainPromise = running;
    try {
      await running;
    } finally {
      if (this.drainPromise === running) this.drainPromise = undefined;
    }
  }

  async attempt(
    deliveryId: string,
    handlers: AdapterPeerDeliveryAttemptHandlers,
  ): Promise<"completed" | "pending" | "active" | "missing"> {
    const normalized = requireDeliveryId(deliveryId);
    if (this.active.has(normalized)) return "active";
    this.active.add(normalized);
    try {
      let record = readDeliveryRecord(this.sql, normalized);
      if (!record) return "missing";
      if (record.state === "completed") {
        if (record.expiresAt > Date.now()) return "completed";
        this.sql.exec(
          "DELETE FROM adapter_peer_deliveries WHERE delivery_id = ?",
          normalized,
        );
        return "missing";
      }
      if (record.state === "reporting") {
        return await this.reportRecord(normalized, record, handlers);
      }

      if (!await handlers.claim(record.delivery)) {
        await this.completeWithoutReport(normalized, record);
        return "completed";
      }

      const attempted: PendingRecord = { ...record, attempts: record.attempts + 1 };
      writeDeliveryRecord(this.sql, normalized, attempted);
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
      writeDeliveryRecord(this.sql, normalized, reporting);
      return await this.reportRecord(normalized, reporting, handlers);
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
    const stageCleanupAt = this.prune();
    const pending = this.hasPending();
    // Interrupted streamed acceptance may leave only a stage. Schedule its
    // expiry without treating it as provider-delivery work or polling it.
    const nextAlarm = pending
      ? Math.min(alarmAt, stageCleanupAt ?? alarmAt)
      : stageCleanupAt;
    if (nextAlarm !== null) await this.arm(nextAlarm);
    return pending;
  }

  hasPending(): boolean {
    return this.sql.exec<DeliveryIdRow>(
      `SELECT delivery_id
       FROM adapter_peer_deliveries
       WHERE state IN ('pending', 'reporting')
       LIMIT 1`,
    ).toArray().length > 0;
  }

  private async reportRecord(
    deliveryId: string,
    record: ReportingRecord,
    handlers: AdapterPeerDeliveryAttemptHandlers,
  ): Promise<"completed" | "pending"> {
    try {
      await handlers.report(record.delivery, record.outcome);
    } catch {
      await this.arm(Date.now() + this.retryDelayMs);
      return "pending";
    }
    this.storage.transactionSync(() => {
      if (record.body) this.deleteStoredBody(record.body);
      writeDeliveryRecord(this.sql, deliveryId, {
        state: "completed",
        fingerprint: record.fingerprint,
        outcome: record.outcome,
        createdAt: record.createdAt,
        expiresAt: Date.now() + COMPLETED_RETENTION_MS,
      } satisfies CompletedRecord);
    });
    return "completed";
  }

  private async completeWithoutReport(
    deliveryId: string,
    record: PendingRecord,
  ): Promise<void> {
    this.storage.transactionSync(() => {
      if (record.body) this.deleteStoredBody(record.body);
      writeDeliveryRecord(this.sql, deliveryId, {
        state: "completed",
        fingerprint: record.fingerprint,
        createdAt: record.createdAt,
        expiresAt: Date.now() + COMPLETED_RETENTION_MS,
      } satisfies CompletedRecord);
    });
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
            writeBodyChunk(this.sql, stageId, chunks, chunk);
            chunks += 1;
            chunk = new Uint8Array(BODY_CHUNK_BYTES);
            used = 0;
          }
        }
      }
      if (used > 0) {
        writeBodyChunk(this.sql, stageId, chunks, chunk.slice(0, used));
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
    const sql = this.sql;
    return {
      length: body.length,
      stream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index >= body.chunks) {
            controller.close();
            return;
          }
          const value = readBodyChunk(sql, body.stageId, index);
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

  private deleteStoredBody(body: StoredBody): void {
    this.sql.exec(
      "DELETE FROM adapter_peer_delivery_chunks WHERE stage_id = ?",
      body.stageId,
    );
  }

  private deleteStage(stageId: string): void {
    this.storage.transactionSync(() => {
      this.sql.exec(
        "DELETE FROM adapter_peer_delivery_chunks WHERE stage_id = ?",
        stageId,
      );
      this.sql.exec(
        "DELETE FROM adapter_peer_delivery_stages WHERE stage_id = ?",
        stageId,
      );
    });
  }

  private prune(): number | null {
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM adapter_peer_deliveries
         WHERE state = 'completed' AND expires_at <= ?`,
        now,
      );
      this.sql.exec(
        `DELETE FROM adapter_peer_delivery_chunks
         WHERE stage_id IN (
           SELECT stage_id
           FROM adapter_peer_delivery_stages
           WHERE created_at <= ?
         )`,
        now - STAGING_RETENTION_MS,
      );
      this.sql.exec(
        `DELETE FROM adapter_peer_delivery_stages
         WHERE created_at <= ?`,
        now - STAGING_RETENTION_MS,
      );
    });
    return this.sql.exec<MinimumTimeRow>(
      `SELECT MIN(created_at + ?) AS value
       FROM adapter_peer_delivery_stages`,
      STAGING_RETENTION_MS,
    ).one().value;
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
  sql: SqlStorage,
): Promise<string> {
  const chunkHashes: string[] = [];
  if (body) {
    for (let index = 0; index < body.chunks; index += 1) {
      const chunk = readBodyChunk(sql, body.stageId, index);
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

function readDeliveryRecord(
  sql: SqlStorage,
  deliveryId: string,
): DeliveryRecord | undefined {
  const row = sql.exec<DeliveryJsonRow>(
    `SELECT record_json
     FROM adapter_peer_deliveries
     WHERE delivery_id = ?
     LIMIT 1`,
    deliveryId,
  ).toArray()[0];
  // SAFETY: This table is private to this module and every write serializes a
  // DeliveryRecord through writeDeliveryRecord in the same schema version.
  return row ? JSON.parse(row.record_json) as DeliveryRecord : undefined;
}

function writeDeliveryRecord(
  sql: SqlStorage,
  deliveryId: string,
  record: DeliveryRecord,
): void {
  sql.exec(
    `INSERT INTO adapter_peer_deliveries
       (delivery_id, state, record_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(delivery_id) DO UPDATE SET
       state = excluded.state,
       record_json = excluded.record_json,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
    deliveryId,
    record.state,
    JSON.stringify(record),
    record.createdAt,
    record.state === "completed" ? record.expiresAt : null,
  );
}

function writeBodyChunk(
  sql: SqlStorage,
  stageId: string,
  index: number,
  content: Uint8Array,
): void {
  sql.exec(
    `INSERT INTO adapter_peer_delivery_chunks (stage_id, chunk_index, content)
     VALUES (?, ?, ?)`,
    stageId,
    index,
    content.slice().buffer,
  );
}

function readBodyChunk(
  sql: SqlStorage,
  stageId: string,
  index: number,
): Uint8Array | undefined {
  const row = sql.exec<BodyChunkRow>(
    `SELECT content
     FROM adapter_peer_delivery_chunks
     WHERE stage_id = ? AND chunk_index = ?
     LIMIT 1`,
    stageId,
    index,
  ).toArray()[0];
  return row ? new Uint8Array(row.content) : undefined;
}

function requireDeliveryId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new Error("Adapter deliveryId is invalid");
  }
  return normalized;
}
