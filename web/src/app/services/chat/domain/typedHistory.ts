import type { JsonValue, ProcHistoryEvent, ProcHistoryRecord, ProcHistoryArchivedRecord, ResponsibilityState } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { t, type TextKey } from "../../../i18n/locale";
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

const RESPONSIBILITY_STATES = {
  open: "chat.event.state.open",
  active: "chat.event.state.active",
  waiting: "chat.event.state.waiting",
  resolved: "chat.event.state.resolved",
  cancelled: "chat.event.state.cancelled",
} satisfies Record<ResponsibilityState, TextKey>;

/** An event as the person reads it: the interface's own words around the Kernel's text, which shows as sent. */
export function historyEventText(event: ProcHistoryEvent): string {
  const generic = `${event.kind}: ${JSON.stringify(event.payload)}`;
  switch (event.kind) {
    case "legacy": return event.payload.text;
    case "history.compacted": return event.payload.summary;
    case "generation.failed": return t("chat.event.generationFailed", { error: event.payload.error });
    case "context.failed": return event.payload.error ?? t("chat.event.contextLimit", { reason: event.payload.reason });
    case "runtime.failed": return event.payload.prefix ? `${event.payload.prefix}: ${event.payload.error}` : event.payload.error;
    case "delivery.failed":
    case "media.failed": return event.payload.error;
    case "context.changed": return t("chat.event.contextChanged", {
      targets: t("chat.event.targets", { count: event.payload.current.targets.length }),
      services: t("chat.event.services", { count: event.payload.current.mcpServers.length }),
    });
    case "context.runway": return t("chat.event.runway", { count: event.payload.remainingInputTokens, tokens: event.payload.remainingInputTokens.toLocaleString() });
    case "responsibility.revision": return t("chat.event.responsibility", {
      title: event.payload.transition.record.title, state: t(RESPONSIBILITY_STATES[event.payload.transition.afterState]),
    });
    case "responsibility.ready": return t("chat.event.review", { count: event.payload.responsibilityIds.length });
    case "correction.text-only": return t("chat.event.correction", { attempt: event.payload.attempt, limit: event.payload.limit });
    case "correction.exhausted": return t("chat.event.correctionExhausted", { count: event.payload.attempts });
    case "schedule.fired": return `${event.payload.scheduleName ?? event.payload.scheduleId}: ${event.payload.message}`;
    case "signal.watched": return event.payload.sourcePid
      ? t("chat.event.signalFrom", { signal: event.payload.signal, source: event.payload.sourcePid })
      : t("chat.event.signal", { signal: event.payload.signal });
    case "ipc.reply": return event.payload.error ?? displayValue(event.payload.response ?? null);
    case "ipc.overdue": return event.payload.targetPid ? t("chat.event.waitingFor", { pid: event.payload.targetPid }) : t("chat.event.waitingReply");
    case "ipc.timeout": return event.payload.error
      ?? (event.payload.targetPid ? t("chat.event.replyTimeout", { pid: event.payload.targetPid }) : t("chat.event.replyTimeoutAny"));
    case "process.approval": return t("chat.event.approval", { pid: event.payload.pid, syscall: event.payload.syscall, target: event.payload.target });
    case "adapter.work.returned": return t("chat.event.returned", { pid: event.payload.workPid });
    case "contact.message": return `${event.payload.from}: ${event.payload.text || t("chat.contact.attachment")}`;
    case "target.connection": return t(event.payload.event === "connected" ? "chat.event.connected" : "chat.event.disconnected", {
      target: event.payload.label ?? event.payload.targetId,
    });
    case "runtime.wake": return t("chat.event.wake");
    case "owner.notified": return t("chat.event.ownerNotified", { channel: event.payload.channel, from: event.payload.from });
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
          conversationMessageId: record.payload.conversationMessageId,
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
          toolPurpose: record.payload.purpose,
          toolStartedAt: record.createdAt ?? null, toolCallRecordKey: historyRecordKey(record),
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
          toolStartedAt: call ? call.createdAt ?? null : undefined,
          toolCallRecordKey: call ? historyRecordKey(call) : undefined,
          toolOutput: record.payload.output, toolOutcome: record.payload.outcome,
          toolArgs: call?.payload.args, toolSyscall: call?.payload.syscall ?? null,
          toolPurpose: call?.payload.purpose,
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
          media: record.payload.media, isError: record.payload.severity === "error",
          status: record.payload.severity === "error" ? "error" : "done",
        });
        break;
    }
  }
  return rows.sort((left, right) => (left.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.timestamp ?? Number.MAX_SAFE_INTEGER));
}
