import type { ProcHistoryArchivedRecord, ProcHistoryArchivedRecordData } from "@humansandmachines/gsv/protocol";
import type { ArchivedMessageRecord } from "../internal/lifecycle";
import { inferHistoryRecords, inferHistoryResultPayload } from "../storage/history-records";
import { stringifyAssistantMessageMeta } from "../storage/message-codec";

function archivedRecordData(message: ArchivedMessageRecord, messageId: number): ProcHistoryArchivedRecordData[] {
  if (message.records) return message.records;
  const toolCalls = message.role === "assistant"
    ? stringifyAssistantMessageMeta({ toolCalls: message.toolCalls, thinking: message.thinking }) ?? null
    : message.role === "toolResult"
      ? JSON.stringify({ toolName: message.toolName, isError: message.isError, outcome: message.outcome })
      : null;
  const source = {
    id: messageId, role: message.role, content: message.content, toolCalls,
    toolCallId: message.toolCallId ?? null,
    media: message.media === undefined ? null : JSON.stringify(message.media),
    origin: message.origin ? JSON.stringify(message.origin) : null,
    runId: message.runId ?? null,
  };
  return message.role === "toolResult"
    ? [{ kind: "result", payload: inferHistoryResultPayload(source) }]
    : inferHistoryRecords(source);
}

/** Decode before paging so missing old ids and multi-member groups have stable coordinates. */
export function archivedHistoryRecords(messages: ArchivedMessageRecord[], generation: number): ProcHistoryArchivedRecord[] {
  let id = 0;
  return messages.flatMap((message, ordinal) => {
    const messageId = ordinal + 1;
    return archivedRecordData(message, messageId).map((record, index) => {
      const result: ProcHistoryArchivedRecord = {
        ...record,
        id: ++id,
        messageId,
        index,
        generation: message.generation ?? generation,
        runId: message.runId ?? null,
        source: message.records ? "typed" : "legacy",
      };
      if (message.id !== undefined) result.sourceMessageId = message.id;
      if (message.createdAt !== undefined) result.createdAt = message.createdAt;
      if (message.metadata !== undefined) result.metadata = message.metadata;
      return result;
    });
  });
}
