import type {
  InteractionOrigin,
  ProcContextState,
  ProcHilRequest,
  ProcToolResultOutcome,
} from "@humansandmachines/gsv/protocol";
import type { ChatHistory, ChatHistoryMessage, ChatRunState } from "./processes";

export type ChatTranscriptRowRole = "assistant" | "system" | "tool" | "toolResult" | "user";

export type ChatTranscriptRowStatus =
  | "done"
  | "error"
  | "planning"
  | "running"
  | "streaming"
  | "thinking";

export type ChatToolOutcome = ProcToolResultOutcome;

export type ChatBackupModelInfo = {
  from?: {
    provider?: string;
    model?: string;
  };
  to?: {
    provider?: string;
    model?: string;
  };
  reason?: string;
};

export type ChatTranscriptRow = {
  id: string;
  isError?: boolean;
  text: string;
  time: string;
  timestamp: number | null;
  media?: unknown[];
  messageId?: number | null;
  origin?: InteractionOrigin;
  toolArgs?: unknown;
  toolCallId?: string;
  toolName?: string;
  toolOutcome?: ChatToolOutcome;
  toolOutput?: unknown;
  toolSyscall?: string | null;
  role?: ChatTranscriptRowRole;
  meta?: string;
  runId?: string;
  status?: ChatTranscriptRowStatus;
  streaming?: boolean;
  thinking?: string[];
  backupModel?: ChatBackupModelInfo;
};

export type ChatRuntimeState = {
  activeRunId: string | null;
  context: ProcContextState | null;
  conversationId: string | null;
  messageCount: number;
  pendingHil: ProcHilRequest | null;
  rows: ChatTranscriptRow[];
  runState: ChatRunState;
};

export type ChatSignalTarget = {
  conversationId?: string | null;
  pid: string;
};

export type ChatSignalReduction = {
  matched: boolean;
  refreshHistory: boolean;
  state: ChatRuntimeState;
};

type AssistantHistory = {
  text: string;
  thinking: string[];
  toolCalls: Array<{
    args: unknown;
    callId: string;
    syscall: string | null;
    toolName: string;
  }>;
};

type ToolResultHistory = {
  callId: string;
  error: string | null;
  ok: boolean;
  outcome: ChatToolOutcome | null;
  output: unknown;
  syscall: string | null;
  toolName: string;
};

const DEFAULT_CONVERSATION_ID = "default";
const OPTIMISTIC_USER_MATCH_WINDOW_MS = 5 * 60 * 1000;

export function emptyChatRuntimeState(processId = "", conversationId: string | null = null): ChatRuntimeState {
  void processId;
  return {
    activeRunId: null,
    context: null,
    conversationId,
    messageCount: 0,
    pendingHil: null,
    rows: [],
    runState: "idle",
  };
}

export function chatRuntimeStateFromHistory(history: ChatHistory | null): ChatRuntimeState {
  if (!history) {
    return emptyChatRuntimeState();
  }

  return {
    activeRunId: history.activeRunId,
    context: history.context ?? null,
    conversationId: history.conversationId,
    messageCount: history.messageCount,
    pendingHil: history.pendingHil,
    rows: transcriptRowsFromHistory(history),
    runState: history.runState,
  };
}

export function addOptimisticUserMessage(
  state: ChatRuntimeState,
  message: string,
  conversationId?: string | null,
  media: unknown[] = [],
): ChatRuntimeState {
  const text = message.trim();
  if (!text && media.length === 0) {
    return state;
  }
  const now = Date.now();
  return {
    ...state,
    conversationId: conversationId ?? state.conversationId,
    messageCount: state.messageCount + 1,
    rows: [
      ...state.rows,
      {
        id: `optimistic:user:${now}`,
        role: "user",
        text,
        media,
        timestamp: now,
        time: formatTranscriptTime(now),
        status: "done",
      },
    ],
  };
}

export function applyChatSignal(
  state: ChatRuntimeState,
  signal: string,
  payload: unknown,
  target: ChatSignalTarget,
): ChatSignalReduction {
  if (!target.pid || !signalMatchesTarget(payload, target)) {
    return { matched: false, refreshHistory: false, state };
  }

  if (signal === "proc.changed") {
    return applyProcChanged(state, payload);
  }

  const signalRunId = asString(asRecord(payload)?.runId);
  if (
    signalRunId
    && state.activeRunId
    && signalRunId !== state.activeRunId
  ) {
    return {
      matched: true,
      refreshHistory:
        signal === "proc.run.output"
        || signal === "proc.run.finished",
      state,
    };
  }

  if (signal === "proc.run.started") {
    const record = asRecord(payload);
    const runId = asString(record?.runId);
    return {
      matched: true,
      refreshHistory: false,
      state: {
        ...state,
        activeRunId: runId ?? state.activeRunId,
        conversationId: asString(record?.conversationId) ?? state.conversationId,
        pendingHil: null,
        runState: "running",
      },
    };
  }

  if (signal === "proc.run.stream") {
    const record = asRecord(payload);
    const runId = asString(record?.runId);
    const event = asRecord(record?.event);
    if (!runId || !event) {
      return { matched: true, refreshHistory: false, state };
    }
    return {
      matched: true,
      refreshHistory: false,
      state: {
        ...state,
        activeRunId: runId,
        conversationId: asString(record?.conversationId) ?? state.conversationId,
        rows: applyStreamEvent(state.rows, runId, event),
        runState: "running",
      },
    };
  }

  if (signal === "proc.run.retrying") {
    const record = asRecord(payload);
    const runId = asString(record?.runId);
    const fallback = normalizeBackupModelInfo(record?.fallback);
    return {
      matched: true,
      refreshHistory: false,
      state: {
        ...state,
        activeRunId: runId ?? state.activeRunId,
        pendingHil: null,
        rows: runId
          ? fallback
            ? upsertBackupModelRow(clearTransientRowsForRun(state.rows, runId), runId, fallback, true)
            : ensureThinkingRow(clearTransientRowsForRun(state.rows, runId), runId)
          : state.rows,
        runState: "running",
      },
    };
  }

  if (signal === "proc.run.output") {
    const record = asRecord(payload);
    const runId = asString(record?.runId);
    return {
      matched: true,
      refreshHistory: true,
      state: {
        ...state,
        activeRunId: runId ?? state.activeRunId,
        conversationId: asString(record?.conversationId) ?? state.conversationId,
        pendingHil: null,
        rows: applyAssistantOutput(state.rows, record, runId),
        runState: "running",
      },
    };
  }

  if (signal === "proc.run.tool.started") {
    const record = asRecord(payload);
    const runId = asString(record?.runId);
    return {
      matched: true,
      refreshHistory: false,
      state: {
        ...state,
        activeRunId: runId ?? state.activeRunId,
        conversationId: asString(record?.conversationId) ?? state.conversationId,
        pendingHil: null,
        rows: upsertToolRow(state.rows, toolRowFromStarted(record)),
        runState: "running",
      },
    };
  }

  if (signal === "proc.run.hil.requested") {
    const pendingHil = normalizeHilRequest(payload);
    return {
      matched: true,
      refreshHistory: false,
      state: {
        ...state,
        activeRunId: pendingHil?.runId ?? state.activeRunId,
        conversationId: pendingHil?.conversationId ?? state.conversationId,
        pendingHil,
        runState: "awaiting_hil",
      },
    };
  }

  if (signal === "proc.run.finished") {
    const record = asRecord(payload);
    const runId = asString(record?.runId);
    const queuedCount = asNumber(record?.queuedCount) ?? 0;
    return {
      matched: true,
      refreshHistory: true,
      state: {
        ...state,
        activeRunId: state.activeRunId === runId ? null : state.activeRunId,
        pendingHil: null,
        rows: runId ? finishRowsForRun(state.rows, runId) : state.rows,
        runState: queuedCount > 0 ? "queued" : "idle",
      },
    };
  }

  if (signal === "process.exit") {
    return {
      matched: true,
      refreshHistory: true,
      state: {
        ...state,
        activeRunId: null,
        pendingHil: null,
        runState: "idle",
      },
    };
  }

  return { matched: false, refreshHistory: false, state };
}

export function transcriptRowsFromHistory(history: ChatHistory): ChatTranscriptRow[] {
  const rows: ChatTranscriptRow[] = [];

  history.messages.forEach((message, index) => {
    if (message.role === "assistant") {
      const parsed = extractAssistantHistory(message.content, message.text);
      const media = extractMessageMedia(message.content);
      const backupModel = normalizeBackupModelInfo(message.metadata?.fallback);
      if (parsed.text.trim() || parsed.thinking.length > 0 || media.length > 0) {
        rows.push({
          id: `message:${message.clientId}`,
          role: "assistant",
          text: parsed.text,
          thinking: parsed.thinking,
          messageId: message.id,
          origin: message.origin,
          timestamp: message.timestamp,
          time: formatTranscriptTime(message.timestamp),
          runId: message.runId ?? undefined,
          ...(media.length > 0 ? { media } : {}),
          ...(backupModel ? { backupModel } : {}),
          status: "done",
        });
      } else if (backupModel) {
        rows.push({
          id: `backup:${message.clientId}`,
          role: "assistant",
          text: "",
          messageId: message.id,
          origin: message.origin,
          timestamp: message.timestamp,
          time: formatTranscriptTime(message.timestamp),
          runId: message.runId ?? undefined,
          backupModel,
          status: "done",
          streaming: false,
        });
      }
      for (const toolCall of parsed.toolCalls) {
        rows.push({
          id: `tool:${toolCall.callId}`,
          role: "tool",
          text: formatToolInput(toolCall.args),
          messageId: message.id,
          origin: message.origin,
          timestamp: message.timestamp,
          time: formatTranscriptTime(message.timestamp),
          runId: message.runId ?? undefined,
          toolArgs: toolCall.args,
          toolCallId: toolCall.callId,
          toolName: toolCall.toolName,
          toolSyscall: toolCall.syscall,
          status: "planning",
          meta: toolCall.syscall ?? undefined,
        });
      }
      return;
    }

    if (message.role === "toolResult") {
      const parsed = extractToolResultHistory(message.content, message.text);
      if (parsed) {
        const row = {
          id: `tool:${parsed.callId}`,
          role: "toolResult" as const,
          text: formatToolOutput(parsed.output, parsed.error, message.text),
          messageId: message.id,
          origin: message.origin,
          timestamp: message.timestamp,
          time: formatTranscriptTime(message.timestamp),
          runId: message.runId ?? undefined,
          toolCallId: parsed.callId,
          toolName: parsed.toolName,
          ...(parsed.outcome ? { toolOutcome: parsed.outcome } : {}),
          toolOutput: parsed.output,
          toolSyscall: parsed.syscall,
          isError: !parsed.ok,
          status: parsed.ok ? "done" as const : "error" as const,
          meta: parsed.syscall ?? undefined,
        };
        const existingIndex = rows.findIndex((candidate) => sameToolActivityRow(candidate, row));
        if (existingIndex >= 0) {
          rows[existingIndex] = {
            ...rows[existingIndex],
            ...row,
            toolArgs: rows[existingIndex].toolArgs,
          };
        } else {
          rows.push(row);
        }
        return;
      }
    }

    const role = message.role === "user" || message.role === "system"
      ? message.role
      : "system";
    const media = message.role === "user" ? extractMessageMedia(message.content) : [];
    rows.push({
      id: `message:${message.clientId || index}`,
      role,
      text: message.text,
      ...(media.length > 0 ? { media } : {}),
      messageId: message.id,
      origin: message.origin,
      timestamp: message.timestamp,
      time: formatTranscriptTime(message.timestamp),
      runId: message.runId ?? undefined,
      status: "done",
    });
  });

  return rows.sort(compareTranscriptRows);
}

function compareTranscriptRows(left: ChatTranscriptRow, right: ChatTranscriptRow): number {
  return transcriptRowSortValue(left) - transcriptRowSortValue(right);
}

function transcriptRowSortValue(row: ChatTranscriptRow): number {
  if (typeof row.timestamp === "number" && Number.isFinite(row.timestamp)) {
    return row.timestamp;
  }
  if (typeof row.messageId === "number") {
    return row.messageId;
  }
  return Number.MAX_SAFE_INTEGER;
}

function isToolActivityRow(row: Pick<ChatTranscriptRow, "role">): boolean {
  return row.role === "tool" || row.role === "toolResult";
}

function sameToolActivityRow(
  left: Pick<ChatTranscriptRow, "role" | "runId" | "toolCallId">,
  right: Pick<ChatTranscriptRow, "role" | "runId" | "toolCallId">,
): boolean {
  if (!isToolActivityRow(left) || !isToolActivityRow(right) || !left.toolCallId || !right.toolCallId) {
    return false;
  }
  if (left.toolCallId !== right.toolCallId) {
    return false;
  }
  if (left.runId || right.runId) {
    return left.runId === right.runId;
  }
  return true;
}

export function formatTranscriptTime(timestamp: number | null | undefined): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function applyProcChanged(state: ChatRuntimeState, payload: unknown): ChatSignalReduction {
  const record = asRecord(payload);
  const changes = Array.isArray(record?.changes)
    ? record.changes.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
  let next = state;
  let refreshHistory = false;

  if (changes.includes("messages")) {
    const row = rowFromProcChangedMessage(record);
    refreshHistory = true;
    if (row) {
      next = {
        ...next,
        conversationId: asString(record?.conversationId) ?? next.conversationId,
        messageCount: next.messageCount + 1,
        rows: appendUniqueMessageRow(next.rows, row),
      };
    }
  }

  if (changes.includes("context")) {
    const context = normalizeContextState(record?.context ?? record);
    if (context) {
      next = {
        ...next,
        context,
        conversationId: context.conversationId,
        messageCount: context.messageCount ?? next.messageCount,
      };
      refreshHistory = true;
    }
  }

  if (typeof record?.queuedCount === "number" && record.queuedCount > 0 && next.runState === "idle") {
    next = { ...next, runState: "queued" };
  }

  return { matched: true, refreshHistory, state: next };
}

function rowFromProcChangedMessage(record: Record<string, unknown> | null): ChatTranscriptRow | null {
  if (!record) {
    return null;
  }
  const role = record.role === "user" || record.role === "assistant" || record.role === "system"
    ? record.role
    : null;
  if (!role) {
    return null;
  }
  const text = formatMessageContent(record.content);
  const media = extractMessageMedia(record.content);
  if (!text.trim() && media.length === 0) {
    return null;
  }
  const timestamp = asNumber(record.timestamp) ?? Date.now();
  const messageId = asNumber(record.messageId);
  const runId = asString(record.runId);
  return {
    id: messageId !== null ? `message:${messageId}` : `live:${role}:${timestamp}`,
    role,
    text,
    ...(media.length > 0 ? { media } : {}),
    messageId,
    origin: normalizeInteractionOrigin(record.origin),
    timestamp,
    time: formatTranscriptTime(timestamp),
    ...(runId ? { runId } : {}),
    status: "done",
  };
}

function appendUniqueMessageRow(rows: ChatTranscriptRow[], row: ChatTranscriptRow): ChatTranscriptRow[] {
  if (rows.some((candidate) => candidate.id === row.id)) {
    return rows;
  }
  const withoutMatchingOptimistic = row.role === "user"
    ? dropOneMatchingOptimisticUserRow(rows, row)
    : rows;
  return dropEmptyTransientRows(withoutMatchingOptimistic, row.runId).concat(row);
}

function dropOneMatchingOptimisticUserRow(
  rows: ChatTranscriptRow[],
  row: ChatTranscriptRow,
): ChatTranscriptRow[] {
  let dropped = false;
  return rows.filter((candidate) => {
    if (dropped || !isMatchingOptimisticUserRow(candidate, row)) {
      return true;
    }
    dropped = true;
    return false;
  });
}

function isMatchingOptimisticUserRow(candidate: ChatTranscriptRow, row: ChatTranscriptRow): boolean {
  return candidate.id.startsWith("optimistic:user:")
    && candidate.role === "user"
    && candidate.text === row.text
    && mediaCount(candidate) === mediaCount(row)
    && timestampCloseEnough(candidate.timestamp, row.timestamp);
}

function mediaCount(row: ChatTranscriptRow): number {
  return Array.isArray(row.media) ? row.media.length : 0;
}

function timestampCloseEnough(left: number | null | undefined, right: number | null | undefined): boolean {
  if (
    typeof left !== "number"
    || !Number.isFinite(left)
    || typeof right !== "number"
    || !Number.isFinite(right)
  ) {
    return true;
  }
  return Math.abs(left - right) <= OPTIMISTIC_USER_MATCH_WINDOW_MS;
}

function applyAssistantOutput(
  rows: ChatTranscriptRow[],
  record: Record<string, unknown> | null,
  runId: string | null,
): ChatTranscriptRow[] {
  const text = asString(record?.text) ?? "";
  const thinking = extractThinkingBlocks(record);
  const media = extractMessageMedia(record);
  const backupModel = normalizeBackupModelInfo(record?.fallback) ?? backupModelForRun(rows, runId);
  if (!text.trim() && thinking.length === 0 && media.length === 0) {
    return runId ? finishRowsForRun(rows, runId) : rows;
  }
  const timestamp = asNumber(record?.timestamp) ?? Date.now();
  const nextRow: ChatTranscriptRow = {
    id: runId ? `assistant:${runId}` : `assistant:${timestamp}`,
    role: "assistant",
    text,
    thinking,
    ...(media.length > 0 ? { media } : {}),
    timestamp,
    time: formatTranscriptTime(timestamp),
    ...(runId ? { runId } : {}),
    ...(backupModel ? { backupModel } : {}),
    status: "done",
    streaming: false,
  };

  const next = dropTransientAssistantRowsForOutput(rows, runId).slice();
  const existingIndex = runId
    ? findLastIndex(next, (row) => row.role === "assistant" && row.runId === runId && !row.id.startsWith("message:"))
    : -1;
  if (existingIndex >= 0) {
    next[existingIndex] = {
      ...next[existingIndex],
      ...nextRow,
      thinking: thinking.length > 0 ? thinking : next[existingIndex].thinking,
    };
    return next;
  }
  next.push(nextRow);
  return next;
}

function applyStreamEvent(
  rows: ChatTranscriptRow[],
  runId: string,
  event: Record<string, unknown>,
): ChatTranscriptRow[] {
  const eventType = asString(event.type);
  if (eventType === "thinking_start") {
    return ensureThinkingRow(rows, runId);
  }

  if (eventType === "text_delta") {
    const partialText = extractStreamPartialText(event);
    if (partialText !== null) {
      return setAssistantStreamText(rows, runId, partialText);
    }
    const delta = asString(event.delta) ?? "";
    return delta ? appendAssistantDelta(rows, runId, delta) : rows;
  }

  if (eventType === "thinking_delta") {
    const delta = asString(event.delta) ?? "";
    return delta ? appendAssistantThinkingDelta(rows, runId, delta) : rows;
  }

  if (eventType === "toolcall_start" || eventType === "toolcall_delta" || eventType === "toolcall_end") {
    const toolRow = toolRowFromStreamEvent(event, runId);
    return toolRow ? upsertToolRow(rows, toolRow) : rows;
  }

  if (eventType === "done" || eventType === "error") {
    return finishRowsForRun(rows, runId);
  }

  return rows;
}

function ensureThinkingRow(rows: ChatTranscriptRow[], runId: string): ChatTranscriptRow[] {
  if (rows.some((row) => row.role === "assistant" && row.runId === runId && !row.text.trim() && !row.backupModel)) {
    return rows;
  }
  const now = Date.now();
  return rows.concat({
    id: `assistant:${runId}`,
    role: "assistant",
    text: "",
    timestamp: now,
    time: formatTranscriptTime(now),
    runId,
    status: "thinking",
    streaming: true,
  });
}

function appendAssistantDelta(rows: ChatTranscriptRow[], runId: string, delta: string): ChatTranscriptRow[] {
  const backupModel = backupModelForRun(rows, runId);
  const next = dropTransientAssistantRowsForOutput(rows, runId).slice();
  const index = findLastIndex(next, (row) => row.role === "assistant" && row.runId === runId && !row.id.startsWith("message:"));
  const now = Date.now();
  if (index >= 0) {
    next[index] = {
      ...next[index],
      text: `${next[index].text}${delta}`,
      ...(backupModel && !next[index].backupModel ? { backupModel } : {}),
      status: "streaming",
      streaming: true,
    };
    return next;
  }
  next.push({
    id: `assistant:${runId}`,
    role: "assistant",
    text: delta,
    timestamp: now,
    time: formatTranscriptTime(now),
    runId,
    ...(backupModel ? { backupModel } : {}),
    status: "streaming",
    streaming: true,
  });
  return next;
}

function setAssistantStreamText(rows: ChatTranscriptRow[], runId: string, text: string): ChatTranscriptRow[] {
  const backupModel = backupModelForRun(rows, runId);
  const next = dropTransientAssistantRowsForOutput(rows, runId).slice();
  const index = findLastIndex(next, (row) => row.role === "assistant" && row.runId === runId && !row.id.startsWith("message:"));
  const now = Date.now();
  if (index >= 0) {
    next[index] = {
      ...next[index],
      text,
      ...(backupModel && !next[index].backupModel ? { backupModel } : {}),
      status: "streaming",
      streaming: true,
    };
    return next;
  }
  next.push({
    id: `assistant:${runId}`,
    role: "assistant",
    text,
    timestamp: now,
    time: formatTranscriptTime(now),
    runId,
    ...(backupModel ? { backupModel } : {}),
    status: "streaming",
    streaming: true,
  });
  return next;
}

function extractStreamPartialText(event: Record<string, unknown>): string | null {
  const partial = asRecord(event.partial);
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const textBlocks = content.flatMap((block) => {
    const text = extractTextContent(block);
    return text !== null ? [text] : [];
  });
  return textBlocks.length > 0 ? textBlocks.join("") : null;
}

function extractTextContent(value: unknown): string | null {
  const record = asRecord(value);
  return record?.type === "text" && typeof record.text === "string" ? record.text : null;
}

function appendAssistantThinkingDelta(rows: ChatTranscriptRow[], runId: string, delta: string): ChatTranscriptRow[] {
  const next = rows.slice();
  const index = findLastIndex(next, (row) => row.role === "assistant" && row.runId === runId && !row.id.startsWith("message:"));
  const now = Date.now();
  if (index >= 0) {
    const thinking = next[index].thinking && next[index].thinking.length > 0
      ? next[index].thinking!.slice()
      : [""];
    thinking[thinking.length - 1] = `${thinking[thinking.length - 1] ?? ""}${delta}`;
    next[index] = {
      ...next[index],
      thinking,
      status: "streaming",
      streaming: true,
    };
    return next;
  }
  next.push({
    id: `assistant:${runId}`,
    role: "assistant",
    text: "",
    thinking: [delta],
    timestamp: now,
    time: formatTranscriptTime(now),
    runId,
    status: "streaming",
    streaming: true,
  });
  return next;
}

function finishRowsForRun(rows: ChatTranscriptRow[], runId: string): ChatTranscriptRow[] {
  return rows
    .filter((row) => !(row.role === "assistant" && row.runId === runId && !row.text.trim() && !(row.thinking?.length) && !row.backupModel))
    .map((row) => {
      if (row.runId !== runId || !row.streaming) {
        return row;
      }
      return {
        ...row,
        streaming: false,
        status: row.status === "streaming" || row.status === "thinking" ? "done" as const : row.status,
      };
    });
}

function clearTransientRowsForRun(rows: ChatTranscriptRow[], runId: string): ChatTranscriptRow[] {
  const latestDurableToolIndex = findLastIndex(rows, (row) =>
    row.runId === runId && row.role === "toolResult"
  );
  return rows.filter((row, index) => {
    if (index <= latestDurableToolIndex || row.runId !== runId) {
      return true;
    }
    if (row.role === "assistant" && !row.id.startsWith("message:")) {
      return false;
    }
    return !(row.role === "tool" && row.status === "planning");
  });
}

function dropEmptyTransientRows(rows: ChatTranscriptRow[], runId?: string | null): ChatTranscriptRow[] {
  return rows.filter((row) => {
    if (row.role !== "assistant" || row.id.startsWith("message:")) {
      return true;
    }
    if (runId && row.runId !== runId) {
      return true;
    }
    return row.text.trim().length > 0 || Boolean(row.thinking?.length) || Boolean(row.backupModel);
  });
}

function dropTransientAssistantRowsForOutput(rows: ChatTranscriptRow[], runId?: string | null): ChatTranscriptRow[] {
  return rows.filter((row) => {
    if (row.role !== "assistant" || row.id.startsWith("message:")) {
      return true;
    }
    if (runId && row.runId !== runId) {
      return true;
    }
    return row.text.trim().length > 0 || Boolean(row.thinking?.length);
  });
}

function backupModelForRun(rows: ChatTranscriptRow[], runId: string | null | undefined): ChatBackupModelInfo | null {
  if (!runId) {
    return null;
  }
  const row = [...rows].reverse().find((candidate) => candidate.runId === runId && candidate.backupModel);
  return row?.backupModel ?? null;
}

function upsertBackupModelRow(
  rows: ChatTranscriptRow[],
  runId: string,
  backupModel: ChatBackupModelInfo,
  running: boolean,
): ChatTranscriptRow[] {
  const next = rows.slice();
  const index = next.findIndex((row) => row.id === `backup:${runId}`);
  const now = Date.now();
  const row: ChatTranscriptRow = {
    id: `backup:${runId}`,
    role: "assistant",
    text: "",
    timestamp: now,
    time: formatTranscriptTime(now),
    runId,
    backupModel,
    status: running ? "running" : "done",
    streaming: running,
  };
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...row,
    };
    return next;
  }
  next.push(row);
  return next;
}

function toolRowFromStarted(record: Record<string, unknown> | null): ChatTranscriptRow {
  const now = Date.now();
  const callId = asString(record?.callId) ?? `tool:${now}`;
  const toolName = asString(record?.name) ?? "Tool";
  const syscall = inferToolSyscall(toolName, asString(record?.syscall));
  return {
    id: `tool:${callId}`,
    role: "tool",
    text: formatToolInput(record?.args ?? {}),
    timestamp: now,
    time: formatTranscriptTime(now),
    toolArgs: record?.args ?? {},
    toolCallId: callId,
    toolName,
    toolSyscall: syscall,
    runId: asString(record?.runId) ?? undefined,
    status: "running",
    meta: syscall ?? undefined,
  };
}

function toolRowFromStreamEvent(event: Record<string, unknown>, runId: string): ChatTranscriptRow | null {
  const contentIndex = asNumber(event.contentIndex);
  const rawToolCall = asRecord(event.toolCall) ?? streamToolCallBlock(event);
  if (!rawToolCall) {
    return null;
  }
  const fallbackCallId = contentIndex !== null ? `${runId}:tool:${contentIndex}` : "";
  const callId = asString(rawToolCall.id) ?? asString(rawToolCall.callId) ?? fallbackCallId;
  if (!callId) {
    return null;
  }
  const toolName = asString(rawToolCall.name) ?? "Tool";
  const args = rawToolCall.arguments ?? rawToolCall.args ?? {};
  const syscall = inferToolSyscall(toolName, asString(rawToolCall.syscall));
  const now = Date.now();
  return {
    id: `tool:${callId}`,
    role: "tool",
    text: formatToolInput(args),
    timestamp: now,
    time: formatTranscriptTime(now),
    toolArgs: args,
    toolCallId: callId,
    toolName,
    toolSyscall: syscall,
    runId,
    status: "planning",
    meta: syscall ?? undefined,
  };
}

function streamToolCallBlock(event: Record<string, unknown>): Record<string, unknown> | null {
  const contentIndex = asNumber(event.contentIndex);
  if (contentIndex === null) {
    return null;
  }
  const partial = asRecord(event.partial);
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const block = asRecord(content[contentIndex]);
  return block?.type === "toolCall" ? block : null;
}

function upsertToolRow(rows: ChatTranscriptRow[], row: ChatTranscriptRow): ChatTranscriptRow[] {
  const next = dropSupersededStreamPlanningRows(rows, row);
  const index = next.findIndex((candidate) => sameToolActivityRow(candidate, row));
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...row,
      toolArgs: row.toolArgs ?? next[index].toolArgs,
      toolSyscall: row.toolSyscall ?? next[index].toolSyscall,
    };
    return next;
  }
  next.push(row);
  return next;
}

function dropSupersededStreamPlanningRows(
  rows: ChatTranscriptRow[],
  row: ChatTranscriptRow,
): ChatTranscriptRow[] {
  const runId = row.runId;
  const toolCallId = row.toolCallId;
  if (!runId || !toolCallId || isStreamFallbackToolCallId(runId, toolCallId)) {
    return rows.slice();
  }
  return rows.filter((candidate) => {
    if (
      candidate.runId !== runId
      || candidate.role !== "tool"
      || candidate.status !== "planning"
      || !candidate.toolCallId
    ) {
      return true;
    }
    return !isStreamFallbackToolCallId(runId, candidate.toolCallId);
  });
}

function isStreamFallbackToolCallId(runId: string, toolCallId: string): boolean {
  return toolCallId.startsWith(`${runId}:tool:`);
}

function extractAssistantHistory(content: unknown, fallbackText: string): AssistantHistory {
  const record = asRecord(content);
  if (!record) {
    return {
      text: typeof content === "string" ? content : fallbackText,
      thinking: [],
      toolCalls: [],
    };
  }

  const text = asString(record.text) ?? fallbackText;
  const thinking = (Array.isArray(record.thinking) ? record.thinking : [])
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      const block = asRecord(item);
      return (asString(block?.thinking) ?? asString(block?.text) ?? "").trim();
    })
    .filter(Boolean);
  const toolCalls: AssistantHistory["toolCalls"] = (Array.isArray(record.toolCalls) ? record.toolCalls : [])
    .map((item, index): AssistantHistory["toolCalls"][number] | null => {
      const call = asRecord(item);
      if (!call) {
        return null;
      }
      const toolName = asString(call.name) ?? "Tool";
      const callId = asString(call.id) ?? asString(call.callId) ?? `history-tool-${index}`;
      return {
        toolName,
        callId,
        args: (call.arguments ?? call.args ?? {}) as unknown,
        syscall: inferToolSyscall(toolName, asString(call.syscall)),
      };
    })
    .filter((item): item is AssistantHistory["toolCalls"][number] => item !== null);

  return { text, thinking, toolCalls };
}

function extractToolResultHistory(content: unknown, fallbackText: string): ToolResultHistory | null {
  const record = asRecord(content);
  const toolName = asString(record?.toolName) ?? asString(record?.name);
  if (!toolName) {
    return null;
  }
  const callId = asString(record?.toolCallId) ?? asString(record?.callId) ?? asString(record?.id) ?? toolName;
  const outcome = normalizeToolOutcome(record?.outcome);
  return {
    toolName,
    callId,
    ok: outcome === "completed" || (outcome === null && (record?.ok === true || record?.isError !== true)),
    outcome,
    output: record?.output ?? fallbackText,
    error: asString(record?.error),
    syscall: inferToolSyscall(toolName, asString(record?.syscall)),
  };
}

function normalizeToolOutcome(value: unknown): ChatToolOutcome | null {
  return value === "cancelled"
      || value === "completed"
      || value === "denied"
      || value === "failed"
    ? value
    : null;
}

function extractThinkingBlocks(value: unknown): string[] {
  const record = asRecord(value);
  const raw = Array.isArray(record?.thinking) ? record.thinking : [];
  return raw
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      const block = asRecord(item);
      return (asString(block?.thinking) ?? asString(block?.text) ?? "").trim();
    })
    .filter(Boolean);
}

function normalizeHilRequest(value: unknown): ProcHilRequest | null {
  const record = asRecord(value);
  const pid = asString(record?.pid);
  const requestId = asString(record?.requestId);
  const runId = asString(record?.runId);
  const callId = asString(record?.callId);
  const toolName = asString(record?.toolName);
  const syscall = asString(record?.syscall);
  if (!pid || !requestId || !runId || !callId || !toolName || !syscall) {
    return null;
  }
  return {
    pid,
    requestId,
    runId,
    conversationId: asString(record?.conversationId) ?? DEFAULT_CONVERSATION_ID,
    callId,
    toolName,
    syscall,
    args: asRecord(record?.args) ?? {},
    createdAt: asNumber(record?.createdAt) ?? Date.now(),
  };
}

function normalizeContextState(value: unknown): ProcContextState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const conversationId = asString(record.conversationId);
  if (!conversationId) {
    return null;
  }
  return record as ProcContextState;
}

function signalMatchesTarget(payload: unknown, target: ChatSignalTarget): boolean {
  const record = asRecord(payload);
  if (!record) {
    return false;
  }
  const pid = asString(record.pid);
  if (pid && pid !== target.pid) {
    return false;
  }
  const signalConversation = asString(record.conversationId);
  if (!signalConversation) {
    return true;
  }
  const targetConversation = target.conversationId || DEFAULT_CONVERSATION_ID;
  return signalConversation === targetConversation;
}

function formatMessageContent(value: unknown): string {
  const record = asRecord(value);
  if (record && "text" in record) {
    const text = asString(record.text);
    if (text !== null) {
      return text;
    }
  }
  if (typeof value === "string") {
    return value;
  }
  return prettyJson(value);
}

function extractMessageMedia(value: unknown): unknown[] {
  const record = asRecord(value);
  return Array.isArray(record?.media) ? record.media : [];
}

function normalizeInteractionOrigin(value: unknown): InteractionOrigin | undefined {
  const record = asRecord(value);
  return typeof record?.kind === "string" ? record as unknown as InteractionOrigin : undefined;
}

function normalizeBackupModelInfo(value: unknown): ChatBackupModelInfo | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const from = normalizeBackupModelRef(record.from);
  const to = normalizeBackupModelRef(record.to);
  const reason = asString(record.reason);
  if (!from && !to && !reason && record.used !== true) {
    return null;
  }
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(reason ? { reason } : {}),
  };
}

function normalizeBackupModelRef(value: unknown): ChatBackupModelInfo["from"] | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const provider = asString(record.provider);
  const model = asString(record.model);
  if (!provider && !model) {
    return null;
  }
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function formatToolInput(value: unknown): string {
  const text = prettyJson(value);
  return text === "{}" ? "Waiting for tool input." : text;
}

function formatToolOutput(output: unknown, error: string | null | undefined, fallback: string): string {
  if (error) {
    return error;
  }
  if (output === undefined || output === null) {
    return fallback || "Tool completed.";
  }
  if (typeof output === "string") {
    return output;
  }
  return prettyJson(output);
}

function inferToolSyscall(toolName: string, syscall?: string | null): string | null {
  if (syscall?.trim()) {
    return syscall.trim();
  }
  switch (toolName) {
    case "Read":
      return "fs.read";
    case "Search":
      return "fs.search";
    case "Shell":
      return "shell.exec";
    case "Write":
      return "fs.write";
    case "Edit":
      return "fs.edit";
    case "Delete":
      return "fs.delete";
    case "CodeMode":
      return "codemode.exec";
    default:
      return null;
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}
