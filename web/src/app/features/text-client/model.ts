import type { ChatProcessSummary } from "../chat/domain/processes";
import type { ChatRuntimeState, ChatTranscriptRow } from "../chat/domain/transcript";

export const TEXT_WORK_CATEGORIES = [
  "searching-files",
  "reading-files",
  "writing-files",
  "editing-files",
  "deleting-files",
  "running-commands",
  "running-code",
  "using-tools",
] as const;

export type TextWorkCategory = typeof TEXT_WORK_CATEGORIES[number];

export type TextMomentRole = "user" | "assistant" | "system";

export type TextActivityLine = {
  key: string;
  category: TextWorkCategory | "thinking";
  count: number;
  text: string;
};

export type TextCompletedWorkSummary = {
  key: string;
  category: TextWorkCategory;
  count: number;
  text: string;
};

export type TextMoment = {
  key: string;
  role: TextMomentRole;
  text: string;
  media: readonly unknown[];
  streaming: boolean;
  error: boolean;
  completedWork: readonly TextCompletedWorkSummary[];
};

export type TextMomentProjection = {
  moments: readonly TextMoment[];
  activityLines: readonly TextActivityLine[];
};

const UNSCOPED_RUN = "unscoped";

type WorkCounts = Map<TextWorkCategory, number>;

function rowRole(row: ChatTranscriptRow): TextMomentRole | null {
  return row.role === "user" || row.role === "assistant" || row.role === "system"
    ? row.role
    : null;
}

function rowRunKey(row: Pick<ChatTranscriptRow, "runId">): string {
  const runId = row.runId?.trim();
  return runId ? `run:${runId}` : UNSCOPED_RUN;
}

function isStreaming(row: ChatTranscriptRow): boolean {
  return row.streaming === true || row.status === "streaming" || row.status === "thinking";
}

function isError(row: ChatTranscriptRow): boolean {
  return row.isError === true || row.status === "error";
}

function isToolRow(row: ChatTranscriptRow): boolean {
  return row.role === "tool" || row.role === "toolResult";
}

function isCompletedTool(row: ChatTranscriptRow): boolean {
  if (!isToolRow(row)) {
    return false;
  }
  if (row.toolOutcome) {
    return row.toolOutcome === "completed";
  }
  return row.role === "toolResult" && row.status === "done" && !isError(row);
}

function isInFlightTool(row: ChatTranscriptRow): boolean {
  return row.role === "tool"
    && (row.status === "planning" || row.status === "running" || row.streaming === true);
}

function toolIdentity(row: ChatTranscriptRow): string {
  const callId = row.toolExecutionId?.trim() || row.toolCallId?.trim() || row.id;
  return `${rowRunKey(row)}:${callId}`;
}

function toolCategory(row: Pick<ChatTranscriptRow, "toolName" | "toolSyscall">): TextWorkCategory {
  switch (row.toolSyscall?.trim().toLowerCase()) {
    case "fs.search":
      return "searching-files";
    case "fs.read":
      return "reading-files";
    case "fs.write":
      return "writing-files";
    case "fs.edit":
      return "editing-files";
    case "fs.delete":
      return "deleting-files";
    case "shell.exec":
      return "running-commands";
    case "codemode.exec":
    case "codemode.run":
      return "running-code";
  }

  switch (row.toolName?.trim().toLowerCase()) {
    case "search":
      return "searching-files";
    case "read":
      return "reading-files";
    case "write":
      return "writing-files";
    case "edit":
      return "editing-files";
    case "delete":
      return "deleting-files";
    case "shell":
      return "running-commands";
    case "codemode":
      return "running-code";
    default:
      return "using-tools";
  }
}

function incrementCount(counts: WorkCounts, category: TextWorkCategory): void {
  counts.set(category, (counts.get(category) ?? 0) + 1);
}

function liveActivityText(category: TextWorkCategory, count: number): string {
  switch (category) {
    case "searching-files":
      return count === 1 ? "Running a file search…" : `Running ${count} file searches…`;
    case "reading-files":
      return count === 1 ? "Reading a file…" : `Running ${count} read operations…`;
    case "writing-files":
      return count === 1 ? "Writing a file…" : `Running ${count} write operations…`;
    case "editing-files":
      return count === 1 ? "Editing a file…" : `Running ${count} edit operations…`;
    case "deleting-files":
      return count === 1 ? "Deleting a file…" : `Running ${count} delete operations…`;
    case "running-commands":
      return count === 1 ? "Running a command…" : `Running ${count} commands…`;
    case "running-code":
      return count === 1 ? "Running a code task…" : `Running ${count} code tasks…`;
    case "using-tools":
      return count === 1 ? "Using a tool…" : `Using ${count} tools…`;
  }
}

function completedWorkText(category: TextWorkCategory, count: number): string {
  if (category === "running-commands") {
    return count === 1 ? "Ran 1 command" : `Ran ${count} commands`;
  }

  const action = (() => {
    switch (category) {
      case "searching-files":
        return "Searched files";
      case "reading-files":
        return "Read files";
      case "writing-files":
        return "Wrote files";
      case "editing-files":
        return "Edited files";
      case "deleting-files":
        return "Deleted files";
      case "running-code":
        return "Ran code";
      case "using-tools":
        return "Used tools";
    }
  })();
  return count === 1 ? `${action} once` : `${action} ${count} times`;
}

function completedWorkForMoment(momentKey: string, counts: WorkCounts | undefined): TextCompletedWorkSummary[] {
  if (!counts) {
    return [];
  }
  return TEXT_WORK_CATEGORIES.flatMap((category) => {
    const count = counts.get(category) ?? 0;
    return count > 0
      ? [{
          key: `${momentKey}:work:${category}`,
          category,
          count,
          text: completedWorkText(category, count),
        }]
      : [];
  });
}

function currentActivityRows(runtime: ChatRuntimeState): ChatTranscriptRow[] {
  if (!runtime.activeRunId && runtime.runState !== "running") {
    return [];
  }

  if (runtime.activeRunId) {
    return runtime.rows.filter((row) => row.runId === runtime.activeRunId);
  }

  const latestInFlight = [...runtime.rows].reverse().find((row) => (
    isInFlightTool(row)
    || (row.role === "assistant" && isStreaming(row))
  ));
  if (!latestInFlight) {
    return [];
  }
  const inferredRun = rowRunKey(latestInFlight);
  return runtime.rows.filter((row) => rowRunKey(row) === inferredRun);
}

function projectActivityLines(runtime: ChatRuntimeState): TextActivityLine[] {
  const rows = currentActivityRows(runtime);
  if (rows.length === 0) {
    return [];
  }

  const latestTools = new Map<string, ChatTranscriptRow>();
  for (const row of rows) {
    if (isToolRow(row)) {
      latestTools.set(toolIdentity(row), row);
    }
  }

  const counts: WorkCounts = new Map();
  for (const row of latestTools.values()) {
    if (isInFlightTool(row)) {
      incrementCount(counts, toolCategory(row));
    }
  }

  const scopeKey = runtime.activeRunId
    ? `run:${runtime.activeRunId}`
    : rowRunKey(rows[rows.length - 1]);
  const toolLines = TEXT_WORK_CATEGORIES.flatMap((category) => {
    const count = counts.get(category) ?? 0;
    return count > 0
      ? [{
          key: `activity:${scopeKey}:${category}`,
          category,
          count,
          text: liveActivityText(category, count),
        }]
      : [];
  });
  if (toolLines.length > 0) {
    return toolLines;
  }

  const thinking = [...rows].reverse().find((row) => (
    row.role === "assistant"
    && !row.text.trim()
    && (row.media?.length ?? 0) === 0
    && !row.backupModel
    && isStreaming(row)
  ));
  return thinking
    ? [{
        key: `activity:${scopeKey}:thinking`,
        category: "thinking",
        count: 1,
        text: "Thinking…",
      }]
    : [];
}

/**
 * Project transport-oriented transcript rows into the native client's small,
 * user-facing vocabulary. Tool arguments and results are never copied into the
 * projection; only their fixed activity categories survive.
 */
export function projectTextMoments(runtime: ChatRuntimeState): TextMomentProjection {
  const pendingWork = new Map<string, WorkCounts>();
  const moments: TextMoment[] = [];

  for (const row of runtime.rows) {
    if (isToolRow(row)) {
      if (isCompletedTool(row)) {
        const runKey = rowRunKey(row);
        const counts = pendingWork.get(runKey) ?? new Map<TextWorkCategory, number>();
        incrementCount(counts, toolCategory(row));
        pendingWork.set(runKey, counts);
      }
      continue;
    }

    const role = rowRole(row);
    if (!role) {
      continue;
    }

    const media = row.media ?? [];
    const momentKey = `moment:${row.presentationKey ?? row.id}`;
    const work = role === "assistant"
      ? completedWorkForMoment(momentKey, pendingWork.get(rowRunKey(row)))
      : [];
    const hasBody = row.text.trim().length > 0 || media.length > 0;
    if (!hasBody && (role !== "assistant" || isStreaming(row) || work.length === 0)) {
      continue;
    }

    if (role === "assistant") {
      pendingWork.delete(rowRunKey(row));
    }
    moments.push({
      key: momentKey,
      role,
      text: row.text,
      media,
      streaming: isStreaming(row),
      error: isError(row),
      completedWork: work,
    });
  }

  return {
    moments,
    activityLines: projectActivityLines(runtime),
  };
}

export function chooseLatestInteractiveProcess(
  processes: readonly ChatProcessSummary[],
): ChatProcessSummary | null {
  let latest: ChatProcessSummary | null = null;
  let latestActivity = Number.NEGATIVE_INFINITY;

  for (const process of processes) {
    if (!process.interactive) {
      continue;
    }
    const activity = process.lastActiveAt ?? process.createdAt;
    if (!latest || activity > latestActivity) {
      latest = process;
      latestActivity = activity;
    }
  }
  return latest;
}
