import type { ProcessStore } from "../store";
import type {
  JsonObject, ProcHistoryEvent, ProcHistoryRecordData, ResponsibilityRecord, ResponsibilityTransition,
} from "@humansandmachines/gsv/protocol";
import {
  formatResponsibilityTransitionEvent, RESPONSIBILITY_CONTEXT_FIELDS,
} from "../../prompts/responsibility-events";
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
    runId: string,
  ): number {
    const epoch = this.getContextEpoch(epochId);
    if (!epoch || epoch.state !== "live") {
      throw new Error(`Live context epoch not found: ${epochId}`);
    }
    if (transition.revision <= epoch.observedR12yRevision) {
      return epoch.observedR12yRevision;
    }
    const knownFields = new Set<string>();
    if (epoch.sourceManifest.r12yBaselineRendered === true) {
      const baseline = epoch.r12yBaseline.find((record) => record.id === transition.responsibilityId);
      if (baseline) {
        for (const field of ["title", "state", "priority", "assignee", "dueAtMs", "nextCheckAtMs", "leaseExpiresAtMs", "blocker"] as const) {
          if (baseline[field] !== undefined && (field !== "blocker" || baseline.blocker)) knownFields.add(field);
        }
      }
    }
    const priorEvents = this.store.sql.exec<{ payload_json: string }>(
      `SELECT payload_json FROM messages
       WHERE kind = 'event' AND group_message_id IS NULL
         AND json_extract(payload_json, '$.kind') = 'responsibility.revision'
         AND json_extract(payload_json, '$.audience') != 'person'
         AND json_extract(payload_json, '$.payload.transition.responsibilityId') = ?`,
      transition.responsibilityId,
    ).toArray();
    for (const row of priorEvents) {
      const event = parseContextEpochJson<ProcHistoryEvent>(row.payload_json);
      if (event.kind !== "responsibility.revision") throw new Error("Responsibility transition references another event kind");
      const record = event.payload.transition.record;
      const fields = event.payload.contextFields ?? RESPONSIBILITY_CONTEXT_FIELDS.filter((field) => (
        record[field] !== undefined
      ));
      for (const field of fields) knownFields.add(field);
    }
    const contextFields = RESPONSIBILITY_CONTEXT_FIELDS.filter((field) => (
      transition.changedFields.includes(field)
      || (!knownFields.has(field) && transition.record[field] !== undefined)
    ));
    const content = formatResponsibilityTransitionEvent(transition, contextFields);
    const messageId = this.store.messages.appendMessage("system", content, {
      runId,
      record: {
        kind: "event",
        payload: {
          kind: "responsibility.revision",
          payload: { epochId, transition, contextFields },
          severity: "info",
          audience: "model",
        },
      },
    });
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
    record: ProcHistoryRecordData;
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
      record: input.record,
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
    this.store.state.invalidateHistoryCursors();
    this.store.sql.exec(
      `DELETE FROM messages
       WHERE COALESCE(group_message_id, id) IN (
         SELECT message_id FROM context_epoch_transitions WHERE epoch_id = ?
         UNION
         SELECT message_id FROM context_epoch_message_refs WHERE epoch_id = ?
       )`,
      epochId,
      epochId,
    );
  }
}
