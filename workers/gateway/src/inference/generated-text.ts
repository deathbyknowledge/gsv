import type { AssistantMessage, TextContent, ThinkingContent } from "@humansandmachines/gsv/services/inference-context";
import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import { formatProviderErrorMessage } from "./errors";

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
  const text = response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (text) {
    return text;
  }

  return response.content
    .filter((block): block is ThinkingContent => block.type === "thinking")
    .map((block) => block.thinking)
    .join("")
    .trim();
}

export function describeGeneratedTextFailure(
  request: {
    config: Pick<AiConfigResult, "provider" | "model">;
  },
  response: AssistantMessage,
): string {
  if (
    (response.stopReason === "error" || response.stopReason === "aborted") &&
    response.errorMessage
  ) {
    return formatProviderErrorMessage(response.errorMessage, {
      provider: request.config.provider,
      model: request.config.model,
    });
  }
  return "Generation returned no text";
}
