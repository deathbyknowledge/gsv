import type {
  ChatAgentData,
  ChatAgentStatus,
  ChatAgentTaskData,
  ChatProcessStatusTone,
} from "./agent";
import type { ChatRuntimeState, ChatTranscriptRow } from "./transcript";

export type ChatLiveActivity = {
  activity: string;
  agentStatus: ChatAgentStatus;
  runStateLabel: string;
  status: ChatProcessStatusTone;
  statusLabel: string;
  tasks: ChatAgentTaskData[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function basenamePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

function truncateInline(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3).trim()}...`;
}

function inferToolSyscall(toolName: string | undefined, syscall: string | null | undefined): string | null {
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

function toolDisplayName(toolName: string | undefined, syscall: string | null): string {
  const name = toolName?.trim();
  if (!name || name === "Tool") {
    return syscall?.trim() || "tool";
  }
  return name;
}

function toolPathTarget(args: unknown): string | null {
  const record = asRecord(args);
  const path = asString(record?.path)
    ?? asString(record?.file)
    ?? asString(record?.targetPath)
    ?? asString(record?.sourcePath);
  return path ? basenamePath(path) : null;
}

function shellInputText(args: unknown): string | null {
  const record = asRecord(args);
  return asString(record?.input)
    ?? asString(record?.command)
    ?? asString(record?.cmd)
    ?? asString(record?.script);
}

function liveToolTitle(input: {
  args?: unknown;
  syscall?: string | null;
  toolName?: string;
}): string {
  const syscall = inferToolSyscall(input.toolName, input.syscall);
  const target = toolPathTarget(input.args) || "file";

  if (syscall === "fs.read") return `Reading ${target}`;
  if (syscall === "fs.write") return `Writing ${target}`;
  if (syscall === "fs.edit") return `Editing ${target}`;
  if (syscall === "fs.delete") return `Deleting ${target}`;
  if (syscall === "fs.search") return "Searching files";
  if (syscall === "shell.exec") {
    const command = shellInputText(input.args);
    return command ? `Running ${truncateInline(command, 72)}` : "Running command";
  }
  if (syscall === "codemode.exec" || syscall === "codemode.run") return "Running CodeMode script";
  if (syscall === "sys.mcp.call") return "Calling MCP tool";

  return `Using ${toolDisplayName(input.toolName, syscall)}`;
}

function latestRow(rows: readonly ChatTranscriptRow[], predicate: (row: ChatTranscriptRow) => boolean): ChatTranscriptRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (predicate(rows[index])) {
      return rows[index];
    }
  }
  return null;
}

function liveTask(name: string): ChatAgentTaskData[] {
  return [{ name, status: "running" }];
}

function statusToAgentStatus(status: ChatProcessStatusTone): ChatAgentStatus {
  if (status === "error") return "error";
  if (status === "idle") return "idle";
  return status === "live" ? "live" : "online";
}

function liveActivity(input: Omit<ChatLiveActivity, "agentStatus" | "tasks"> & {
  task?: string;
}): ChatLiveActivity {
  return {
    activity: input.activity,
    agentStatus: statusToAgentStatus(input.status),
    runStateLabel: input.runStateLabel,
    status: input.status,
    statusLabel: input.statusLabel,
    tasks: liveTask(input.task ?? input.activity),
  };
}

export function deriveChatLiveActivity(
  runtime: Pick<ChatRuntimeState, "activeRunId" | "pendingHil" | "rows" | "runState">,
  stopping = false,
): ChatLiveActivity | null {
  if (stopping) {
    return liveActivity({
      activity: "Stopping",
      runStateLabel: "stopping",
      status: "update",
      statusLabel: "stopping",
      task: "Stopping current run",
    });
  }

  if (runtime.pendingHil) {
    const tool = liveToolTitle({
      args: runtime.pendingHil.args,
      syscall: runtime.pendingHil.syscall,
      toolName: runtime.pendingHil.toolName,
    });
    return liveActivity({
      activity: `Awaiting approval: ${tool}`,
      runStateLabel: "awaiting approval",
      status: "warn",
      statusLabel: "awaiting approval",
      task: `Review ${tool}`,
    });
  }

  const activeRunId = runtime.activeRunId;
  const activeRows = activeRunId
    ? runtime.rows.filter((row) => row.runId === activeRunId)
    : runtime.rows;

  const runningTool = latestRow(activeRows, (row) =>
    row.role === "tool" && (row.status === "planning" || row.status === "running")
  );
  if (runningTool) {
    const activity = liveToolTitle({
      args: runningTool.toolArgs,
      syscall: runningTool.toolSyscall,
      toolName: runningTool.toolName,
    });
    return liveActivity({
      activity,
      runStateLabel: "using tools",
      status: "live",
      statusLabel: "using tools",
    });
  }

  const streamingAssistant = latestRow(activeRows, (row) =>
    row.role === "assistant" && row.streaming === true
  );
  if (streamingAssistant?.text.trim()) {
    return liveActivity({
      activity: "Writing reply",
      runStateLabel: "writing reply",
      status: "live",
      statusLabel: "writing reply",
    });
  }
  if (streamingAssistant?.thinking?.some((entry) => entry.trim())) {
    return liveActivity({
      activity: "Thinking",
      runStateLabel: "thinking",
      status: "live",
      statusLabel: "thinking",
    });
  }

  if (runtime.runState === "queued") {
    return liveActivity({
      activity: "Queued",
      runStateLabel: "queued",
      status: "update",
      statusLabel: "queued",
    });
  }
  if (runtime.runState === "awaiting_hil") {
    return liveActivity({
      activity: "Awaiting approval",
      runStateLabel: "awaiting approval",
      status: "warn",
      statusLabel: "awaiting approval",
      task: "Review tool approval",
    });
  }
  if (runtime.runState === "running" || runtime.activeRunId) {
    return liveActivity({
      activity: "Running",
      runStateLabel: "running",
      status: "live",
      statusLabel: "running",
    });
  }

  return null;
}

export function applyChatLiveActivityToAgent(
  agent: ChatAgentData | null | undefined,
  activity: ChatLiveActivity | null,
  activeProcessId: string,
): ChatAgentData | null | undefined {
  if (!activity) {
    return agent;
  }

  const patchedCrew = agent?.crew?.map((member) => {
    const isActive = member.active === true || Boolean(activeProcessId && member.processId === activeProcessId);
    return isActive
      ? {
          ...member,
          status: activity.agentStatus,
          statusLabel: activity.statusLabel.toUpperCase(),
        }
      : member;
  });

  return {
    ...(agent ?? {}),
    activity: activity.activity,
    status: activity.agentStatus,
    statusLabel: activity.statusLabel,
    ...(patchedCrew ? { crew: patchedCrew } : {}),
  };
}
