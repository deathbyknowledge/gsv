/** Internal Process helpers primitives. */

import {
  type ArchivedMediaRewrite, type ArchivedMessageRecord, COMPACTION_SUMMARY_WINDOW_CHARS,
  CONTEXT_RUNWAY_ALERT_BUDGET_RATIO_BEFORE_BOUNDARY, CONTEXT_RUNWAY_ALERT_MAX_TOKENS_BEFORE_BOUNDARY,
} from "../internal/lifecycle";
import { COMPACTION_SUMMARY_SYSTEM_PROMPT } from "../../prompts/compaction";
import type { Context } from "@humansandmachines/gsv/services/inference-context";
import {
  type InteractionOrigin, type JsonObject, type ProcHistoryRecordData, type ProcHistoryContextPolicy,
  type ResourceBlock, jsonObjectSchema,
} from "@humansandmachines/gsv/protocol";
import {
  type MessageRecord, normalizeMessageMetadata, parseAssistantMessageMeta, parseMessageMetadata,
} from "../store";
import type { ProcessArchiveResult } from "../internal/contracts";
import {
  archiveThinkingSchema, archiveToolCallsSchema, archivedMessageSchema, archivedToolResultMetadataSchema,
} from "../internal/schemas";
import { normalizeToolResultOutcome } from "../internal/messages";
import { parseStoredProcessMedia } from "../media";
import { inferHistoryRecords, parseInteractionOrigin, parseInteractionOriginRecord } from "../storage/history-records";
import { renderCompactionTranscriptWindow } from "./compaction-renderer";

export { parseInteractionOrigin } from "../storage/history-records";
export { formatCompactionSummaryMessage } from "./event-renderer";

export function emptyProcessArchive(): ProcessArchiveResult {
  return {
    archivedMessages: 0,
    archives: [],
  };
}

export function mediaTypeFromContentType(
  contentType: string,
): NonNullable<ResourceBlock["mediaType"]> {
  const normalized = contentType.trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "document";
}

export function messageSnapshotsMatch(
  expected: MessageRecord[],
  current: MessageRecord[],
): boolean {
  return current.length === expected.length
    && current.every((message, index) => (
      JSON.stringify(serializeArchivedMessage(message))
      === JSON.stringify(serializeArchivedMessage(expected[index]!))
    ));
}

export function historyArchiveFilename(generation: number): string {
  return `history.gen-${generation}.jsonl.gz`;
}

export function isCompactionSummaryMessage(message: MessageRecord): boolean {
  const primary = (message.records ?? inferHistoryRecords(message))[0];
  return primary?.kind === "event" && (
    primary.payload.kind === "history.compacted"
    || (primary.payload.kind === "legacy" && primary.payload.payload.recognizedKind === "history.compacted")
  );
}

export function contextBoundaryRemainingTokens(
  inputBudgetTokens: number,
  compactAtPressure: number,
): number {
  return Math.max(
    0,
    inputBudgetTokens - Math.ceil(inputBudgetTokens * compactAtPressure),
  );
}

export function contextRunwayAlertThreshold(
  inputBudgetTokens: number,
  compactAtPressure: number,
): number {
  const boundaryRemainingTokens = contextBoundaryRemainingTokens(
    inputBudgetTokens,
    compactAtPressure,
  );
  const runwayBeforeBoundary = Math.min(
    CONTEXT_RUNWAY_ALERT_MAX_TOKENS_BEFORE_BOUNDARY,
    Math.floor(inputBudgetTokens * CONTEXT_RUNWAY_ALERT_BUDGET_RATIO_BEFORE_BOUNDARY),
  );
  return Math.min(inputBudgetTokens, boundaryRemainingTokens + runwayBeforeBoundary);
}

export function defaultHistoryPolicy(): ProcHistoryContextPolicy {
  return {
    overflow: "auto-compact",
    compactAtPressure: 0.9,
    compactToPressure: 0.4,
    updatedAt: 0,
  };
}

export function buildCompactionSummaryContext(
  messages: MessageRecord[],
  systemPrompt = COMPACTION_SUMMARY_SYSTEM_PROMPT,
): Context {
  const transcript = renderCompactionTranscriptWindow(messages, COMPACTION_SUMMARY_WINDOW_CHARS);
  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          "Process history segment JSONL:",
          transcript || "(no messages)",
          "",
          "Write the replacement summary that will remain visible in the live process history.",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
  };
}

export function serializeArchivedMessage(
  message: MessageRecord,
  mediaRewrites: ReadonlyMap<string, ArchivedMediaRewrite> = new Map(),
): JsonObject {
  const origin = parseInteractionOrigin(message.origin);
  const metadata = parseMessageMetadata(message.metadata) ?? undefined;
  const media = message.media
    ? parseStoredProcessMedia(message.media).map((item) => {
      const rewrite = item.key ? mediaRewrites.get(item.key) : undefined;
      if (rewrite && "missing" in rewrite) {
        const { key: _key, path: _path, ...metadataOnly } = item;
        return metadataOnly;
      }
      return rewrite ? { ...item, ...rewrite } : item;
    })
    : undefined;
  if (message.role === "assistant") {
    const meta = parseAssistantMessageMeta(message.toolCalls);
    return jsonObjectSchema.parse(JSON.parse(JSON.stringify({
      records: message.records?.map((record) => rewriteHistoryMedia(record, mediaRewrites)),
      id: message.id,
      generation: message.generation,
      run_id: message.runId ?? undefined,
      role: message.role,
      content: message.content,
      tool_calls: meta.toolCalls,
      thinking: meta.thinking,
      tool_call_id: message.toolCallId ?? undefined,
      media,
      origin,
      metadata,
      ts: message.createdAt,
    })));
  }

  return jsonObjectSchema.parse(JSON.parse(JSON.stringify({
    records: message.records?.map((record) => rewriteHistoryMedia(record, mediaRewrites)),
    id: message.id,
    generation: message.generation,
    run_id: message.runId ?? undefined,
    role: message.role,
    content: message.content,
    media,
    tool_calls: message.toolCalls ? JSON.parse(message.toolCalls) : undefined,
    tool_call_id: message.toolCallId ?? undefined,
    origin,
    metadata,
    ts: message.createdAt,
  })));
}

function rewriteHistoryMedia(
  record: ProcHistoryRecordData,
  rewrites: ReadonlyMap<string, ArchivedMediaRewrite>,
): ProcHistoryRecordData {
  if (record.kind !== "message" && record.kind !== "note" && record.kind !== "result") return record;
  if (!record.payload.media) return record;
  const media = record.payload.media.map((item) => {
    if (item.type === "resource") return item;
    const rewrite = item.key ? rewrites.get(item.key) : undefined;
    if (rewrite && "missing" in rewrite) {
      const { key: _key, path: _path, ...metadata } = item;
      return metadata;
    }
    if (rewrite) return { ...item, key: rewrite.key, path: rewrite.path, revision: rewrite.revision };
    return item;
  });
  switch (record.kind) {
    case "message": return { ...record, payload: { ...record.payload, media } };
    case "note": return { ...record, payload: { ...record.payload, media } };
    case "result": return { ...record, payload: { ...record.payload, media } };
  }
}

export function parseArchivedMessageRecord(
  value: Parameters<typeof archivedMessageSchema.parse>[0],
): ArchivedMessageRecord {
  const record = archivedMessageSchema.parse(value);
  const role = record.role;
  const content = record.content;
  const origin = parseInteractionOriginRecord(record.origin);
  const metadata = normalizeMessageMetadata(record.metadata) ?? undefined;
  const parsedToolResultMeta = role === "toolResult"
    ? archivedToolResultMetadataSchema.safeParse(record.tool_calls)
    : null;
  const toolResultMeta = parsedToolResultMeta?.success ? parsedToolResultMeta.data : null;
  const toolName = toolResultMeta?.toolName;
  const isError = toolResultMeta?.isError;
  const outcome = role === "toolResult"
    ? normalizeToolResultOutcome(toolResultMeta?.outcome, isError ?? false, content)
    : undefined;
  const toolCalls = archiveToolCallsSchema.safeParse(record.tool_calls);
  const thinking = archiveThinkingSchema.safeParse(record.thinking);
  const archived: ArchivedMessageRecord = {
    role,
    content,
    media: record.media,
    origin,
    metadata,
    createdAt: record.ts,
  };
  if (record.records !== undefined) archived.records = record.records;
  if (record.id !== undefined) archived.id = record.id;
  if (record.generation !== undefined) archived.generation = record.generation;
  if (record.run_id !== undefined) archived.runId = record.run_id;
  if (toolCalls.success) archived.toolCalls = toolCalls.data;
  if (thinking.success) archived.thinking = thinking.data;
  if (record.tool_call_id !== undefined) archived.toolCallId = record.tool_call_id;
  if (toolName) archived.toolName = toolName;
  if (isError !== undefined) archived.isError = isError;
  if (outcome) archived.outcome = outcome;
  return archived;
}

export function serializeInteractionOrigin(origin: InteractionOrigin | undefined): string | null {
  if (!origin) return null;
  try {
    return JSON.stringify(origin);
  } catch {
    return null;
  }
}

export function gzipMessageRecords(
  messages: MessageRecord[],
  signal?: AbortSignal,
  mediaRewrites: ReadonlyMap<string, ArchivedMediaRewrite> = new Map(),
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(signal.reason ?? new Error("Compaction cancelled"));
        return;
      }
      const message = messages[index];
      if (!message) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(
        `${index > 0 ? "\n" : ""}${JSON.stringify(serializeArchivedMessage(message, mediaRewrites))}`,
      ));
      index += 1;
    },
  }).pipeThrough(new CompressionStream("gzip"));
}

export function gzipContextEpochArchive(input: {
  header: JsonObject;
  epoch: JsonObject;
  messages: MessageRecord[];
  runBoundaries: JsonObject[];
  signal?: AbortSignal;
  mediaRewrites: ReadonlyMap<string, ArchivedMediaRewrite>;
}): ReadableStream<Uint8Array> {
  function* chunks(): Generator<string, void> {
    yield `${JSON.stringify(input.header).slice(0, -1)},"epoch":${JSON.stringify(input.epoch).slice(0, -1)},"processActivity":[`;
    for (let index = 0; index < input.messages.length; index += 1) {
      yield `${index > 0 ? "," : ""}${JSON.stringify(serializeArchivedMessage(input.messages[index]!, input.mediaRewrites))}`;
    }
    yield '],"runBoundaries":[';
    for (let index = 0; index < input.runBoundaries.length; index += 1) {
      yield `${index > 0 ? "," : ""}${JSON.stringify(input.runBoundaries[index])}`;
    }
    yield "]}}";
  }
  const parts = chunks();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (input.signal?.aborted) {
        parts.return();
        controller.error(input.signal.reason ?? new Error("Context epoch archive cancelled"));
        return;
      }
      const next = parts.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    cancel() {
      parts.return();
    },
  }).pipeThrough(new CompressionStream("gzip"));
}

export async function gunzip(input: ArrayBuffer): Promise<string> {
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
