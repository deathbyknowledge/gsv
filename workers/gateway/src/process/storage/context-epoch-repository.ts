import type { ProcessStore } from "../store";
import type { JsonObject, ResponsibilityRecord, ResponsibilityTransition } from "@humansandmachines/gsv/protocol";
import {
  contextEpochFromRow, parseContextEpochJson, type ContextEpochRecord, type ContextEpochRow,
} from "./store-codecs";

/** Owns context epoch identity, transitions, and owned message references. */
export class ProcessContextEpochRepository {
  constructor(private readonly store: ProcessStore) { }

  getLiveContextEpoch(): ContextEpochRecord | null {
    const row = this.store.first<ContextEpochRow>(
      "SELECT * FROM context_epochs WHERE state = 'live' LIMIT 1",
    );
    return row ? contextEpochFromRow(row) : null;
  }

  createContextEpoch(input: {
    id: string;
    generation: number;
    systemPrompt: string;
    r12yRevision: number;
    r12yCount: number;
    r12yBaseline: ResponsibilityRecord[];
    sourceManifest: JsonObject;
    observedProjection: JsonObject;
    now: number;
  }): ContextEpochRecord {
    if (this.getLiveContextEpoch()) {
      throw new Error("A live context epoch already exists");
    }
    this.store.sql.exec(
      `INSERT INTO context_epochs (
        epoch_id, generation, system_prompt, r12y_revision, r12y_count,
        observed_r12y_revision, r12y_baseline_json,
        source_manifest_json, observed_projection_json,
        state, created_at, closed_at, close_reason,
        archive_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, NULL, NULL, NULL)`,
      input.id,
      input.generation,
      input.systemPrompt,
      input.r12yRevision,
      input.r12yCount,
      input.r12yRevision,
      JSON.stringify(input.r12yBaseline),
      JSON.stringify(input.sourceManifest),
      JSON.stringify(input.observedProjection),
      input.now,
    );
    const epoch = this.getLiveContextEpoch();
    if (!epoch) throw new Error("Context epoch was not persisted");
    return epoch;
  }

  closeLiveContextEpoch(
    reason: string,
    now: number,
    archivePath?: string,
  ): ContextEpochRecord | null {
    const current = this.getLiveContextEpoch();
    if (!current) return null;
    this.store.sql.exec(
      `UPDATE context_epochs
       SET state = 'closed', closed_at = ?, close_reason = ?, archive_path = ?
       WHERE epoch_id = ? AND state = 'live'`,
      now,
      reason,
      archivePath ?? null,
      current.id,
    );
    return this.getContextEpoch(current.id);
  }

  getContextEpoch(id: string): ContextEpochRecord | null {
    const row = this.store.first<ContextEpochRow>(
      "SELECT * FROM context_epochs WHERE epoch_id = ? LIMIT 1",
      id,
    );
    return row ? contextEpochFromRow(row) : null;
  }

  listContextEpochs(): ContextEpochRecord[] {
    return this.store.sql.exec<ContextEpochRow>(
      "SELECT * FROM context_epochs ORDER BY created_at ASC, epoch_id ASC",
    ).toArray().map(contextEpochFromRow);
  }

  appendContextEpochTransition(
    epochId: string,
    transition: ResponsibilityTransition,
    content: string,
    runId: string,
  ): number {
    const epoch = this.getContextEpoch(epochId);
    if (!epoch || epoch.state !== "live") {
      throw new Error(`Live context epoch not found: ${epochId}`);
    }
    if (transition.revision <= epoch.observedR12yRevision) {
      return epoch.observedR12yRevision;
    }
    const messageId = this.store.messages.appendMessage("system", content, { runId });
    this.store.sql.exec(
      `INSERT INTO context_epoch_transitions (
        epoch_id, revision, transition_json, message_id, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      epochId,
      transition.revision,
      JSON.stringify(transition),
      messageId,
      transition.createdAtMs,
    );
    this.store.sql.exec(
      `UPDATE context_epochs
       SET observed_r12y_revision = ?
       WHERE epoch_id = ? AND state = 'live'`,
      transition.revision,
      epochId,
    );
    return transition.revision;
  }

  advanceContextEpochObservedRevision(epochId: string, revision: number): void {
    this.store.sql.exec(
      `UPDATE context_epochs
       SET observed_r12y_revision = ?
       WHERE epoch_id = ?
         AND state = 'live'
         AND observed_r12y_revision < ?`,
      revision,
      epochId,
      revision,
    );
  }

  appendContextEpochMessage(input: {
    epochId: string;
    kind: string;
    observedProjection?: JsonObject;
    content: string;
    runId: string;
    createdAt: number;
  }): number {
    const epoch = this.getContextEpoch(input.epochId);
    if (!epoch || epoch.state !== "live") {
      throw new Error(`Live context epoch not found: ${input.epochId}`);
    }
    const messageId = this.store.messages.appendMessage("system", input.content, {
      runId: input.runId,
      createdAt: input.createdAt,
    });
    this.store.sql.exec(
      `INSERT INTO context_epoch_message_refs (
        epoch_id, message_id, kind, created_at
      ) VALUES (?, ?, ?, ?)`,
      input.epochId,
      messageId,
      input.kind,
      input.createdAt,
    );
    if (input.observedProjection) {
      this.store.sql.exec(
        `UPDATE context_epochs
         SET observed_projection_json = ?
         WHERE epoch_id = ? AND state = 'live'`,
        JSON.stringify(input.observedProjection),
        input.epochId,
      );
    }
    return messageId;
  }

  listContextEpochTransitions(epochId: string): ResponsibilityTransition[] {
    return this.store.sql.exec<{ transition_json: string; }>(
      `SELECT transition_json
       FROM context_epoch_transitions
       WHERE epoch_id = ?
       ORDER BY revision ASC`,
      epochId,
    ).toArray().map((row) => (
      parseContextEpochJson<ResponsibilityTransition>(row.transition_json)
    ));
  }

  recordContextEpochRun(runId: string, finish: JsonObject, now: number): void {
    const epoch = this.getLiveContextEpoch();
    if (!epoch) return;
    this.store.sql.exec(
      `INSERT OR IGNORE INTO context_epoch_runs (
        epoch_id, run_id, finish_json, created_at
      ) VALUES (?, ?, ?, ?)`,
      epoch.id,
      runId,
      JSON.stringify(finish),
      now,
    );
  }

  listContextEpochRuns(epochId: string): JsonObject[] {
    return this.store.sql.exec<{ finish_json: string; }>(
      `SELECT finish_json
       FROM context_epoch_runs
       WHERE epoch_id = ?
       ORDER BY created_at ASC, run_id ASC`,
      epochId,
    ).toArray().map((row) => parseContextEpochJson<JsonObject>(row.finish_json));
  }

  deleteContextEpochOwnedMessages(epochId: string): void {
    this.store.sql.exec(
      `DELETE FROM messages
       WHERE id IN (
         SELECT message_id FROM context_epoch_transitions WHERE epoch_id = ?
         UNION
         SELECT message_id FROM context_epoch_message_refs WHERE epoch_id = ?
       )`,
      epochId,
      epochId,
    );
  }
}
