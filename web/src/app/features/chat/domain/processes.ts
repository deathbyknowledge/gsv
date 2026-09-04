import type {
  ProcAbortResult,
  ProcAiConfigGetResult,
  ProcAiConfigSetArgs,
  ProcAiConfigSetResult,
  ProcForkArgs,
  ProcForkResult,
  ProcHistoryCompactArgs,
  ProcHistoryCompactResult,
  ProcHistorySegment,
  ProcHistorySegmentReadArgs,
  ProcHistorySegmentReadResult,
  ProcHistorySegmentsArgs,
  ProcHilArgs,
  ProcHilDecision,
  ProcHilResult,
  ProcHistoryMessage,
  ProcHistoryResult,
  ProcHilRequest,
  ProcListEntry,
  ProcTraceArgs,
  ProcTraceResult,
} from "@humansandmachines/gsv/protocol";
import { normalizeHilRequest } from "./hil";
import { z } from "zod";

export type ChatRunState = "idle" | "running" | "queued" | "awaiting_hil";

export type ChatProcessSummary = {
  pid: string;
  uid: number;
  username: string;
  personal: boolean;
  interactive: boolean;
  parentPid: string | null;
  state: string;
  runState: ChatRunState;
  activeRunId: string | null;
  queuedCount: number;
  lastActiveAt: number | null;
  label: string | null;
  title: string;
  createdAt: number;
  cwd: string;
};

export type ChatHistoryMessageRole = ProcHistoryMessage["role"];

export type ChatHistoryMessage = {
  id: number | null;
  clientId: string;
  runId: string | null;
  role: ChatHistoryMessageRole;
  content: HistoryValue;
  text: string;
  timestamp: number | null;
  origin: ProcHistoryMessage["origin"];
  metadata: ProcHistoryMessage["metadata"];
};

export type ChatHistory = {
  pid: string;
  messages: ChatHistoryMessage[];
  messageCount: number;
  truncated: boolean;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  activeRunId: string | null;
  runState: ChatRunState;
  pendingHil: ProcHilRequest | null;
  context: Extract<ProcHistoryResult, { ok: true }>["context"];
  contextRevision: number;
  historyPolicy?: Extract<ProcHistoryResult, { ok: true }>["historyPolicy"];
};

export type ChatProcessTraceArgs = ProcTraceArgs;
export type ChatProcessTrace = Extract<ProcTraceResult, { ok: true }>;

export type ChatSendDraft = {
  pid?: string;
  conversationId?: string;
  message: string;
  media?: ChatMediaUpload[];
};

export type ChatMediaUpload = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  filename?: string;
  duration?: number;
  transcription?: string;
  body: Blob;
};

export const MAX_CHAT_PROCESS_MEDIA_BYTES = 25 * 1024 * 1024;

export type ChatHilDecision = ProcHilDecision;
export type ChatHilDecisionArgs = ProcHilArgs;
export type ChatHilDecisionResult = Extract<ProcHilResult, { ok: true }>;
export type ChatHistorySegment = ProcHistorySegment;
export type ChatHistoryCompactArgs = ProcHistoryCompactArgs;
export type ChatHistoryCompactResult = Extract<ProcHistoryCompactResult, { ok: true }>;
export type ChatForkArgs = ProcForkArgs;
export type ChatForkResult = Extract<ProcForkResult, { ok: true }>;
export type ChatHistorySegmentReadArgs = ProcHistorySegmentReadArgs;
export type ChatHistorySegmentReadResult = Extract<ProcHistorySegmentReadResult, { ok: true }>;
export type ChatHistorySegmentsArgs = ProcHistorySegmentsArgs;
export type ChatProcessAiConfig = Extract<ProcAiConfigGetResult, { ok: true }>["config"];
export type ChatProcessAiConfigSetArgs = ProcAiConfigSetArgs;
export type ChatProcessAiConfigSetResult = Extract<ProcAiConfigSetResult, { ok: true }>;

export type HistoryValue = string | number | boolean | null | HistoryValue[] | HistoryRecord;
export type HistoryRecord = { [key: string]: HistoryValue };
const historyValueSchema: z.ZodType<HistoryValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(historyValueSchema),
  z.record(z.string(), historyValueSchema),
]));
const historyRecordSchema = z.record(z.string(), historyValueSchema);

function stringifyMessageContent(value: HistoryValue): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeMessageText(value: HistoryValue, role?: ChatHistoryMessageRole): string {
  const text = z.string().safeParse(value);
  if (text.success) {
    return text.data;
  }
  const number = z.number().safeParse(value);
  const boolean = z.boolean().safeParse(value);
  if (number.success || boolean.success) {
    return String(number.success ? number.data : boolean.data);
  }

  const list = z.array(historyValueSchema).safeParse(value);
  if (list.success) {
    return list.data
      .map((part) => {
        const partText = z.string().safeParse(part);
        if (partText.success) {
          return partText.data;
        }
        const record = historyRecordSchema.safeParse(part);
        if (!record.success) {
          return "";
        }
        if ("text" in record.data) return normalizeMessageText(record.data.text, role);
        if ("output" in record.data) return normalizeMessageText(record.data.output, role);
        if ("content" in record.data) return normalizeMessageText(record.data.content, role);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  const record = historyRecordSchema.safeParse(value);
  if (record.success && "result" in record.data) {
    return normalizeMessageText(record.data.result, role);
  }
  if (record.success && "error" in record.data) {
    const text = normalizeMessageText(record.data.error, role);
    return text ? `Error: ${text}` : "";
  }

  if (record.success && "toolName" in record.data) {
    const toolName = z.string().safeParse(record.data.toolName);
    const label = toolName.success && toolName.data.trim()
      ? `Tool result: ${toolName.data.trim()}`
      : "Tool result";
    const args = "args" in record.data ? record.data.args : undefined;
    const details = args === undefined ? "" : stringifyMessageContent(args);
    return details ? `${label}\n${details}` : label;
  }

  if (role === "system" || role === "toolResult") {
    return stringifyMessageContent(value);
  }

  if (value !== null && value !== undefined) {
    return stringifyMessageContent(value);
  }

  return "";
}

function normalizeFallbackToolText(value: HistoryValue): string {
  const record = historyRecordSchema.safeParse(value);
  if (record.success && "toolName" in record.data) {
    const toolName = z.string().safeParse(record.data.toolName);
    return toolName.success && toolName.data.trim()
      ? `Tool result: ${toolName.data}`
      : "";
  }

  return "";
}

export function normalizeRunState(input: {
  activeRunId?: string | null;
  queuedCount?: number | null;
  pendingHil?: ProcHilRequest | null;
}): ChatRunState {
  if (input.pendingHil) {
    return "awaiting_hil";
  }
  if (input.activeRunId) {
    return "running";
  }
  if ((input.queuedCount ?? 0) > 0) {
    return "queued";
  }
  return "idle";
}

export function normalizeProcessSummary(process: ProcListEntry): ChatProcessSummary {
  const title = process.label?.trim() || "New work";

  return {
    pid: process.pid,
    uid: process.uid,
    username: process.username,
    personal: process.personal,
    interactive: process.interactive,
    parentPid: process.parentPid,
    state: process.state,
    runState: normalizeRunState({
      activeRunId: process.activeRunId,
      queuedCount: process.queuedCount,
    }),
    activeRunId: process.activeRunId,
    queuedCount: process.queuedCount,
    lastActiveAt: process.lastActiveAt,
    label: process.label,
    title,
    createdAt: process.createdAt,
    cwd: process.cwd,
  };
}

export function normalizeProcessSummaries(processes: readonly ProcListEntry[]): ChatProcessSummary[] {
  return [...processes]
    .map(normalizeProcessSummary)
    .sort((left, right) => {
      const leftActivity = left.lastActiveAt ?? left.createdAt;
      const rightActivity = right.lastActiveAt ?? right.createdAt;
      return rightActivity - leftActivity || left.title.localeCompare(right.title);
    });
}

export function normalizeHistoryMessage(message: ProcHistoryMessage, index: number): ChatHistoryMessage {
  const idResult = z.number().safeParse(message.id);
  const id = idResult.success ? idResult.data : null;
  const timestampResult = z.number().safeParse(message.timestamp);
  const timestamp = timestampResult.success ? timestampResult.data : null;
  const contentResult = historyValueSchema.safeParse(message.content);
  const content = contentResult.success ? contentResult.data : null;

  return {
    id,
    clientId: id === null ? `transient-${index}` : String(id),
    runId: message.runId ?? null,
    role: message.role,
    content,
    text: normalizeMessageText(content, message.role)
      || normalizeFallbackToolText(content),
    timestamp,
    origin: message.origin,
    metadata: message.metadata,
  };
}

export function normalizeHistory(result: Extract<ProcHistoryResult, { ok: true }>): ChatHistory {
  const pendingHil = normalizeHilRequest(result.pendingHil);
  const contextRevision = Math.max(
    nonNegativeInteger(result.contextRevision),
    nonNegativeInteger(result.context?.revision),
  );
  return {
    pid: result.pid,
    messages: result.messages.map(normalizeHistoryMessage),
    messageCount: result.messageCount,
    truncated: result.truncated === true,
    hasMoreBefore: result.hasMoreBefore === true,
    hasMoreAfter: result.hasMoreAfter === true,
    activeRunId: result.activeRunId ?? null,
    runState: normalizeRunState({
      activeRunId: result.activeRunId,
      pendingHil,
    }),
    pendingHil,
    context: result.context ?? null,
    contextRevision,
    historyPolicy: result.historyPolicy,
  };
}

function nonNegativeInteger(value: number | null | undefined): number {
  const parsed = z.number().finite().nonnegative().safeParse(value);
  return parsed.success ? Math.trunc(parsed.data) : 0;
}

export function didAbortActiveRun(result: ProcAbortResult): boolean {
  return result.ok === true && result.aborted;
}
