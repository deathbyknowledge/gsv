import type { ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import {
  jsonObjectSchema, jsonValueSchema, procHistoryRecordDataSchema, resourceBlockSchema,
  type JsonObject, type JsonValue, type ProcHistoryEventKind, type ProcHistoryRecordData,
  type ResourceBlock, type ProcHistoryMedia,
} from "@humansandmachines/gsv/protocol";
import { TOOL_TO_SYSCALL } from "../../syscalls/constants";
import { parseStoredProcessMedia } from "../media";
import { unwrapStoredToolResult } from "../tool-result-media";
import { interactionOriginSchema } from "../internal/schemas";
import { normalizeToolResultOutcome } from "../internal/messages";
import { parseAssistantMessageMeta } from "./message-codec";
import type { MessageRecord, MessageRow } from "./records";
import { toolResultMetaSchema } from "./validation";

type MessageHistoryOptions = {
  queueKind?: string;
  provenance?: JsonObject;
};

export function readHistoryRecord(row: MessageRow): ProcHistoryRecordData | undefined {
  if (row.kind == null && row.payload_json == null) return undefined;
  if (row.kind == null || row.payload_json == null) {
    throw new Error(`Incomplete typed history record ${row.id}`);
  }
  return procHistoryRecordDataSchema.parse({ kind: row.kind, payload: JSON.parse(row.payload_json) });
}

/** Legacy shape recovery is confined to this boundary; lost source data stays unknown. */
export function inferHistoryRecords(
  message: MessageRecord,
  options: MessageHistoryOptions = {},
): ProcHistoryRecordData[] {
  const media = parseStoredProcessMedia(message.media);
  switch (message.role) {
    case "user": {
      const origin: Extract<ProcHistoryRecordData, { kind: "message" }>["payload"]["origin"] = {};
      if (message.origin) origin.interaction = interactionOriginSchema.parse(JSON.parse(message.origin));
      if (options.queueKind) origin.kind = options.queueKind;
      if (options.provenance) origin.provenance = options.provenance;
      const payload: Extract<ProcHistoryRecordData, { kind: "message" }>["payload"] = {
        direction: "in", text: message.content, media, origin,
      };
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
      const meta = message.toolCalls ? toolResultMetaSchema.parse(JSON.parse(message.toolCalls)) : {};
      const stored = unwrapStoredToolResult(legacyToolOutput(message.content));
      const output = stored.output;
      const payload: Extract<ProcHistoryRecordData, { kind: "result" }>["payload"] = {
        callId: message.toolCallId, tool: meta.toolName ?? "unknown",
        outcome: normalizeToolResultOutcome(meta.outcome, meta.isError ?? false, message.content),
        output, media: media.length > 0 ? media : stored.media, resources: historyOutputResources(output),
      };
      if (meta.isError) payload.error = { message: message.content };
      return [{ kind: "result", payload }];
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

export function assistantHistoryRecords(input: {
  text: string;
  thinking: ThinkingContent[];
  toolCalls: ToolCall[];
  media: ProcHistoryMedia[];
  runId: string | null;
  runControlCallIds?: readonly string[];
  resolveTarget?: (syscall: string, args: JsonObject) => string | null;
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
  if (text.startsWith("Process history compacted.")) return "history.compacted";
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
    const block = resourceBlockSchema.safeParse(value);
    if (block.success) {
      const key = JSON.stringify(block.data);
      if (!seen.has(key)) resources.push(block.data);
      seen.add(key);
    } else if (Array.isArray(value)) {
      pending.push(...value.toReversed());
    } else {
      const object = jsonObjectSchema.safeParse(value);
      if (object.success) pending.push(...Object.values(object.data).toReversed());
    }
  }
  return resources;
}
