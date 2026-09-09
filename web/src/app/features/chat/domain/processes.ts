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
  ProcHistorySegmentRecordsResult,
  ProcHistorySegmentsArgs,
  ProcHilArgs,
  ProcHilDecision,
  ProcHilResult,
  ProcHistoryRecord,
  ProcHistoryRecordsResult,
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

export type ChatHistory = {
  pid: string;
  records: ProcHistoryRecord[];
  cursor?: string;
  historyRevision: number;
  historyGeneration: number;
  historyResetRevision: number;
  reset: boolean;
  hasMore: boolean;
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
  /** Reuse for retries of the same draft, including its staged attachment paths. */
  idempotencyKey?: string;
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
export type ChatHistorySegmentReadResult = ProcHistorySegmentRecordsResult;
export type ChatHistorySegmentsArgs = ProcHistorySegmentsArgs;
export type ChatProcessAiConfig = Extract<ProcAiConfigGetResult, { ok: true }>["config"];
export type ChatProcessAiConfigSetArgs = ProcAiConfigSetArgs;
export type ChatProcessAiConfigSetResult = Extract<ProcAiConfigSetResult, { ok: true }>;

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

export function normalizeHistory(result: ProcHistoryRecordsResult): ChatHistory {
  const pendingHil = normalizeHilRequest(result.pendingHil);
  const contextRevision = Math.max(
    nonNegativeInteger(result.contextRevision),
    nonNegativeInteger(result.context?.revision),
  );
  return {
    pid: result.pid,
    records: result.records,
    cursor: result.cursor,
    historyRevision: result.historyRevision,
    historyGeneration: result.historyGeneration,
    historyResetRevision: result.historyResetRevision,
    reset: result.reset,
    hasMore: result.hasMore,
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
