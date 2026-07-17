import type {
  AdapterInboundResult,
  AdapterSurface,
  AdapterSurfaceKind,
} from "@humansandmachines/gsv/protocol";

export type AdapterIngressReceiptKey = {
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  threadId?: string;
  providerMessageId: string;
};

export type AdapterIngressReceiptClaim =
  | {
      state: "claimed";
      receiptId: string;
      claimToken: string;
      recovery?: unknown;
    }
  | { state: "in_progress"; receiptId: string }
  | {
      state: "prepared";
      receiptId: string;
      claimToken: string;
      result: AdapterInboundResult;
    }
  | {
      state: "completed";
      receiptId: string;
      result: AdapterInboundResult;
    };

export type AdapterIngressImmediateDelivery = {
  adapter: string;
  accountId: string;
  surface: AdapterSurface;
  deliveryId: string;
  text: string;
  replyToId?: string;
};

export type AdapterIngressCompletion = {
  receiptId: string;
  claimToken: string;
  deliveries: AdapterIngressImmediateDelivery[];
};

export function adapterIngressImmediateDeliveries(input: {
  adapter: string;
  accountId: string;
  surface: AdapterSurface;
  providerMessageId: string;
  result: AdapterInboundResult;
}): AdapterIngressImmediateDelivery[] {
  const deliveries: AdapterIngressImmediateDelivery[] = [];
  if (input.result.challenge?.prompt) {
    deliveries.push({
      adapter: input.adapter,
      accountId: input.accountId,
      surface: input.surface,
      deliveryId: input.result.challenge.deliveryId,
      text: input.result.challenge.prompt,
      replyToId: input.providerMessageId,
    });
  }
  if (input.result.reply?.text) {
    deliveries.push({
      adapter: input.adapter,
      accountId: input.accountId,
      surface: input.surface,
      deliveryId: input.result.reply.deliveryId,
      text: input.result.reply.text,
      replyToId: input.result.reply.replyToId || input.providerMessageId,
    });
  }
  return deliveries;
}

type AdapterIngressReceiptRow = {
  receipt_id: string;
  adapter: string;
  account_id: string;
  actor_id: string;
  surface_kind: string;
  surface_id: string;
  thread_id: string;
  provider_message_id: string;
  state: string;
  result_json: string | null;
  progress_json: string | null;
  claim_token: string;
  claimed_at: number;
};

const CLAIM_LEASE_MS = 5 * 60 * 1000;
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COMPLETED_RECEIPTS = 4_096;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Kernel-owned idempotency boundary for normalized provider ingress.
 *
 * The claim is committed before any command, link, HIL, route, media, or
 * Process side effect. Claim ownership is fenced with a token and mirrored in
 * memory. A fresh Kernel instance can therefore reclaim work left by a crash
 * immediately, while a concurrent replay on the live instance observes the
 * active owner. `in_progress` is not a terminal acknowledgement: the provider
 * adapter retains its durable payload and retries until this receipt is
 * prepared/completed. The time lease is only a final escape hatch for a
 * request that never reaches its cleanup path.
 *
 * A result is prepared before any immediate reply is enqueued. Completion is a
 * separate token-guarded transition, allowing the Kernel to enforce the
 * invariant that a completed receipt already has durable delivery work.
 */
export class AdapterIngressReceiptStore {
  private readonly activeClaims = new Set<string>();
  private nextPruneAt = 0;

  constructor(private readonly sql: SqlStorage) {}

  claim(
    input: AdapterIngressReceiptKey & { receiptId: string },
  ): AdapterIngressReceiptClaim {
    this.prune();
    const existing = this.get(input);
    if (existing) {
      if (existing.state === "completed") {
        return completedClaimFromRow(existing);
      }
      if (existing.state !== "in_progress") {
        throw new Error(`Invalid adapter ingress receipt state: ${existing.receipt_id}`);
      }
      if (
        this.activeClaims.has(existing.claim_token)
        && existing.claimed_at > Date.now() - CLAIM_LEASE_MS
      ) {
        return { state: "in_progress", receiptId: existing.receipt_id };
      }
      return this.reclaim(existing);
    }

    const now = Date.now();
    const claimToken = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO adapter_ingress_receipts (
        receipt_id, adapter, account_id, actor_id, surface_kind, surface_id,
        thread_id, provider_message_id, state, result_json, progress_json, claim_token,
        claimed_at, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, NULL, ?, ?, ?, NULL)`,
      input.receiptId,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      input.threadId ?? "",
      input.providerMessageId,
      claimToken,
      now,
      now,
    );
    this.activeClaims.add(claimToken);
    return { state: "claimed", receiptId: input.receiptId, claimToken };
  }

  prepare(
    receiptId: string,
    claimToken: string,
    result: AdapterInboundResult,
  ): void {
    const cursor = this.sql.exec(
      `UPDATE adapter_ingress_receipts
          SET result_json = ?
        WHERE receipt_id = ? AND state = 'in_progress' AND claim_token = ?`,
      JSON.stringify(withoutReplayMarker(result)),
      receiptId,
      claimToken,
    );
    if (cursor.rowsWritten !== 1) {
      throw new Error(`Adapter ingress receipt is not owned: ${receiptId}`);
    }
  }

  checkpoint(receiptId: string, claimToken: string, recovery: unknown): void {
    const cursor = this.sql.exec(
      `UPDATE adapter_ingress_receipts
          SET progress_json = ?
        WHERE receipt_id = ? AND state = 'in_progress' AND claim_token = ?`,
      JSON.stringify(recovery),
      receiptId,
      claimToken,
    );
    if (cursor.rowsWritten !== 1) {
      throw new Error(`Adapter ingress receipt is not owned: ${receiptId}`);
    }
  }

  complete(receiptId: string, claimToken: string): void {
    const cursor = this.sql.exec(
      `UPDATE adapter_ingress_receipts
          SET state = 'completed', completed_at = ?
        WHERE receipt_id = ?
          AND state = 'in_progress'
          AND claim_token = ?
          AND result_json IS NOT NULL`,
      Date.now(),
      receiptId,
      claimToken,
    );
    this.activeClaims.delete(claimToken);
    if (cursor.rowsWritten === 1) {
      return;
    }

    // A prepared replay can steal the claim while the previous request awaits
    // durable scheduling. Treat an already completed receipt as success; both
    // requests use the same stable delivery ids.
    const row = this.getByReceiptId(receiptId);
    if (row?.state === "completed" && row.result_json !== null) {
      return;
    }
    throw new Error(`Adapter ingress receipt is not owned: ${receiptId}`);
  }

  abandon(receiptId: string, claimToken: string): void {
    this.activeClaims.delete(claimToken);
    this.sql.exec(
      `UPDATE adapter_ingress_receipts
          SET claimed_at = 0
        WHERE receipt_id = ? AND state = 'in_progress' AND claim_token = ?`,
      receiptId,
      claimToken,
    );
  }

  claimPreparedCompletions(limit = 100): AdapterIngressCompletion[] {
    const rows = this.sql.exec<AdapterIngressReceiptRow>(
      `SELECT receipt_id, adapter, account_id, actor_id, surface_kind,
              surface_id, thread_id, provider_message_id, state, result_json,
              progress_json, claim_token, claimed_at
         FROM adapter_ingress_receipts
        WHERE state = 'in_progress' AND result_json IS NOT NULL
        ORDER BY claimed_at ASC
        LIMIT ?`,
      Math.max(1, Math.min(100, Math.floor(limit))),
    ).toArray();
    const completions: AdapterIngressCompletion[] = [];
    const activeCutoff = Date.now() - CLAIM_LEASE_MS;
    for (const row of rows) {
      if (
        this.activeClaims.has(row.claim_token)
        && row.claimed_at > activeCutoff
      ) {
        continue;
      }
      const reclaimed = this.reclaim(row);
      if (reclaimed.state !== "prepared") continue;
      completions.push({
        receiptId: reclaimed.receiptId,
        claimToken: reclaimed.claimToken,
        deliveries: immediateDeliveriesFromRow(row, reclaimed.result),
      });
    }
    return completions;
  }

  private prune(now = Date.now()): void {
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + PRUNE_INTERVAL_MS;
    const cutoff = now - RECEIPT_RETENTION_MS;
    this.sql.exec(
      `DELETE FROM adapter_ingress_receipts
        WHERE (state = 'completed' AND completed_at < ?)
           OR (state = 'in_progress' AND claimed_at < ?)`,
      cutoff,
      cutoff,
    );
    this.sql.exec(
      `DELETE FROM adapter_ingress_receipts
        WHERE receipt_id IN (
          SELECT receipt_id
            FROM adapter_ingress_receipts
           WHERE state = 'completed'
           ORDER BY completed_at DESC
           LIMIT -1 OFFSET ?
        )`,
      MAX_COMPLETED_RECEIPTS,
    );
  }

  private reclaim(row: AdapterIngressReceiptRow): AdapterIngressReceiptClaim {
    const claimToken = crypto.randomUUID();
    const cursor = this.sql.exec(
      `UPDATE adapter_ingress_receipts
          SET claim_token = ?, claimed_at = ?
        WHERE receipt_id = ? AND state = 'in_progress' AND claim_token = ?`,
      claimToken,
      Date.now(),
      row.receipt_id,
      row.claim_token,
    );
    if (cursor.rowsWritten !== 1) {
      throw new Error(`Adapter ingress receipt could not be reclaimed: ${row.receipt_id}`);
    }
    this.activeClaims.delete(row.claim_token);
    this.activeClaims.add(claimToken);
    if (row.result_json !== null) {
      return {
        state: "prepared",
        receiptId: row.receipt_id,
        claimToken,
        result: parseAdapterInboundResult(row),
      };
    }
    return {
      state: "claimed",
      receiptId: row.receipt_id,
      claimToken,
      ...(row.progress_json !== null
        ? { recovery: parseReceiptProgress(row) }
        : {}),
    };
  }

  private get(input: AdapterIngressReceiptKey): AdapterIngressReceiptRow | null {
    return this.sql.exec<AdapterIngressReceiptRow>(
      `SELECT receipt_id, adapter, account_id, actor_id, surface_kind,
              surface_id, thread_id, provider_message_id, state, result_json,
              progress_json, claim_token, claimed_at
         FROM adapter_ingress_receipts
        WHERE adapter = ?
          AND account_id = ?
          AND actor_id = ?
          AND surface_kind = ?
          AND surface_id = ?
          AND thread_id = ?
          AND provider_message_id = ?
        LIMIT 1`,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      input.threadId ?? "",
      input.providerMessageId,
    ).toArray()[0] ?? null;
  }

  private getByReceiptId(receiptId: string): AdapterIngressReceiptRow | null {
    return this.sql.exec<AdapterIngressReceiptRow>(
      `SELECT receipt_id, adapter, account_id, actor_id, surface_kind,
              surface_id, thread_id, provider_message_id, state, result_json,
              progress_json, claim_token, claimed_at
         FROM adapter_ingress_receipts
        WHERE receipt_id = ?
        LIMIT 1`,
      receiptId,
    ).toArray()[0] ?? null;
  }
}

function completedClaimFromRow(row: AdapterIngressReceiptRow): AdapterIngressReceiptClaim {
  if (row.state !== "completed" || row.result_json === null) {
    throw new Error(`Invalid adapter ingress receipt state: ${row.receipt_id}`);
  }
  return {
    state: "completed",
    receiptId: row.receipt_id,
    result: parseAdapterInboundResult(row),
  };
}

function parseAdapterInboundResult(row: AdapterIngressReceiptRow): AdapterInboundResult {
  let result: unknown;
  try {
    result = JSON.parse(row.result_json ?? "");
  } catch {
    throw new Error(`Invalid adapter ingress receipt result: ${row.receipt_id}`);
  }
  if (!isAdapterInboundResult(result)) {
    throw new Error(`Invalid adapter ingress receipt result: ${row.receipt_id}`);
  }
  return result;
}

function parseReceiptProgress(row: AdapterIngressReceiptRow): unknown {
  try {
    return JSON.parse(row.progress_json ?? "");
  } catch {
    throw new Error(`Invalid adapter ingress receipt progress: ${row.receipt_id}`);
  }
}

function immediateDeliveriesFromRow(
  row: AdapterIngressReceiptRow,
  result: AdapterInboundResult,
): AdapterIngressImmediateDelivery[] {
  if (!isAdapterSurfaceKind(row.surface_kind)) {
    throw new Error(`Invalid adapter ingress receipt surface: ${row.receipt_id}`);
  }
  const surface: AdapterSurface = {
    kind: row.surface_kind,
    id: row.surface_id,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
  };
  return adapterIngressImmediateDeliveries({
    adapter: row.adapter,
    accountId: row.account_id,
    surface,
    providerMessageId: row.provider_message_id,
    result,
  });
}

function isAdapterSurfaceKind(value: string): value is AdapterSurfaceKind {
  return value === "dm" || value === "group" || value === "channel" || value === "thread";
}

function isAdapterInboundResult(value: unknown): value is AdapterInboundResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AdapterInboundResult>;
  if (typeof result.ok !== "boolean") return false;
  if (result.replayed !== undefined) return false;
  if (result.reply !== undefined && (
    !result.reply
    || typeof result.reply !== "object"
    || typeof result.reply.deliveryId !== "string"
    || !result.reply.deliveryId
    || typeof result.reply.text !== "string"
    || (
      result.reply.replyToId !== undefined
      && typeof result.reply.replyToId !== "string"
    )
  )) {
    return false;
  }
  if (result.challenge !== undefined && (
    !result.challenge
    || typeof result.challenge !== "object"
    || typeof result.challenge.deliveryId !== "string"
    || !result.challenge.deliveryId
    || typeof result.challenge.code !== "string"
    || typeof result.challenge.prompt !== "string"
    || !Number.isFinite(result.challenge.expiresAt)
  )) {
    return false;
  }
  return true;
}

function withoutReplayMarker(result: AdapterInboundResult): AdapterInboundResult {
  const { replayed: _replayed, ...persisted } = result;
  return persisted;
}
