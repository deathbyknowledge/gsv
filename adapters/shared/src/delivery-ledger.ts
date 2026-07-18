import type {
  AdapterOutboundMessage,
  AdapterSendResult,
} from "./types";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 4096;
const MAX_DELIVERY_ID_BYTES = 200;
const MAX_ERROR_LENGTH = 1000;
const MAX_MESSAGE_ID_LENGTH = 256;
const RECORD_PREFIX = "outbound_delivery:v1:record:";
const META_KEY = "outbound_delivery:v1:meta";

type DeliveryRecord =
  | {
      state: "attempting";
      deliveryId: string;
      requestFingerprint: string;
      attemptId: string;
      createdAt: number;
      expiresAt: number;
    }
  | {
      state: "retryable";
      deliveryId: string;
      requestFingerprint: string;
      createdAt: number;
      expiresAt: number;
    }
  | {
      state: "sent";
      deliveryId: string;
      requestFingerprint: string;
      messageId?: string;
      createdAt: number;
      expiresAt: number;
    }
  | {
      state: "ambiguous" | "failed";
      deliveryId: string;
      requestFingerprint: string;
      error: string;
      createdAt: number;
      expiresAt: number;
    };

type DeliveryMeta = {
  count: number;
  nextPruneAt: number;
};

export type DeliveryClaim =
  | { claimed: true; attemptId: string }
  | { claimed: false; result: AdapterSendResult };

export type DeliveryLedgerOptions = {
  retentionMs?: number;
  pruneIntervalMs?: number;
  maxRecords?: number;
  now?: () => number;
};

export type DeliveryFailureKind = "retryable" | "permanent" | "ambiguous";

type OutboundDeliveryFingerprintInput = Pick<
  AdapterOutboundMessage,
  "surface" | "actorId" | "text" | "media" | "replyToId"
>;

/**
 * Binds one logical delivery id to its provider-significant destination and
 * content. Binary media is fingerprinted by bytes rather than by mutable body
 * offsets or caller-supplied size metadata.
 */
export async function fingerprintOutboundDelivery(
  message: OutboundDeliveryFingerprintInput,
  mediaBytes: ReadonlyArray<Uint8Array | undefined> = [],
): Promise<string> {
  const media = await Promise.all((message.media ?? []).map(async (item, index) => {
    const bytes = mediaBytes[index];
    if (item.body && !bytes) {
      throw new Error(`Outbound media ${index + 1} is missing bytes for delivery fingerprinting`);
    }
    return {
      type: item.type,
      mimeType: item.mimeType,
      url: item.url ?? null,
      filename: item.filename ?? null,
      size: bytes ? bytes.byteLength : item.size ?? null,
      duration: item.duration ?? null,
      transcription: item.transcription ?? null,
      bodySha256: bytes ? await sha256Hex(bytes) : null,
    };
  }));
  const canonical = JSON.stringify({
    version: 1,
    surface: {
      kind: message.surface.kind,
      id: message.surface.id,
      threadId: message.surface.threadId ?? null,
    },
    actorId: message.actorId ?? null,
    text: message.text,
    replyToId: message.replyToId ?? null,
    media,
  });
  return await sha256Hex(new TextEncoder().encode(canonical));
}

/** Classifies a response from a provider that has no idempotent send primitive. */
export function classifyNonIdempotentProviderStatus(
  status: number,
): DeliveryFailureKind {
  if (status === 429) return "retryable";
  if (status === 408 || status >= 500) return "ambiguous";
  return "permanent";
}

/**
 * A bounded, durable account-local ledger for outbound provider deliveries.
 *
 * An `attempting` record is committed before provider I/O. Providers without
 * their own idempotency key therefore deliberately choose at-most-once delivery:
 * an interrupted attempt becomes ambiguous and is never replayed automatically.
 */
export class DeliveryLedger {
  private readonly retentionMs: number;
  private readonly pruneIntervalMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;

  constructor(
    private readonly storage: DurableObjectStorage,
    options: DeliveryLedgerOptions = {},
  ) {
    this.retentionMs = positiveInteger(
      options.retentionMs ?? DEFAULT_RETENTION_MS,
      "retentionMs",
    );
    this.pruneIntervalMs = positiveInteger(
      options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
      "pruneIntervalMs",
    );
    this.maxRecords = positiveInteger(
      options.maxRecords ?? DEFAULT_MAX_RECORDS,
      "maxRecords",
    );
    this.now = options.now ?? Date.now;
  }

  async claim(
    deliveryId: string,
    requestFingerprint: string,
  ): Promise<DeliveryClaim> {
    const validationError = validateDeliveryId(deliveryId);
    if (validationError) {
      return {
        claimed: false,
        result: { ok: false, error: validationError },
      };
    }
    if (!/^[0-9a-f]{64}$/.test(requestFingerprint)) {
      return {
        claimed: false,
        result: { ok: false, error: "Outbound delivery fingerprint is invalid" },
      };
    }

    const now = this.now();
    return await this.storage.transaction(async (txn) => {
      let meta = await txn.get<DeliveryMeta>(META_KEY);
      let existing: DeliveryRecord | undefined;

      if (!isDeliveryMeta(meta) || meta.nextPruneAt <= now || meta.count >= this.maxRecords) {
        const records = await txn.list<DeliveryRecord>({ prefix: RECORD_PREFIX });
        let count = 0;
        const expiredKeys: string[] = [];
        for (const [key, record] of records) {
          if (!isDeliveryRecord(record) || record.expiresAt <= now) {
            expiredKeys.push(key);
            continue;
          }
          count += 1;
          if (record.deliveryId === deliveryId) {
            existing = record;
          }
        }
        if (expiredKeys.length > 0) {
          await txn.delete(expiredKeys);
        }
        meta = {
          count,
          nextPruneAt: now + this.pruneIntervalMs,
        };
      } else {
        existing = await txn.get<DeliveryRecord>(recordKey(deliveryId));
        if (existing && (!isDeliveryRecord(existing) || existing.expiresAt <= now)) {
          await txn.delete(recordKey(deliveryId));
          meta = { ...meta, count: Math.max(0, meta.count - 1) };
          existing = undefined;
        }
      }

      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          await txn.put(META_KEY, meta);
          return {
            claimed: false,
            result: {
              ok: false,
              error: "deliveryId is already bound to a different outbound destination or content",
            },
          };
        }
        if (existing.state === "retryable") {
          const attemptId = crypto.randomUUID();
          await txn.put(recordKey(deliveryId), {
            ...existing,
            state: "attempting",
            attemptId,
          } satisfies DeliveryRecord);
          await txn.put(META_KEY, meta);
          return { claimed: true, attemptId };
        }
        await txn.put(META_KEY, meta);
        return claimFromExisting(existing);
      }

      if (meta.count >= this.maxRecords) {
        await txn.put(META_KEY, meta);
        return {
          claimed: false,
          result: {
            ok: false,
            error: "Outbound delivery ledger is at capacity; retry after older records expire",
            retryable: true,
          },
        };
      }

      const attemptId = crypto.randomUUID();
      const record: DeliveryRecord = {
        state: "attempting",
        deliveryId,
        requestFingerprint,
        attemptId,
        createdAt: now,
        expiresAt: now + this.retentionMs,
      };
      await txn.put(recordKey(deliveryId), record);
      await txn.put(META_KEY, {
        count: meta.count + 1,
        nextPruneAt: meta.nextPruneAt,
      } satisfies DeliveryMeta);
      return { claimed: true, attemptId };
    });
  }

  async succeed(
    deliveryId: string,
    attemptId: string,
    messageId?: string,
  ): Promise<void> {
    await this.replaceAttempt(deliveryId, attemptId, (attempt) => ({
      state: "sent",
      deliveryId,
      requestFingerprint: attempt.requestFingerprint,
      ...(messageId
        ? { messageId: truncate(messageId, MAX_MESSAGE_ID_LENGTH) }
        : {}),
      createdAt: attempt.createdAt,
      expiresAt: attempt.expiresAt,
    }));
  }

  async failAmbiguous(
    deliveryId: string,
    attemptId: string,
    error: string,
  ): Promise<void> {
    await this.replaceAttempt(deliveryId, attemptId, (attempt) => ({
      state: "ambiguous",
      deliveryId,
      requestFingerprint: attempt.requestFingerprint,
      error: truncate(error, MAX_ERROR_LENGTH),
      createdAt: attempt.createdAt,
      expiresAt: attempt.expiresAt,
    }));
  }

  async failPermanent(
    deliveryId: string,
    attemptId: string,
    error: string,
  ): Promise<void> {
    await this.replaceAttempt(deliveryId, attemptId, (attempt) => ({
      state: "failed",
      deliveryId,
      requestFingerprint: attempt.requestFingerprint,
      error: truncate(error, MAX_ERROR_LENGTH),
      createdAt: attempt.createdAt,
      expiresAt: attempt.expiresAt,
    }));
  }

  async releaseRetryable(deliveryId: string, attemptId: string): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const key = recordKey(deliveryId);
      const record = await txn.get<DeliveryRecord>(key);
      if (!isMatchingAttempt(record, attemptId)) {
        return;
      }
      await txn.put(key, {
        state: "retryable",
        deliveryId,
        requestFingerprint: record.requestFingerprint,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      } satisfies DeliveryRecord);
    });
  }

  private async replaceAttempt(
    deliveryId: string,
    attemptId: string,
    replacement: (attempt: Extract<DeliveryRecord, { state: "attempting" }>) => DeliveryRecord,
  ): Promise<void> {
    await this.storage.transaction(async (txn) => {
      const key = recordKey(deliveryId);
      const record = await txn.get<DeliveryRecord>(key);
      if (!isMatchingAttempt(record, attemptId)) {
        return;
      }
      await txn.put(key, replacement(record));
    });
  }
}

function claimFromExisting(record: DeliveryRecord): DeliveryClaim {
  switch (record.state) {
    case "sent":
      return {
        claimed: false,
        result: {
          ok: true,
          ...(record.messageId ? { messageId: record.messageId } : {}),
          deduplicated: true,
        },
      };
    case "failed":
      return {
        claimed: false,
        result: { ok: false, error: record.error },
      };
    case "ambiguous":
      return {
        claimed: false,
        result: { ok: false, error: record.error, ambiguous: true },
      };
    case "attempting":
      return {
        claimed: false,
        result: {
          ok: false,
          error: "Outbound delivery is already in progress; its provider outcome is not yet known",
          ambiguous: true,
        },
      };
    case "retryable":
      throw new Error("Retryable delivery records must be claimed transactionally");
  }
}

function validateDeliveryId(deliveryId: string): string | null {
  if (typeof deliveryId !== "string" || !deliveryId || deliveryId !== deliveryId.trim()) {
    return "deliveryId must be a non-empty string without surrounding whitespace";
  }
  if (!/^[a-zA-Z0-9._:-]+$/.test(deliveryId)) {
    return "deliveryId contains unsupported characters";
  }
  if (new TextEncoder().encode(deliveryId).byteLength > MAX_DELIVERY_ID_BYTES) {
    return `deliveryId must be at most ${MAX_DELIVERY_ID_BYTES} UTF-8 bytes`;
  }
  return null;
}

function recordKey(deliveryId: string): string {
  return `${RECORD_PREFIX}${encodeURIComponent(deliveryId)}`;
}

function isMatchingAttempt(
  record: DeliveryRecord | undefined,
  attemptId: string,
): record is Extract<DeliveryRecord, { state: "attempting" }> {
  return record?.state === "attempting" && record.attemptId === attemptId;
}

function isDeliveryMeta(value: unknown): value is DeliveryMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<DeliveryMeta>;
  return Number.isSafeInteger(meta.count)
    && (meta.count ?? -1) >= 0
    && Number.isFinite(meta.nextPruneAt);
}

function isDeliveryRecord(value: unknown): value is DeliveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DeliveryRecord>;
  if (
    typeof record.deliveryId !== "string"
    || typeof record.requestFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(record.requestFingerprint)
    || !Number.isFinite(record.createdAt)
    || !Number.isFinite(record.expiresAt)
  ) {
    return false;
  }
  if (record.state === "attempting") {
    return typeof (record as { attemptId?: unknown }).attemptId === "string";
  }
  if (record.state === "retryable") {
    return true;
  }
  if (record.state === "sent") {
    return record.messageId === undefined || typeof record.messageId === "string";
  }
  if (record.state === "ambiguous" || record.state === "failed") {
    return typeof (record as { error?: unknown }).error === "string";
  }
  return false;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
