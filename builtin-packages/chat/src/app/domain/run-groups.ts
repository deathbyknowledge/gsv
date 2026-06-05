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
  let startedAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    startedAt = Math.min(startedAt, row.timestamp);
    updatedAt = Math.max(updatedAt, row.timestamp);
    if (row.kind === "message") {
      if (row.role === "user") {
        userRows.push(row);
      } else if (row.role === "assistant") {
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
        systemRows.push(row);
      }
    } else {
      toolRows.push(row);
      detailEntries.push({ kind: "tool", row });
      if (pendingHil?.runId === runId && pendingHil.callId === row.callId) {
        detailEntries.push({ kind: "hil", request: pendingHil });
      }
    }
  }

  const groupPendingHil = pendingHil?.runId === runId ? pendingHil : null;
  if (groupPendingHil && !detailEntries.some((entry) => entry.kind === "hil" && entry.request.requestId === groupPendingHil.requestId)) {
    detailEntries.push({ kind: "hil", request: groupPendingHil });
  }
  const groupPendingAssistant = activeRunId === runId ? pendingAssistant : null;
  const isRunning = groupPendingAssistant !== null
    || assistantRows.some((row) => row.streaming === true)
    || toolRows.some((row) => row.kind === "toolCall");
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
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    updatedAt,
    status: groupPendingHil ? "waiting" : isRunning ? "running" : "completed",
    pendingAssistant: groupPendingAssistant,
    pendingHil: groupPendingHil,
  };
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

function normalizeRunId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
