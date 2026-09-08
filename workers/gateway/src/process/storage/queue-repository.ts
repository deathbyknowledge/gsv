import type { ProcessStore } from "../store";
import { procHistoryRecordDataSchema } from "@humansandmachines/gsv/protocol";
import { queuedMessageRole, type EnqueueMessageOptions, type QueuedMessage } from "./store-codecs";

/** Owns FIFO admissions waiting behind the active Process run. */
export class ProcessQueueRepository {
  constructor(private readonly store: ProcessStore) { }

  // --- Message queue ---

  enqueue(
    runId: string,
    message: string,
    options: EnqueueMessageOptions = {},
  ): void {
    const generation = this.store.state.getHistoryGeneration();
    this.store.sql.exec(
      `INSERT INTO message_queue (
        run_id, generation, role, kind, message, media_json, origin_json,
        provenance_json, record_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      generation,
      options.role ?? "user",
      options.kind ?? "message",
      message,
      options.media ?? null,
      options.origin ?? null,
      options.provenance ?? null,
      options.record ? JSON.stringify(procHistoryRecordDataSchema.parse(options.record)) : null,
      Date.now(),
    );
  }

  dequeue(): QueuedMessage | null {
    const row = this.store.first<{
        id: number;
        run_id: string;
        generation: number;
        role: string;
        kind: string;
        message: string;
        media_json: string | null;
        origin_json: string | null;
        provenance_json: string | null;
        record_json: string | null;
      }>(
        `SELECT id, run_id, generation, role, kind, message, media_json,
                origin_json, provenance_json, record_json
           FROM message_queue
          ORDER BY id ASC
          LIMIT 1`,
      );
    if (!row) return null;
    const record = row.record_json === null
      ? undefined
      : procHistoryRecordDataSchema.parse(JSON.parse(row.record_json));
    this.store.sql.exec("DELETE FROM message_queue WHERE id = ?", row.id);
    return {
      id: row.id,
      runId: row.run_id,
      generation: row.generation,
      role: queuedMessageRole(row.role),
      kind: row.kind,
      message: row.message,
      media: row.media_json,
      origin: row.origin_json,
      provenance: row.provenance_json,
      record,
    };
  }

  clearQueue(): void {
    this.store.sql.exec("DELETE FROM message_queue");
  }

  queueSize(): number {
    return this.store.first<{ cnt: number }>("SELECT COUNT(*) as cnt FROM message_queue")?.cnt ?? 0;
  }

  locateRunAdmission(runId: string): "queued" | "recorded" | null {
    const queued = this.store.first<{ present: number }>(
      "SELECT 1 AS present FROM message_queue WHERE run_id = ? LIMIT 1",
      runId,
    )?.present === 1;
    if (queued) return "queued";

    const recorded = this.store.first<{ present: number }>(
      "SELECT 1 AS present FROM messages WHERE run_id = ? LIMIT 1",
      runId,
    )?.present === 1;
    return recorded ? "recorded" : null;
  }
}
