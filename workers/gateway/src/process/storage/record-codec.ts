/** Row codecs and history-boundary normalization for Process storage. */

import {
  type JsonObject, type ProcTraceSpan, type ResponsibilityRecord, jsonObjectSchema,
} from "@humansandmachines/gsv/protocol";
import { parseAssistantMessageMeta } from "./message-codec";
import { messageRoleSchema, traceReferenceSchema } from "./validation";
import type {
  ContextEpochRecord, ContextEpochRow, MessageRecord, MessageRow, ProcessTraceSpanRow, QueuedMessageRole,
} from "./records";

function completeToolCallGroupEnd(records: MessageRecord[], start: number): number | null {
  const record = records[start];
  if (record?.role !== "assistant") return null;
  const unmatched = new Set(
    parseAssistantMessageMeta(record.toolCalls).toolCalls?.map((call) => call.id) ?? [],
  );
  if (unmatched.size === 0) return null;

  for (let index = start + 1; index < records.length; index += 1) {
    const candidate = records[index];
    if (
      candidate?.role !== "toolResult"
      || candidate.toolCallId === null
      || !unmatched.delete(candidate.toolCallId)
    ) continue;
    if (unmatched.size === 0) return index + 1;
  }
  return records.length;
}

export function normalizeCompactionCut(
  records: MessageRecord[],
  requested: number,
  direction: "backward" | "forward",
): number {
  let cut = Math.max(0, Math.min(records.length, requested));
  for (let start = 0; start < records.length; start += 1) {
    const end = completeToolCallGroupEnd(records, start);
    if (end === null) continue;
    if (cut > start && cut < end) {
      cut = direction === "backward" ? start : end;
    }
  }
  return cut;
}

export function messageRecordFromRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    generation: row.generation,
    runId: row.run_id,
    role: messageRoleSchema.parse(row.role),
    content: row.content,
    toolCalls: row.tool_calls,
    toolCallId: row.tool_call_id,
    media: row.media_json,
    origin: row.origin_json,
    metadata: row.metadata_json ?? null,
    createdAt: row.created_at,
  };
}

export function requiredToolCallId(record: MessageRecord): string {
  if (record.toolCallId === null) {
    throw new Error(`Stored tool result message ${record.id} has no tool call id`);
  }
  return record.toolCallId;
}

export function queuedMessageRole(value: string): QueuedMessageRole {
  if (value === "user" || value === "system") {
    return value;
  }
  throw new Error(`Invalid queued message role: ${value}`);
}

export function processTraceSpanFromRow(row: ProcessTraceSpanRow): ProcTraceSpan {
  const span: ProcTraceSpan = {
    id: row.span_id,
    runId: row.run_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    startedAt: row.started_at,
  };
  if (row.parent_span_id) span.parentId = row.parent_span_id;
  if (row.ended_at !== null) span.endedAt = row.ended_at;
  if (row.reference_json) {
    span.reference = traceReferenceSchema.parse(JSON.parse(row.reference_json));
  }
  if (row.attributes_json) {
    span.attributes = jsonObjectSchema.parse(JSON.parse(row.attributes_json));
  }
  return span;
}

export function contextEpochFromRow(row: ContextEpochRow): ContextEpochRecord {
  const epoch: ContextEpochRecord = {
    id: row.epoch_id,
    generation: row.generation,
    systemPrompt: row.system_prompt,
    r12yRevision: row.r12y_revision,
    r12yCount: row.r12y_count,
    observedR12yRevision: row.observed_r12y_revision,
    r12yBaseline: parseContextEpochJson<ResponsibilityRecord[]>(row.r12y_baseline_json),
    sourceManifest: parseContextEpochJson<JsonObject>(row.source_manifest_json),
    observedProjection: row.observed_projection_json
      ? parseContextEpochJson<JsonObject>(row.observed_projection_json)
      : null,
    state: row.state,
    createdAt: row.created_at,
  };
  if (row.closed_at !== null) epoch.closedAt = row.closed_at;
  if (row.close_reason) epoch.closeReason = row.close_reason;
  if (row.archive_path) epoch.archivePath = row.archive_path;
  return epoch;
}

export function parseContextEpochJson<Value>(value: string): Value {
  // SAFETY: context epoch JSON is written only by ProcessStore from typed records.
  return JSON.parse(value) as Value;
}
