import type { AssistantMessage } from "@humansandmachines/gsv/services/inference-context";

/** Historical and transport failures may contain only the provider's error text. */
const contextError = [
  /prompt (?:is )?too long|request_too_large|input is too long for requested model/i,
  /exceeds the context window|context window exceeds limit|model_context_window_exceeded/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum|maximum prompt length is \d+/i,
  /reduce the length of the messages|maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+|exceeds the available context size|greater than the context length/i,
  /exceeded model token limit|too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /range of input length should be|context[_ ]length[_ ]exceeded|too many tokens|token limit exceeded/i,
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
];

export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  if (message.stopReason === "error" && message.errorMessage) {
    if (/^(?:Throttling error|Service unavailable):|rate limit|too many requests/i.test(message.errorMessage)) return false;
    return contextError.some((pattern) => pattern.test(message.errorMessage!));
  }
  if (!contextWindow || !message.usage) return false;
  const input = message.usage.input + message.usage.cacheRead;
  if (message.stopReason === "stop") return input > contextWindow;
  return message.stopReason === "length" && message.usage.output === 0 && input >= contextWindow * 0.99;
}
