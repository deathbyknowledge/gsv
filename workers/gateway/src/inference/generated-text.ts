import type { AssistantMessage, TextContent, ThinkingContent } from "@humansandmachines/gsv/services/inference-context";
import { describeAssistantResponseFailure } from "./output";

/**
 * Extract usable text from a generation for non-conversational callers such as
 * compaction summaries and ai.text.generate.
 *
 * Reasoning models (notably Workers AI ones such as kimi-k2.6) sometimes emit
 * their answer in a reasoning/thinking channel and produce no separate text
 * block when thinking is disabled. Falling back to that reasoning text keeps the
 * run alive instead of hard-failing with "returned no text".
 */
export function extractGeneratedText(response: AssistantMessage): string {
  const text = finalText(response);
  if (text) {
    return text;
  }

  return response.content
    .filter((block): block is ThinkingContent => block.type === "thinking")
    .map((block) => block.thinking)
    .join("")
    .trim();
}

/**
 * Extract the completed final text of a generation whose result is persisted,
 * such as a compaction summary that replaces history in later model context.
 *
 * The reasoning fallback above does not apply here. A model that stops after
 * planning has not written the summary, and installing its reasoning would
 * pollute every later generation as well as the history people read. A
 * reasoning-only, empty, truncated, aborted or failed response throws the same
 * failure text the run loop reports, so the caller's existing retry and
 * fallback path decides what happens next.
 */
export function extractCompletedText(response: AssistantMessage): string {
  const failure = describeAssistantResponseFailure(response);
  if (failure) throw new Error(failure);
  const text = finalText(response);
  if (!text) throw new Error("Generation returned no text");
  if (response.stopReason === "length") {
    throw new Error("LLM output was truncated before the final response completed");
  }
  if (response.stopReason !== "stop") {
    throw new Error(`LLM generation ended with ${response.stopReason} before the final response completed`);
  }
  return text;
}

function finalText(response: AssistantMessage): string {
  return response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
