import type { ChatTranscriptRow } from "../domain/transcript";

export type ChatTranscriptToolTone = "done" | "error" | "running" | "warning";

type ToolStatusSource = Pick<
  ChatTranscriptRow,
  "isError" | "role" | "status" | "toolOutcome"
>;

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
