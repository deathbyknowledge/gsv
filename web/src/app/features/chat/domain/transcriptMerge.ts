import type { ChatTranscriptRow } from "./transcript";

const OPTIMISTIC_USER_MATCH_WINDOW_MS = 5 * 60 * 1000;

function rowMergeKey(row: ChatTranscriptRow): string {
  if ((row.role === "tool" || row.role === "toolResult") && row.toolCallId !== undefined) {
    return row.runId ? `tool:${row.runId}:${row.toolCallId}` : `tool:${row.toolCallId}`;
  }
  if (row.historyRecordKey) return `record:${row.historyRecordKey}`;
  if (row.messageId !== null && row.messageId !== undefined) {
    return `message:${row.messageId}:${row.role ?? "message"}`;
  }
  if (row.role === "assistant" && row.runId && !row.id.startsWith("message:")) {
    return `assistant:${row.runId}`;
  }
  return row.id;
}

function rowSortValue(row: ChatTranscriptRow): number {
  if (row.timestamp !== null && row.timestamp !== undefined && Number.isFinite(row.timestamp)) {
    return row.timestamp;
  }
  if (row.messageId !== null && row.messageId !== undefined) {
    return Number(row.messageId);
  }
  return Number.MAX_SAFE_INTEGER;
}

function isOptimisticUserRow(row: ChatTranscriptRow): boolean {
  return row.role === "user" && row.id.startsWith("optimistic:user:");
}

function isPersistedUserRow(row: ChatTranscriptRow): boolean {
  return row.role === "user" && !row.id.startsWith("optimistic:user:");
}

function isTransientAssistantRow(row: ChatTranscriptRow): boolean {
  return row.role === "assistant"
    && Boolean(row.runId)
    && !row.id.startsWith("message:") && !row.historyRecordKey;
}

function isToolActivityRow(row: ChatTranscriptRow): boolean {
  return row.role === "tool" || row.role === "toolResult";
}

function isStreamFallbackToolRow(row: ChatTranscriptRow): boolean {
  const runId = row.runId;
  const toolCallId = row.toolCallId;
  if (!runId || !toolCallId) {
    return false;
  }
  return row.role === "tool"
    && row.status === "planning"
    && toolCallId.startsWith(`${runId}:tool:`);
}

function isConcreteToolRow(row: ChatTranscriptRow): boolean {
  return isToolActivityRow(row)
    && Boolean(row.runId)
    && Boolean(row.toolCallId)
    && !isStreamFallbackToolRow(row);
}

function isPersistedAssistantRow(row: ChatTranscriptRow): boolean {
  return row.role === "assistant"
    && Boolean(row.runId)
    && row.id.startsWith("message:");
}

function rowMediaCount(row: ChatTranscriptRow): number {
  return Array.isArray(row.media) ? row.media.length : 0;
}

function timestampCloseEnough(left: number | null | undefined, right: number | null | undefined): boolean {
  if (
    left === null
    || left === undefined
    || !Number.isFinite(left)
    || right === null
    || right === undefined
    || !Number.isFinite(right)
  ) {
    return true;
  }
  return Math.abs(left - right) <= OPTIMISTIC_USER_MATCH_WINDOW_MS;
}

function isMatchingPersistedUserRow(
  optimistic: ChatTranscriptRow,
  persisted: ChatTranscriptRow,
): boolean {
  return optimistic.text === persisted.text
    && rowMediaCount(optimistic) === rowMediaCount(persisted)
    && timestampCloseEnough(optimistic.timestamp, persisted.timestamp);
}

function removeMatchedOptimisticUserRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  const persistedUserRows = nextRows.filter(isPersistedUserRow);
  if (persistedUserRows.length === 0) {
    return [...currentRows];
  }
  return currentRows.filter((row) => {
    if (!isOptimisticUserRow(row)) {
      return true;
    }
    const persistedIndex = persistedUserRows.findIndex((persisted) =>
      isMatchingPersistedUserRow(row, persisted),
    );
    if (persistedIndex === -1) {
      return true;
    }
    persistedUserRows.splice(persistedIndex, 1);
    return false;
  });
}

function removeMatchedTransientAssistantRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  const persistedRunIds = new Set(
    nextRows
      .filter(isPersistedAssistantRow)
      .map((row) => row.runId)
      .filter((runId): runId is string => Boolean(runId)),
  );
  if (persistedRunIds.size === 0) {
    return [...currentRows];
  }
  return currentRows.filter((row) => (
    !isTransientAssistantRow(row) || !row.runId || !persistedRunIds.has(row.runId)
  ));
}

function removeSupersededStreamToolRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  const runsWithConcreteTools = new Set(
    nextRows
      .filter(isConcreteToolRow)
      .map((row) => row.runId)
      .filter((runId): runId is string => Boolean(runId)),
  );
  if (runsWithConcreteTools.size === 0) {
    return [...currentRows];
  }
  return currentRows.filter((row) => (
    !isStreamFallbackToolRow(row) || !row.runId || !runsWithConcreteTools.has(row.runId)
  ));
}

function reconcileTransientRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  return removeSupersededStreamToolRows(
    removeMatchedTransientAssistantRows(
      removeMatchedOptimisticUserRows(currentRows, nextRows),
      nextRows,
    ),
    nextRows,
  );
}

function shouldKeepCurrentToolRow(current: ChatTranscriptRow, next: ChatTranscriptRow): boolean {
  const sameRun = current.runId || next.runId
    ? current.runId === next.runId
    : true;
  return isConcreteToolRow(current)
    && sameRun
    && current.status !== "planning"
    && next.role === "tool"
    && next.status === "planning"
    && current.toolCallId === next.toolCallId;
}

export function mergeTranscriptRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  const reconciledCurrentRows = reconcileTransientRows(currentRows, nextRows);
  const order = new Map<string, number>();
  const merged = new Map<string, ChatTranscriptRow>();
  let index = 0;

  for (const row of reconciledCurrentRows) {
    const key = rowMergeKey(row);
    if (!order.has(key)) {
      order.set(key, index);
      index += 1;
    }
    merged.set(key, row);
  }
  for (const row of nextRows) {
    const key = rowMergeKey(row);
    if (!order.has(key)) {
      order.set(key, index);
      index += 1;
    }
    const current = merged.get(key);
    if (current && shouldKeepCurrentToolRow(current, row)) {
      merged.set(key, { ...current, toolArgs: row.toolArgs ?? current.toolArgs, toolSyscall: row.toolSyscall ?? current.toolSyscall, toolTarget: row.toolTarget ?? current.toolTarget, toolRunControl: row.toolRunControl ?? current.toolRunControl });
      continue;
    }
    merged.set(key, row);
  }

  return Array.from(merged.entries())
    .sort(([leftKey, left], [rightKey, right]) => {
      const bySortValue = rowSortValue(left) - rowSortValue(right);
      return bySortValue || (order.get(leftKey) ?? 0) - (order.get(rightKey) ?? 0);
    })
    .map(([, row]) => row);
}
