import type { Context } from "@mariozechner/pi-ai";
import { parseAssistantMessageMeta, type MessageRecord } from "./store";

const MAX_SUMMARY_WINDOW_CHARS = 16_000;
const MAX_COMMIT_WINDOW_CHARS = 4_000;

export function buildCheckpointTranscript(messages: MessageRecord[]): string {
  return messages
    .map((message) =>
      JSON.stringify(serializeCheckpointMessage(message)),
    )
    .join("\n");
}

export function buildCheckpointSummaryContext(
  existingSummary: string,
  messages: MessageRecord[],
): Context {
  const transcriptWindow = renderTranscriptWindow(messages, MAX_SUMMARY_WINDOW_CHARS);
  const currentSummary = existingSummary.trim().length > 0 ? existingSummary.trim() : "(none yet)";

  return {
    systemPrompt: [
      "You maintain .gsv/summary.md for a workspace-backed GSV thread.",
      "Update the summary using the existing summary and latest transcript.",
      "Return concise markdown only.",
      "Include: current goal, concrete artifacts/files, important decisions, and next steps.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          "Current summary:",
          currentSummary,
          "",
          "Latest transcript:",
          transcriptWindow || "(no transcript)",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
  };
}

export function buildCheckpointCommitMessageContext(
  summary: string,
  messages: MessageRecord[],
  reason: string,
): Context {
  const transcriptWindow = renderTranscriptWindow(messages, MAX_COMMIT_WINDOW_CHARS);

  return {
    systemPrompt: [
      "Write a git commit subject for a GSV workspace checkpoint.",
      "Return one line only.",
      "Use imperative lowercase.",
      "Keep it under 72 characters.",
      "Do not add quotes, prefixes, or trailing punctuation.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          `Checkpoint reason: ${reason}`,
          "",
          "Workspace summary:",
          summary.trim() || "(no summary)",
          "",
          "Recent transcript:",
          transcriptWindow || "(no transcript)",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
  };
}

export function normalizeCheckpointSummary(summary: string): string {
  const trimmed = summary.trim();
  return trimmed ? `${trimmed}\n` : "";
}

export function normalizeCheckpointCommitMessage(message: string): string {
  const firstLine = message
    .split(/\r?\n/, 1)[0]
    ?.trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase() ?? "";

  if (!firstLine) {
    return "checkpoint thread state";
  }
  if (firstLine.length <= 72) {
    return firstLine;
  }
  return firstLine.slice(0, 72).trimEnd();
}

function renderTranscriptWindow(messages: MessageRecord[], maxChars: number): string {
  if (messages.length === 0) {
    return "";
  }

  const chunks: string[] = [];
  let used = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const chunk = formatTranscriptMessage(messages[index]);
    if (chunks.length > 0 && used + chunk.length + 2 > maxChars) {
      break;
    }
    chunks.unshift(chunk);
    used += chunk.length + (chunks.length > 1 ? 2 : 0);
  }

  const transcript = chunks.join("\n\n");
  if (chunks.length < messages.length) {
    return `... earlier messages omitted ...\n\n${transcript}`;
  }
  return transcript;
}

function formatTranscriptMessage(message: MessageRecord): string {
  const lines = [
    `[${new Date(message.createdAt).toISOString()}] ${message.role}`,
  ];
  if (message.content) {
    lines.push(message.content.trim());
  }
  if (message.role === "assistant") {
    const meta = parseAssistantMessageMeta(message.toolCalls);
    if (meta.thinking !== undefined) {
      lines.push(`thinking: ${JSON.stringify(meta.thinking)}`);
    }
    if (meta.toolCalls !== undefined) {
      lines.push(`tool_calls: ${JSON.stringify(meta.toolCalls)}`);
    }
  } else {
    const toolCalls = parseJsonOrUndefined(message.toolCalls);
    if (toolCalls !== undefined) {
      lines.push(`meta: ${JSON.stringify(toolCalls)}`);
    }
  }
  if (message.toolCallId) {
    lines.push(`tool_call_id: ${message.toolCallId}`);
  }
  return lines.join("\n");
}

function serializeCheckpointMessage(message: MessageRecord): Record<string, unknown> {
  if (message.role === "assistant") {
    const meta = parseAssistantMessageMeta(message.toolCalls);
    return {
      role: message.role,
      content: message.content,
      tool_calls: meta.toolCalls,
      thinking: meta.thinking,
      tool_call_id: message.toolCallId ?? undefined,
      ts: message.createdAt,
    };
  }

  return {
    role: message.role,
    content: message.content,
    tool_calls: parseJsonOrUndefined(message.toolCalls),
    tool_call_id: message.toolCallId ?? undefined,
    ts: message.createdAt,
  };
}

function parseJsonOrUndefined(value: string | null): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
