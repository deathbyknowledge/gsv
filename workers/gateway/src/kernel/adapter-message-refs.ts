import type { AdapterSurface } from "../adapter-interface";

/** Whose messages, on which messenger surface. A reference never resolves outside its own scope. */
export type AdapterMessageScope = {
  ownerUid: number;
  adapter: string;
  accountId: string;
  surface: Pick<AdapterSurface, "kind" | "id" | "threadId">;
};

/** The canonical message a provider message carried. `sequence` finds it after archival. */
export type AdapterMessageTarget = {
  conversationId: string;
  messageId: string;
  sequence: number;
};

/** Present when a messenger split the canonical message into several provider messages. */
export type AdapterMessageRef = AdapterMessageTarget & {
  part?: { index: number; count: number };
};

type AdapterMessageRefRow = {
  conversation_id: string;
  message_id: string;
  sequence: number;
  part_index: number;
  part_count: number;
};

/**
 * Longer than almost any quote reaches back, and short enough that a row is not a
 * permanent record of a person's messaging. Past it, the model is told plainly that
 * it can't see the quoted message.
 */
export const ADAPTER_MESSAGE_REF_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** About 200 messages a day for the whole window, at a few hundred bytes a row. */
export const ADAPTER_MESSAGE_REF_MAX_ROWS = 20_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const PRUNE_SCAN_ROWS = 500;

/**
 * Kernel-owned map from a messenger's message id to a canonical message, written for
 * both directions. Holds references, not text: the Conversation stays the only copy.
 *
 * Writing is one insert per provider message plus an hourly prune; a message that
 * quotes nothing never reads this table.
 */
export class AdapterMessageRefStore {
  private nextPruneAt = 0;

  constructor(private readonly sql: SqlStorage) {}

  /** Replays keep the first reference: a provider id names one message for its whole life. */
  record(
    scope: AdapterMessageScope,
    target: AdapterMessageTarget,
    providerMessageIds: readonly string[],
  ): void {
    const now = Date.now();
    this.prune(now);
    for (const [index, providerMessageId] of providerMessageIds.entries()) {
      if (!providerMessageId.trim()) continue;
      this.sql.exec(
        `INSERT OR IGNORE INTO adapter_message_refs (
           owner_uid, adapter, account_id, surface_kind, surface_id, thread_id, provider_message_id,
           conversation_id, message_id, sequence, part_index, part_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        scope.ownerUid,
        scope.adapter,
        scope.accountId,
        scope.surface.kind,
        scope.surface.id,
        scope.surface.threadId ?? "",
        providerMessageId,
        target.conversationId,
        target.messageId,
        target.sequence,
        index,
        providerMessageIds.length,
        now,
      );
    }
  }

  lookup(scope: AdapterMessageScope, providerMessageId: string): AdapterMessageRef | null {
    const row = this.sql.exec<AdapterMessageRefRow>(
      `SELECT conversation_id, message_id, sequence, part_index, part_count
         FROM adapter_message_refs
        WHERE owner_uid = ? AND adapter = ? AND account_id = ?
          AND surface_kind = ? AND surface_id = ? AND thread_id = ?
          AND provider_message_id = ?
          AND created_at >= ?
        LIMIT 1`,
      scope.ownerUid,
      scope.adapter,
      scope.accountId,
      scope.surface.kind,
      scope.surface.id,
      scope.surface.threadId ?? "",
      providerMessageId,
      Date.now() - ADAPTER_MESSAGE_REF_RETENTION_MS,
    ).toArray()[0];
    if (!row) return null;
    const ref: AdapterMessageRef = {
      conversationId: row.conversation_id,
      messageId: row.message_id,
      sequence: row.sequence,
    };
    if (row.part_count > 1) ref.part = { index: row.part_index, count: row.part_count };
    return ref;
  }

  private prune(now: number): void {
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + PRUNE_INTERVAL_MS;
    this.sql.exec(
      `DELETE FROM adapter_message_refs
        WHERE id <= (
          SELECT MAX(id) FROM (SELECT id, created_at FROM adapter_message_refs ORDER BY id LIMIT ?)
           WHERE created_at < ?
        )`,
      PRUNE_SCAN_ROWS,
      now - ADAPTER_MESSAGE_REF_RETENTION_MS,
    );
    this.sql.exec(
      "DELETE FROM adapter_message_refs WHERE id <= (SELECT MAX(id) FROM adapter_message_refs) - ?",
      ADAPTER_MESSAGE_REF_MAX_ROWS,
    );
  }
}
