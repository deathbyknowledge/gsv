import type { HilRequest, LogRow, MessageRow, PendingAssistantState, ToolRow } from "../types";

export type TranscriptRunStatus = "completed" | "running" | "waiting";

export type TranscriptRunGroup = {
  kind: "run";
  runId: string;
  rows: LogRow[];
  userRows: MessageRow[];
  assistantRows: MessageRow[];
  interimAssistantRows: MessageRow[];
  finalAssistantRows: MessageRow[];
  systemRows: MessageRow[];
  toolRows: ToolRow[];
  detailEntries: RunDetailEntry[];
  startedAt: number;
  updatedAt: number;
  status: TranscriptRunStatus;
  pendingAssistant: PendingAssistantState;
  pendingHil: HilRequest | null;
};

export type RunDetailEntry =
  | { kind: "thinking"; text: string; timestamp: number }
  | { kind: "interimText"; row: MessageRow }
  | { kind: "tool"; row: ToolRow }
  | { kind: "hil"; request: HilRequest };

export type TranscriptItem =
  | { kind: "row"; row: LogRow }
  | TranscriptRunGroup;

type RunTiming = {
  promptStartedAt: number | null;
  firstAssistantStartIndex: number;
  startedAt: number;
  updatedAt: number;
};

export function groupTranscriptRows(
  rows: LogRow[],
  pendingAssistant: PendingAssistantState,
  pendingHil: HilRequest | null,
  activeRunId?: string | null,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const activePendingRunId = pendingHil?.runId ?? normalizeRunId(activeRunId) ?? (pendingAssistant ? lastRunId(rows) : null);
  let current: { runId: string; rows: LogRow[] } | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    items.push(buildRunGroup(current.runId, current.rows, activePendingRunId, pendingAssistant, pendingHil));
    current = null;
  };

  for (const row of rows) {
    const runId = normalizeRunId(row.runId);
    if (!runId) {
      flush();
      items.push({ kind: "row", row });
      continue;
    }
    if (!current || current.runId !== runId) {
      flush();
      current = { runId, rows: [] };
    }
    current.rows.push(row);
  }

  flush();
  return items;
}

export function runHasDetails(group: TranscriptRunGroup): boolean {
  return group.pendingAssistant !== null
    || group.pendingHil !== null
    || group.detailEntries.length > 0;
}

function buildRunGroup(
  runId: string,
  rows: LogRow[],
  activeRunId: string | null,
  pendingAssistant: PendingAssistantState,
  pendingHil: HilRequest | null,
): TranscriptRunGroup {
  const userRows: MessageRow[] = [];
  const assistantRows: MessageRow[] = [];
  const interimAssistantRows: MessageRow[] = [];
  const finalAssistantRows: MessageRow[] = [];
  const systemRows: MessageRow[] = [];
  const toolRows: ToolRow[] = [];
  const detailEntries: RunDetailEntry[] = [];
  const timing = createRunTiming(rows);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === "message") {
      if (row.role === "user") {
        userRows.push(row);
      } else if (row.role === "assistant") {
        recordRunActivity(timing, row, index);
        assistantRows.push(row);
        for (const text of row.thinking?.filter(Boolean) ?? []) {
          detailEntries.push({ kind: "thinking", text, timestamp: row.timestamp });
        }
        if (assistantTextIsInterim(rows, index)) {
          interimAssistantRows.push(row);
          if (row.text.trim()) {
            detailEntries.push({ kind: "interimText", row });
          }
        } else {
          finalAssistantRows.push(row);
        }
      } else {
        recordRunActivity(timing, row, index);
        systemRows.push(row);
      }
    } else {
      recordRunActivity(timing, row, index);
      toolRows.push(row);
      detailEntries.push({ kind: "tool", row });
      if (pendingHil?.runId === runId && pendingHil.callId === row.callId) {
        detailEntries.push({ kind: "hil", request: pendingHil });
      }
    }
  }

  recordPromptOnlyRun(timing);

  const groupPendingHil = pendingHil?.runId === runId ? pendingHil : null;
  if (groupPendingHil && !detailEntries.some((entry) => entry.kind === "hil" && entry.request.requestId === groupPendingHil.requestId)) {
    recordPendingHil(timing, groupPendingHil);
    detailEntries.push({ kind: "hil", request: groupPendingHil });
  }
  const groupPendingAssistant = activeRunId === runId ? pendingAssistant : null;
  const isRunning = groupPendingAssistant !== null
    || assistantRows.some((row) => row.streaming === true);
  const { startedAt, updatedAt } = finishRunTiming(timing);
  return {
    kind: "run",
    runId,
    rows,
    userRows,
    assistantRows,
    interimAssistantRows,
    finalAssistantRows,
    systemRows,
    toolRows,
    detailEntries,
    startedAt,
    updatedAt,
    status: groupPendingHil ? "waiting" : isRunning ? "running" : "completed",
    pendingAssistant: groupPendingAssistant,
    pendingHil: groupPendingHil,
  };
}

function createRunTiming(rows: LogRow[]): RunTiming {
  return {
    promptStartedAt: firstUserTimestamp(rows),
    firstAssistantStartIndex: rows.findIndex(isAssistantRowWithStartedAt),
    startedAt: Number.POSITIVE_INFINITY,
    updatedAt: 0,
  };
}

function recordRunActivity(timing: RunTiming, row: LogRow, index: number): void {
  const startedAt = rowActivityStartedAt(timing, row, index);
  timing.startedAt = Math.min(timing.startedAt, startedAt);
  timing.updatedAt = Math.max(timing.updatedAt, row.timestamp);
}

function rowActivityStartedAt(timing: RunTiming, row: LogRow, index: number): number {
  if (row.kind === "message" && isFiniteNumber(row.startedAt)) {
    return row.startedAt;
  }
  return shouldAnchorToPrompt(timing, index)
    ? timing.promptStartedAt ?? row.timestamp
    : row.timestamp;
}

function shouldAnchorToPrompt(timing: RunTiming, index: number): boolean {
  return timing.firstAssistantStartIndex < 0 || index < timing.firstAssistantStartIndex;
}

function recordPromptOnlyRun(timing: RunTiming): void {
  if (Number.isFinite(timing.startedAt) || timing.promptStartedAt === null) {
    return;
  }
  timing.startedAt = timing.promptStartedAt;
  timing.updatedAt = Math.max(timing.updatedAt, timing.promptStartedAt);
}

function recordPendingHil(timing: RunTiming, request: HilRequest): void {
  timing.startedAt = Math.min(timing.startedAt, timing.promptStartedAt ?? request.createdAt);
  timing.updatedAt = Math.max(timing.updatedAt, request.createdAt);
}

function finishRunTiming(timing: RunTiming): { startedAt: number; updatedAt: number } {
  const startedAt = Number.isFinite(timing.startedAt) ? timing.startedAt : Date.now();
  return {
    startedAt,
    updatedAt: timing.updatedAt > 0 ? timing.updatedAt : startedAt,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAssistantRowWithStartedAt(row: LogRow): boolean {
  return row.kind === "message" &&
    row.role === "assistant" &&
    isFiniteNumber(row.startedAt);
}

function assistantTextIsInterim(rows: LogRow[], index: number): boolean {
  const row = rows[index];
  if (row?.kind !== "message" || row.role !== "assistant") {
    return false;
  }
  for (let nextIndex = index + 1; nextIndex < rows.length; nextIndex += 1) {
    const next = rows[nextIndex];
    if (next.kind === "message" && next.role === "assistant") {
      return false;
    }
    if (next.kind === "toolCall" || next.kind === "toolResult") {
      return true;
    }
  }
  return false;
}

function lastRunId(rows: LogRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const runId = normalizeRunId(rows[index].runId);
    if (runId) {
      return runId;
    }
  }
  return null;
}

function firstUserTimestamp(rows: LogRow[]): number | null {
  for (const row of rows) {
    if (row.kind === "message" && row.role === "user") {
      return row.timestamp;
    }
  }
  return null;
}

function normalizeRunId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
