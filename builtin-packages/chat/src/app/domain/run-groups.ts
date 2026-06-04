import type { HilRequest, LogRow, MessageRow, PendingAssistantState, ToolRow } from "../types";

export type TranscriptRunStatus = "completed" | "running" | "waiting";

export type TranscriptRunGroup = {
  kind: "run";
  runId: string;
  rows: LogRow[];
  userRows: MessageRow[];
  assistantRows: MessageRow[];
  systemRows: MessageRow[];
  toolRows: ToolRow[];
  startedAt: number;
  updatedAt: number;
  status: TranscriptRunStatus;
  pendingAssistant: PendingAssistantState;
  pendingHil: HilRequest | null;
};

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
    || group.toolRows.length > 0
    || group.assistantRows.some((row) => (row.thinking?.filter(Boolean).length ?? 0) > 0);
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
  const systemRows: MessageRow[] = [];
  const toolRows: ToolRow[] = [];
  let startedAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;

  for (const row of rows) {
    startedAt = Math.min(startedAt, row.timestamp);
    updatedAt = Math.max(updatedAt, row.timestamp);
    if (row.kind === "toolCall" || row.kind === "toolResult") {
      toolRows.push(row);
      continue;
    }
    if (row.role === "user") {
      userRows.push(row);
    } else if (row.role === "assistant") {
      assistantRows.push(row);
    } else {
      systemRows.push(row);
    }
  }

  const groupPendingHil = pendingHil?.runId === runId ? pendingHil : null;
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
    systemRows,
    toolRows,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    updatedAt,
    status: groupPendingHil ? "waiting" : isRunning ? "running" : "completed",
    pendingAssistant: groupPendingAssistant,
    pendingHil: groupPendingHil,
  };
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
