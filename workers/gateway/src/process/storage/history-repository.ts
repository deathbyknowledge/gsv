import type { ProcessStore } from "../store";
import type { HistorySegmentKind, ProcessHistorySegmentRecord } from "../history";
import { normalizeCompactionCut, type MessageRecord } from "./store-codecs";

type HistorySegmentRow = {
  id: string;
  generation: number;
  kind: string;
  from_message_id: number;
  to_message_id: number;
  archive_path: string;
  summary_message_id: number | null;
  created_at: number;
};

function historySegment(row: HistorySegmentRow): ProcessHistorySegmentRecord {
  return {
    id: row.id,
    generation: row.generation,
    kind: "compaction",
    fromMessageId: row.from_message_id,
    toMessageId: row.to_message_id,
    archivePath: row.archive_path,
    summaryMessageId: row.summary_message_id,
    createdAt: row.created_at,
  };
}

/** Owns compacted history prefixes and immutable archive segment records. */
export class ProcessHistoryRepository {
  constructor(private readonly store: ProcessStore) { }

  getHistoryPrefixMessages(opts: {
    keepLast?: number;
    throughMessageId?: number;
  }): MessageRecord[] {
    const records = this.store.messages.getMessagesForGeneration();

    if (opts.keepLast !== undefined) {
      const keepLast = Math.max(0, Math.trunc(opts.keepLast));
      const compactCount = normalizeCompactionCut(
        records,
        records.length - keepLast,
        "backward",
      );
      return compactCount > 0 ? records.slice(0, compactCount) : [];
    }

    if (opts.throughMessageId !== undefined) {
      const throughMessageId = Math.trunc(opts.throughMessageId);
      const compactCount = normalizeCompactionCut(
        records,
        records.findLastIndex((record) => record.id <= throughMessageId) + 1,
        "forward",
      );
      return records.slice(0, compactCount);
    }

    return [];
  }

  compactHistoryPrefix(opts: {
    generation: number;
    fromMessageId: number;
    toMessageId: number;
    summary: string;
  }): number {
    const summaryMessageId = opts.fromMessageId;
    const now = Date.now();

    this.store.sql.exec(
      `DELETE FROM messages
        WHERE generation = ?
          AND id >= ?
          AND id <= ?`,
      opts.generation,
      opts.fromMessageId,
      opts.toMessageId,
    );
    this.store.sql.exec(
      `INSERT INTO messages (
        id, generation, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at
      ) VALUES (?, ?, 'system', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
      summaryMessageId,
      opts.generation,
      opts.summary,
      now,
    );

    return summaryMessageId;
  }

  recordHistorySegment(input: {
    id: string;
    generation: number;
    kind: HistorySegmentKind;
    fromMessageId: number;
    toMessageId: number;
    archivePath: string;
    summaryMessageId?: number | null;
  }): ProcessHistorySegmentRecord {
    const createdAt = Date.now();
    this.store.sql.exec(
      `INSERT INTO history_segments (
        id, generation, kind, from_message_id, to_message_id,
        archive_path, summary_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.generation,
      input.kind,
      input.fromMessageId,
      input.toMessageId,
      input.archivePath,
      input.summaryMessageId ?? null,
      createdAt,
    );
    return {
      id: input.id,
      generation: input.generation,
      kind: input.kind,
      fromMessageId: input.fromMessageId,
      toMessageId: input.toMessageId,
      archivePath: input.archivePath,
      summaryMessageId: input.summaryMessageId ?? null,
      createdAt,
    };
  }

  listHistorySegments(): ProcessHistorySegmentRecord[] {
    return [...this.store.sql.exec<HistorySegmentRow>(
      `SELECT id, generation, kind, from_message_id, to_message_id,
              archive_path, summary_message_id, created_at
         FROM history_segments
        ORDER BY created_at ASC, id ASC`,
    )].map(historySegment);
  }

  getHistorySegment(segmentId: string): ProcessHistorySegmentRecord | null {
    const row = this.store.first<HistorySegmentRow>(
      `SELECT id, generation, kind, from_message_id, to_message_id,
              archive_path, summary_message_id, created_at
         FROM history_segments
        WHERE id = ?
        LIMIT 1`,
      segmentId,
    );
    return row ? historySegment(row) : null;
  }
}
