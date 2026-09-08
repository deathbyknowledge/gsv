import type { JsonValue, ProcHistoryEvent, ProcHistoryRecord, ProcHistoryArchivedRecord } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import type { ChatTranscriptRow } from "./transcript";
import { formatTranscriptTime } from "./transcript";

export function historyRecordKey(record: Pick<ProcHistoryRecord, "messageId" | "index">): string {
  return `${record.messageId}:${record.index}`;
}

/** Revisions return complete original groups, including changed media and late companions. */
export function mergeHistoryRecords(current: readonly ProcHistoryRecord[], changed: readonly ProcHistoryRecord[]): ProcHistoryRecord[] {
  const replaced = new Set(changed.map((record) => record.messageId));
  return [...current.filter((record) => !replaced.has(record.messageId)), ...changed]
    .sort((left, right) => left.messageId - right.messageId || left.index - right.index);
}

function displayValue(value: JsonValue): string {
  const literal = z.string().safeParse(value);
  return literal.success ? literal.data : value === null ? "" : JSON.stringify(value, null, 2);
}

export function historyEventText(event: ProcHistoryEvent): string {
  const generic = `${event.kind}: ${JSON.stringify(event.payload)}`;
  switch (event.kind) {
    case "legacy": return event.payload.text;
    case "history.compacted": return event.payload.summary;
    case "generation.failed": return `Generation failed: ${event.payload.error}`;
    case "context.failed": return event.payload.error ?? `Context limit: ${event.payload.reason}`;
    case "runtime.failed": return event.payload.prefix ? `${event.payload.prefix}: ${event.payload.error}` : event.payload.error;
    case "delivery.failed":
    case "media.failed": return event.payload.error;
    case "context.changed": return `Context updated: ${event.payload.current.targets.length} targets, ${event.payload.current.mcpServers.length} connected services.`;
    case "context.runway": return `${event.payload.remainingInputTokens.toLocaleString()} input tokens remain before the context limit.`;
    case "responsibility.revision": return `${event.payload.transition.record.title} — ${event.payload.transition.afterState}`;
    case "correction.text-only": return `A response needs to finish with Send (${event.payload.attempt}/${event.payload.limit}).`;
    case "correction.exhausted": return `The run stopped after ${event.payload.attempts} response corrections.`;
    case "schedule.fired": return `${event.payload.scheduleName ?? event.payload.scheduleId}: ${event.payload.message}`;
    case "signal.watched": return `Observed ${event.payload.signal}${event.payload.sourcePid ? ` from ${event.payload.sourcePid}` : ""}.`;
    case "ipc.reply": return event.payload.error ?? displayValue(event.payload.response ?? null);
    case "ipc.overdue": return `Waiting for ${event.payload.targetPid ?? "process reply"}.`;
    case "ipc.timeout": return event.payload.error ?? `The reply from ${event.payload.targetPid ?? "another process"} timed out.`;
    case "adapter.work.returned": return `Returned from work process ${event.payload.workPid}.`;
    case "target.connection": return `${event.payload.label ?? event.payload.targetId} ${event.payload.event}.`;
    case "runtime.wake": return "A runtime event arrived while this process was busy.";
  }
  return generic;
}

function isRunControlCall(call: Extract<ProcHistoryRecord, { kind: "call" }>["payload"]): boolean {
  return call.syscall === null && (call.tool === "Send" || call.tool === "Shell");
}

/** One typed boundary feeds process inspection and the instrument's folded working. */
export function transcriptRowsFromRecords(records: readonly (ProcHistoryRecord | ProcHistoryArchivedRecord)[]): ChatTranscriptRow[] {
  const calls = new Map(records.flatMap((record) => record.kind === "call"
    ? [[`${record.runId ?? ""}:${record.payload.callId}`, record] as const]
    : []));
  const rows: ChatTranscriptRow[] = [];
  for (const record of records) {
    const base = {
      id: `message:${record.messageId}${record.index === 0 ? "" : `:${record.index}`}`,
      historyRecordKey: historyRecordKey(record),
      historyKind: record.kind,
      messageId: record.messageId,
      timestamp: record.createdAt ?? null,
      time: formatTranscriptTime(record.createdAt ?? null),
      runId: record.runId ?? undefined,
      status: "done" as const,
    };
    switch (record.kind) {
      case "message":
        rows.push({
          ...base, role: record.payload.direction === "in" ? "user" : "assistant",
          text: record.payload.text, media: record.payload.media,
          origin: record.payload.origin.interaction,
          messageDirection: record.payload.direction,
        });
        break;
      case "note": {
        const thinking = record.payload.thinking.map((block) => block.redacted ? "[redacted thinking]" : block.thinking).filter(Boolean);
        const fallback = record.metadata?.fallback;
        const backupModel = fallback ? { from: fallback.from, to: fallback.to, reason: fallback.reason } : undefined;
        if (record.payload.text || thinking.length || record.payload.media?.length || backupModel) {
          rows.push({ ...base, role: "assistant", text: record.payload.text, thinking, media: record.payload.media, backupModel });
        }
        break;
      }
      case "call":
        rows.push({
          ...base, id: `tool:${record.runId ?? ""}:${record.payload.callId}`, role: "tool",
          text: displayValue(record.payload.args), toolArgs: record.payload.args,
          toolCallId: record.payload.callId, toolName: record.payload.tool,
          toolSyscall: record.payload.syscall, toolTarget: record.payload.target,
          toolRunControl: isRunControlCall(record.payload),
          status: "planning", meta: record.payload.syscall ?? undefined,
        });
        break;
      case "result": {
        const call = record.payload.callId === null ? undefined : calls.get(`${record.runId ?? ""}:${record.payload.callId}`);
        const isError = record.payload.outcome !== "completed";
        const row: ChatTranscriptRow = {
          ...base, id: record.payload.callId === null ? base.id : `tool:${record.runId ?? ""}:${record.payload.callId}`, role: "toolResult",
          text: record.payload.error?.message ?? displayValue(record.payload.output),
          toolCallId: record.payload.callId ?? undefined, toolName: record.payload.tool,
          toolOutput: record.payload.output, toolOutcome: record.payload.outcome,
          toolArgs: call?.payload.args, toolSyscall: call?.payload.syscall ?? null,
          toolTarget: call?.payload.target ?? null,
          toolRunControl: call ? isRunControlCall(call.payload) : false,
          media: [...record.payload.media, ...record.payload.resources],
          isError, status: isError ? "error" : "done", meta: call?.payload.syscall ?? undefined,
        };
        const index = record.payload.callId === null ? -1 : rows.findIndex((entry) => entry.role === "tool" && entry.runId === row.runId && entry.toolCallId === row.toolCallId);
        if (index < 0) rows.push(row);
        else rows[index] = row;
        break;
      }
      case "event":
        rows.push({
          ...base, role: "system", text: historyEventText(record.payload), event: record.payload,
          isError: record.payload.severity === "error",
          status: record.payload.severity === "error" ? "error" : "done",
        });
        break;
    }
  }
  return rows.sort((left, right) => (left.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.timestamp ?? Number.MAX_SAFE_INTEGER));
}
