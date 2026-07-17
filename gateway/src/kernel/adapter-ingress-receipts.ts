import type {
  AdapterInboundResult,
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
  | { state: "claimed"; receiptId: string }
  | { state: "in_progress"; receiptId: string }
  | {
      state: "completed";
      receiptId: string;
      result: AdapterInboundResult;
    };

type AdapterIngressReceiptRow = {
  receipt_id: string;
  state: string;
  result_json: string | null;
};

/**
 * Kernel-owned idempotency boundary for normalized provider ingress.
 *
 * The claim is committed before any command, link, HIL, route, media, or
 * Process side effect. An interrupted claim intentionally remains in progress:
 * replaying an operation whose outcome is unknown would be less safe than
 * requiring operator reconciliation.
 */
export class AdapterIngressReceiptStore {
  constructor(private readonly sql: SqlStorage) {}

  claim(
    input: AdapterIngressReceiptKey & { receiptId: string },
  ): AdapterIngressReceiptClaim {
    const existing = this.get(input);
    if (existing) {
      return receiptClaimFromRow(existing);
    }

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO adapter_ingress_receipts (
        receipt_id, adapter, account_id, actor_id, surface_kind, surface_id,
        thread_id, provider_message_id, state, result_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, ?, NULL)`,
      input.receiptId,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      input.threadId ?? "",
      input.providerMessageId,
      now,
    );
    return { state: "claimed", receiptId: input.receiptId };
  }

  complete(receiptId: string, result: AdapterInboundResult): void {
    const cursor = this.sql.exec(
      `UPDATE adapter_ingress_receipts
          SET state = 'completed', result_json = ?, completed_at = ?
        WHERE receipt_id = ? AND state = 'in_progress'`,
      JSON.stringify(withoutReplayMarker(result)),
      Date.now(),
      receiptId,
    );
    if (cursor.rowsWritten !== 1) {
      throw new Error(`Adapter ingress receipt is not claimable: ${receiptId}`);
    }
  }

  private get(input: AdapterIngressReceiptKey): AdapterIngressReceiptRow | null {
    return this.sql.exec<AdapterIngressReceiptRow>(
      `SELECT receipt_id, state, result_json
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
}

function receiptClaimFromRow(row: AdapterIngressReceiptRow): AdapterIngressReceiptClaim {
  if (row.state === "in_progress") {
    return { state: "in_progress", receiptId: row.receipt_id };
  }
  if (row.state !== "completed" || row.result_json === null) {
    throw new Error(`Invalid adapter ingress receipt state: ${row.receipt_id}`);
  }

  let result: unknown;
  try {
    result = JSON.parse(row.result_json);
  } catch {
    throw new Error(`Invalid adapter ingress receipt result: ${row.receipt_id}`);
  }
  if (!isAdapterInboundResult(result)) {
    throw new Error(`Invalid adapter ingress receipt result: ${row.receipt_id}`);
  }
  return {
    state: "completed",
    receiptId: row.receipt_id,
    result,
  };
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
