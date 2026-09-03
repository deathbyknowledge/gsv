/** Internal Process helpers primitives. */

import {
  type ArchivedMediaRewrite, type ArchivedMessageRecord, COMPACTION_SUMMARY_WINDOW_CHARS,
  CONTEXT_RUNWAY_ALERT_BUDGET_RATIO_BEFORE_BOUNDARY, CONTEXT_RUNWAY_ALERT_MAX_TOKENS_BEFORE_BOUNDARY,
} from "../internal/lifecycle";
import { COMPACTION_SUMMARY_SYSTEM_PROMPT } from "../../prompts/compaction";
import type { Context } from "@earendil-works/pi-ai";
import {
  type InteractionOrigin, type JsonObject, type ProcHistoryContextPolicy, type ResourceBlock, jsonObjectSchema,
} from "@humansandmachines/gsv/protocol";
import {
  type MessageRecord, normalizeMessageMetadata, parseAssistantMessageMeta, parseMessageMetadata,
} from "../store";
import type { ProcessArchiveResult } from "../internal/contracts";
import {
  archiveThinkingSchema, archiveToolCallsSchema, archivedMessageSchema, archivedToolResultMetadataSchema,
  interactionOriginSchema,
} from "../internal/schemas";
import { normalizeToolResultOutcome } from "../internal/messages";
import { parseStoredProcessMedia } from "../media";

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

export function formatCompactionSummaryMessage(input: {
  archivedMessages: number;
  archivePath: string;
  summary: string;
}): string {
  return [
    "Process history compacted.",
    "",
    `Archived messages: ${input.archivedMessages}`,
    `Archive: ${input.archivePath}`,
    "",
    "Summary:",
    input.summary,
  ].join("\n");
}

export function isCompactionSummaryMessage(message: MessageRecord): boolean {
  return message.role === "system"
    && message.content.startsWith("Process history compacted.\n");
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

function renderCompactionTranscriptWindow(messages: MessageRecord[], maxChars: number): string {
  const complete: string[] = [];
  let completeChars = 0;
  for (const message of messages) {
    const remaining = maxChars - completeChars - (complete.length > 0 ? 1 : 0);
    if (message.content.length > remaining) break;
    const line = JSON.stringify(serializeArchivedMessage(message));
    if (line.length > remaining) break;
    complete.push(line);
    completeChars += line.length + (complete.length > 1 ? 1 : 0);
  }
  if (complete.length === messages.length) {
    return complete.join("\n");
  }

  const omissionBudget = JSON.stringify({ omitted_messages: messages.length }).length + 2;
  const recordsBudget = Math.max(0, maxChars - omissionBudget);
  const headBudget = Math.floor(recordsBudget * 0.35);
  const tailBudget = recordsBudget - headBudget;
  const head: string[] = [];
  const tail: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  let firstOmitted = 0;
  let lastOmitted = messages.length;

  while (firstOmitted < messages.length) {
    const line = fitCompactionRecord(messages[firstOmitted]!, headBudget - headChars);
    if (!line) break;
    head.push(line);
    headChars += line.length + 1;
    firstOmitted += 1;
  }
  while (lastOmitted > firstOmitted) {
    const line = fitCompactionRecord(messages[lastOmitted - 1]!, tailBudget - tailChars);
    if (!line) break;
    tail.unshift(line);
    tailChars += line.length + 1;
    lastOmitted -= 1;
  }

  const omitted = JSON.stringify({ omitted_messages: lastOmitted - firstOmitted });
  return [...head, omitted, ...tail].join("\n");
}

function fitCompactionRecord(message: MessageRecord, maxChars: number): string | null {
  if (maxChars <= 0) return null;
  if (message.content.length <= maxChars) {
    const full = JSON.stringify(serializeArchivedMessage(message));
    if (full.length <= maxChars) return full;
  }

  let previewChars = Math.min(message.content.length, Math.floor(maxChars / 6));
  while (previewChars >= 0) {
    const preview = JSON.stringify({
      id: message.id,
      role: message.role,
      content_preview: message.content.slice(0, previewChars),
      content_omitted_chars: message.content.length - previewChars,
      record_truncated: true,
    });
    if (preview.length <= maxChars) return preview;
    if (previewChars === 0) break;
    previewChars = Math.floor(previewChars / 2);
  }
  return null;
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
  if (record.id !== undefined) archived.id = record.id;
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

export function parseInteractionOrigin(value: string | null | undefined): InteractionOrigin | undefined {
  if (!value) return undefined;
  try {
    return parseInteractionOriginRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseInteractionOriginRecord(
  value: Parameters<typeof interactionOriginSchema.safeParse>[0],
): InteractionOrigin | undefined {
  const result = interactionOriginSchema.safeParse(value);
  return result.success ? result.data : undefined;
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

export async function gunzip(input: ArrayBuffer): Promise<string> {
  const stream = new Blob([input])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
