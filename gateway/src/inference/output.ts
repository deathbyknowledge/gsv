import type {
  AssistantMessage,
  TextContent,
} from "@earendil-works/pi-ai";

export function describeAssistantResponseFailure(response: AssistantMessage): string | null {
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    return response.errorMessage ?? `LLM generation ended with ${response.stopReason}`;
  }
  if (!response.content || response.content.length === 0) {
    return "LLM returned empty response";
  }
  if (!hasAssistantVisibleOutput(response)) {
    return "LLM returned reasoning but no final response";
  }
  if (hasRawToolCallMarkupOutput(response)) {
    return "LLM returned malformed tool call markup as final text";
  }
  return null;
}

export function isRetryableAssistantResponseFailure(
  response: AssistantMessage,
  failure: string,
): boolean {
  if (response.stopReason === "aborted") {
    return false;
  }

  if (response.stopReason === "error") {
    return typeof response.errorMessage === "string" &&
      response.errorMessage.trim().length > 0 &&
      isRetryableGenerationErrorMessage(response.errorMessage);
  }

  const failureText = `${response.errorMessage ?? ""}\n${failure}`;
  if (isRetryableGenerationErrorMessage(failureText)) {
    return true;
  }
  if (hasRawToolCallMarkupOutput(response)) {
    return true;
  }

  const content = assistantContentBlocks(response);
  return !hasAssistantVisibleOutput(response) &&
    (content.length === 0 || hasAssistantThinking(response));
}

export function hasRawToolCallMarkupOutput(response: AssistantMessage): boolean {
  const content = assistantContentBlocks(response);
  if (content.some((block) => block.type === "toolCall")) {
    return false;
  }
  const text = content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  return /^<tool_call(?:\s|>)/.test(text) && /<\/tool_call>$/.test(text);
}

export function isRetryableGenerationErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("reasoning but no final response") ||
    normalized.includes("malformed tool call markup") ||
    normalized.includes("generation returned no text") ||
    normalized.includes("returned an empty response") ||
    normalized.includes("returned empty response") ||
    normalized.includes("empty response body");
}

function hasAssistantVisibleOutput(response: AssistantMessage): boolean {
  return assistantContentBlocks(response).some((block) => (
    block.type === "toolCall" ||
    (block.type === "text" && block.text.trim().length > 0)
  ));
}

function hasAssistantThinking(response: AssistantMessage): boolean {
  return assistantContentBlocks(response).some((block) =>
    block.type === "thinking" && block.thinking.trim().length > 0
  );
}

function assistantContentBlocks(response: AssistantMessage): AssistantMessage["content"] {
  return Array.isArray(response.content) ? response.content : [];
}
