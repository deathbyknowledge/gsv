import type { ChatTranscriptRow } from "../domain/transcript";

export type ChatTranscriptToolTone = "done" | "error" | "running" | "warning";

type ToolStatusSource = Pick<
  ChatTranscriptRow,
  "isError" | "role" | "status" | "toolOutcome"
>;

type ActivityStatusSource = Pick<
  ChatTranscriptRow,
  "isError" | "role" | "runId" | "status" | "streaming" | "toolOutcome"
>;

export type ChatTranscriptActivityStatusEntry = {
  kind: "backup" | "reasoning" | "tool";
  message: ActivityStatusSource;
};

export function chatTranscriptToolTone(message: ToolStatusSource): ChatTranscriptToolTone {
  if (message.toolOutcome === "cancelled" || message.toolOutcome === "denied") {
    return "warning";
  }
  if (message.toolOutcome === "failed") {
    return "error";
  }
  if (message.toolOutcome === "completed") {
    return "done";
  }
  if (message.isError || message.status === "error") {
    return "error";
  }
  if (message.role === "toolResult" || message.status === "done") {
    return "done";
  }
  return "running";
}

export function chatTranscriptToolStatusLabel(message: ToolStatusSource): string {
  if (message.toolOutcome === "cancelled") {
    return "CANCELLED";
  }
  if (message.toolOutcome === "denied") {
    return "DENIED";
  }

  const tone = chatTranscriptToolTone(message);
  if (tone === "error") {
    return "ERROR";
  }
  if (tone === "done") {
    return "DONE";
  }
  return message.status === "planning" ? "PREPARING" : "RUNNING";
}

export function chatTranscriptToolGroupTone(
  tools: readonly ToolStatusSource[],
): ChatTranscriptToolTone {
  const tones = tools.map(chatTranscriptToolTone);
  if (tones.includes("error")) {
    return "error";
  }
  if (tones.includes("running")) {
    return "running";
  }
  if (tones.includes("warning")) {
    return "warning";
  }
  return "done";
}

export function chatTranscriptActivityGroupTone(
  entries: readonly ChatTranscriptActivityStatusEntry[],
  active = false,
): ChatTranscriptToolTone {
  if (active) {
    return "running";
  }

  if (entries.some((entry) => (
    entry.kind !== "tool"
    && (entry.message.streaming === true || entry.message.status === "running")
  ))) {
    return "running";
  }

  const tools = entries
    .filter((entry) => entry.kind === "tool")
    .map((entry) => entry.message);
  return tools.length > 0 ? chatTranscriptToolGroupTone(tools) : "done";
}

export function chatTranscriptActiveGroupIndex(
  groups: readonly (readonly ChatTranscriptActivityStatusEntry[])[],
  activeRunId: string | null,
): number {
  if (!activeRunId) {
    return -1;
  }
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (groups[index].some((entry) => entry.message.runId === activeRunId)) {
      return index;
    }
  }
  return -1;
}
