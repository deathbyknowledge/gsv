import type { ThinkingContent, ToolCall } from "@humansandmachines/gsv/services/inference-context";
import {
  jsonObjectSchema, jsonValueSchema, procHistoryRecordDataSchema, resourceBlockSchema,
  type JsonObject, type JsonValue, type ProcHistoryEventKind, type ProcHistoryRecordData,
  type ResourceBlock, type ProcHistoryMedia, type InteractionOrigin,
  type ProcHistoryArchivedResultPayload,
} from "@humansandmachines/gsv/protocol";
import { TOOL_TO_SYSCALL, type ToolSyscallName } from "../../syscalls/constants";
import { parseStoredProcessMedia } from "../media";
import { materializeLegacyToolResultImages, unwrapStoredToolResult } from "../tool-result-media";
import type { ModelHistoryGroup } from "../history/model-renderer";
import { interactionOriginSchema } from "../internal/schemas";
import { normalizeToolResultOutcome } from "../internal/messages";
import { parseAssistantMessageMeta } from "./message-codec";
import { parseMessageMetadata } from "./metadata-codec";
import type { MessageRecord, MessageRow } from "./records";
import { toolResultMetaSchema } from "./validation";

type MessageHistoryOptions = {
  queueKind?: string;
  provenance?: JsonObject;
  selectedTarget?: string;
};

const LEGACY_COMPACTION_PREFIX = "Process history compacted.\n";

export function readHistoryRecord(row: MessageRow): ProcHistoryRecordData | undefined {
  if (row.kind == null && row.payload_json == null) return undefined;
  if (row.kind == null || row.payload_json == null) {
    throw new Error(`Incomplete typed history record ${row.id}`);
  }
  const record = procHistoryRecordDataSchema.parse({ kind: row.kind, payload: JSON.parse(row.payload_json) });
  // Earlier inference also promoted near-miss prefixes; reading must not turn them into summaries.
  if (record.kind === "event" && record.payload.kind === "legacy"
    && record.payload.payload.recognizedKind === "history.compacted"
    && !record.payload.payload.text.startsWith(LEGACY_COMPACTION_PREFIX)) {
    delete record.payload.payload.recognizedKind;
  }
  return record;
}

/** Preserve source projection data alongside the original message's typed members. */
export function normalizeModelHistoryGroup(message: MessageRecord): ModelHistoryGroup {
  const records = message.records ?? inferHistoryRecords(message);
  const primary = records[0];
  if (!primary) throw new Error(`History message ${message.id} has no records`);
  const media = parseStoredProcessMedia(message.media);
  const result = primary.kind === "result";
  const resultMeta = result && message.toolCalls
    ? toolResultMetaSchema.parse(JSON.parse(message.toolCalls))
    : {};
  return {
    messageId: message.id,
    generation: message.generation,
    runId: message.runId ?? null,
    createdAt: message.createdAt,
    records: [primary, ...records.slice(1)],
    metadata: parseMessageMetadata(message.metadata),
    origin: parseInteractionOrigin(message.origin),
    compatibility: {
      text: message.content,
      media,
      mediaJson: message.media,
      hasMedia: Boolean(message.media),
      isError: resultMeta.isError ?? false,
      legacyImageContent: result && media.length === 0
        ? materializeLegacyToolResultImages(message.content)
        : null,
    },
  };
}

export function parseInteractionOrigin(value: string | null | undefined): InteractionOrigin | undefined {
  if (!value) return undefined;
  try {
    return parseInteractionOriginRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function parseInteractionOriginRecord(
  value: Parameters<typeof interactionOriginSchema.safeParse>[0],
): InteractionOrigin | undefined {
  const result = interactionOriginSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Legacy shape recovery is confined to this boundary; lost source data stays unknown. */
export function inferHistoryRecords(
  message: Pick<MessageRecord, "id" | "role" | "content" | "toolCalls" | "toolCallId" | "media" | "origin" | "runId">,
  options: MessageHistoryOptions = {},
): ProcHistoryRecordData[] {
  const media = parseStoredProcessMedia(message.media);
  switch (message.role) {
    case "user": {
      const origin: Extract<ProcHistoryRecordData, { kind: "message" }>["payload"]["origin"] = {};
      const interactionOrigin = parseInteractionOrigin(message.origin);
      if (interactionOrigin) origin.interaction = interactionOrigin;
      if (options.queueKind) origin.kind = options.queueKind;
      if (options.provenance) origin.provenance = options.provenance;
      const payload: Extract<ProcHistoryRecordData, { kind: "message" }>["payload"] = {
        direction: "in", text: message.content, media, origin,
      };
      if (options.selectedTarget !== undefined) payload.selectedTarget = options.selectedTarget;
      const interaction = jsonObjectSchema.safeParse(options.provenance);
      if (interaction.success) {
        const messageId = interaction.data.messageId;
        if (isString(messageId)) payload.conversationMessageId = messageId;
        const conversationId = interaction.data.conversationId;
        if (isString(conversationId)) payload.conversationId = conversationId;
      }
      return [{ kind: "message", payload }];
    }
    case "assistant": {
      const meta = parseAssistantMessageMeta(message.toolCalls);
      return assistantHistoryRecords({
        text: message.content, thinking: meta.thinking ?? [], toolCalls: meta.toolCalls ?? [],
        media, runId: message.runId ?? null,
      });
    }
    case "toolResult": {
      if (message.toolCallId === null) throw new Error(`Stored tool result message ${message.id} has no tool call id`);
      return [{ kind: "result", payload: { ...inferHistoryResultPayload(message), callId: message.toolCallId } }];
    }
    case "system": {
      const payload: Extract<ProcHistoryRecordData, { kind: "event" }>["payload"] = {
        kind: "legacy", payload: { text: message.content }, severity: "info", audience: "model",
      };
      const recognizedKind = legacyEventKind(message.content);
      if (recognizedKind) payload.payload.recognizedKind = recognizedKind;
      return [{ kind: "event", payload }];
    }
  }
}

/** Shared result decoding preserves explicitly missing linkage in older archives. */
export function inferHistoryResultPayload(
  message: Pick<MessageRecord, "toolCallId" | "content" | "toolCalls" | "media">,
): ProcHistoryArchivedResultPayload {
  const media = parseStoredProcessMedia(message.media);
  const meta = message.toolCalls ? toolResultMetaSchema.parse(JSON.parse(message.toolCalls)) : {};
  const stored = unwrapStoredToolResult(legacyToolOutput(message.content));
  const output = stored.output;
  const payload: ProcHistoryArchivedResultPayload = {
    callId: message.toolCallId, tool: meta.toolName ?? "unknown",
    outcome: normalizeToolResultOutcome(meta.outcome, meta.isError ?? false, message.content),
    output, media: media.length > 0 ? media : stored.media, resources: historyOutputResources(output),
  };
  if (meta.isError) payload.error = { message: message.content };
  return payload;
}

export function assistantHistoryRecords(input: {
  text: string;
  thinking: ThinkingContent[];
  toolCalls: ToolCall[];
  media: ProcHistoryMedia[];
  runId: string | null;
  runControlCallIds?: readonly string[];
  resolveTarget?: (syscall: ToolSyscallName, args: JsonObject) => string | null;
}): ProcHistoryRecordData[] {
  const note: Extract<ProcHistoryRecordData, { kind: "note" }> = {
    kind: "note", payload: { text: input.text, thinking: input.thinking },
  };
  if (input.media.length > 0) note.payload.media = input.media;
  return [note, ...input.toolCalls.map((call): ProcHistoryRecordData => {
    const args = jsonObjectSchema.parse(call.arguments);
    const runControl = input.runControlCallIds?.includes(call.id) === true;
    const syscall = runControl ? null : TOOL_TO_SYSCALL[call.name] ?? null;
    const target = runControl
      ? null
      : syscall !== null && input.resolveTarget
        ? input.resolveTarget(syscall, args)
        : isString(args.target) ? args.target : null;
    const payload: Extract<ProcHistoryRecordData, { kind: "call" }>["payload"] = {
      callId: call.id, tool: call.name, syscall, args, target, runId: input.runId,
    };
    if (call.thoughtSignature !== undefined) payload.thoughtSignature = call.thoughtSignature;
    return { kind: "call", payload };
  })];
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function legacyToolOutput(content: string): JsonValue {
  try {
    return jsonValueSchema.parse(JSON.parse(content));
  } catch {
    return content;
  }
}

function legacyEventKind(text: string): ProcHistoryEventKind | undefined {
  if (text.startsWith(LEGACY_COMPACTION_PREFIX)) return "history.compacted";
  if (text.startsWith("Your last turn was plain assistant text")) return "correction.text-only";
  if (text.startsWith("Scheduled event")) return "schedule.fired";
  if (text.startsWith("Observed watched signal")) return "signal.watched";
  if (text.startsWith("Responsibility ledger revision")) return "responsibility.revision";
  if (text.startsWith("A runtime event arrived while you were busy.")) return "runtime.wake";
  return undefined;
}

/** Resource blocks are discovered from a JSON result once, while it is written. */
export function historyOutputResources(output: JsonValue): ResourceBlock[] {
  const resources: ResourceBlock[] = [];
  const pending: JsonValue[] = [output];
  const seen = new Set<string>();
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push(value[index]!);
      }
      continue;
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JsonValue is already validated; traversal must not revalidate its subtrees.
    if (value === null || typeof value !== "object") continue;
    if (value.type === "resource") {
      const block = resourceBlockSchema.safeParse(value);
      if (block.success) {
        const key = JSON.stringify(block.data);
        if (!seen.has(key)) resources.push(block.data);
        seen.add(key);
        continue;
      }
    }
    const values = Object.values(value);
    for (let index = values.length - 1; index >= 0; index -= 1) {
      pending.push(values[index]!);
    }
  }
  return resources;
}
