import type { AssistantMessage, AssistantMessageEvent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import type { ManagedInferencePartial, ManagedInferenceResult, ManagedInferenceStreamEvent } from "@humansandmachines/gsv/services/inference";
import { hasWorkersAiModelPricing, isWorkersAiProvider } from "../text/workers-ai";

function partial(message: AssistantMessage): ManagedInferencePartial {
  if (message.stopReason === "deferred") throw new Error("Deferred inference is unsupported");
  const result: ManagedInferencePartial = {
    role: "assistant",
    content: message.content.map((content) => content.type === "text" ? textContent(content)
      : content.type === "thinking" ? thinkingContent(content) : toolContent(content)),
    api: message.api,
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    responseId: message.responseId,
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      totalTokens: message.usage.totalTokens,
      cost: {
        input: message.usage.cost.input,
        output: message.usage.cost.output,
        cacheRead: message.usage.cost.cacheRead,
        cacheWrite: message.usage.cost.cacheWrite,
        total: message.usage.cost.total,
      },
    },
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    timestamp: message.timestamp ?? Date.now(),
    usageCostSource: isWorkersAiProvider(message.provider) && hasWorkersAiModelPricing(message.model)
      ? "model-pricing"
      : message.provider === "gsv" || message.usage.cost.total > 0 ? "provider" : null,
  };
  if (message.usage.cacheWrite1h !== undefined) result.usage.cacheWrite1h = message.usage.cacheWrite1h;
  return result;
}

export function executionResult(message: AssistantMessage): ManagedInferenceResult {
  const result = partial(message);
  if (result.stopReason === "pending") throw new Error("Inference ended without a terminal result");
  return { ...result, stopReason: result.stopReason };
}

export function executionEvent(event: AssistantMessageEvent): ManagedInferenceStreamEvent {
  switch (event.type) {
    // SDK event queues share a mutable partial. Later content may already exist
    // when this event is consumed; the wire starts from an empty projection.
    case "start": return { type: "start", partial: { ...partial(event.partial), content: [], stopReason: "pending" } };
    case "text_delta":
    case "thinking_delta": return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_start":
    case "text_end": {
      const content = event.partial.content[event.contentIndex];
      if (content?.type !== "text") throw new Error("Invalid text event");
      return { type: event.type, contentIndex: event.contentIndex, content: { ...textContent(content), text: event.type === "text_start" ? "" : content.text } };
    }
    case "thinking_start":
    case "thinking_end": {
      const content = event.partial.content[event.contentIndex];
      if (content?.type !== "thinking") throw new Error("Invalid thinking event");
      return { type: event.type, contentIndex: event.contentIndex, content: { ...thinkingContent(content), thinking: event.type === "thinking_start" ? "" : content.thinking } };
    }
    case "toolcall_start":
    case "toolcall_delta": {
      const toolCall = event.partial.content[event.contentIndex];
      if (toolCall?.type !== "toolCall") throw new Error("Invalid tool call event");
      return event.type === "toolcall_delta"
        ? { type: event.type, contentIndex: event.contentIndex, delta: event.delta, toolCall: toolContent(toolCall) }
        : { type: event.type, contentIndex: event.contentIndex, toolCall: { ...toolContent(toolCall), arguments: {} } };
    }
    case "toolcall_end": return { type: event.type, contentIndex: event.contentIndex, toolCall: toolContent(event.toolCall) };
    case "done": {
      if (event.reason === "deferred") throw new Error("Deferred inference is unsupported");
      return { type: "done", reason: event.reason, message: executionResult(event.message) };
    }
    case "error": return { type: "error", reason: event.reason, error: executionResult(event.error) };
  }
}

// Explicit fields keep SDK parser state (for example partialJson) off the wire.
function textContent(content: TextContent): TextContent {
  return { type: "text", text: content.text, textSignature: content.textSignature };
}
function thinkingContent(content: ThinkingContent): ThinkingContent {
  return { type: "thinking", thinking: content.thinking,
    thinkingSignature: content.thinkingSignature, redacted: content.redacted };
}
function toolContent(content: ToolCall): ToolCall {
  return { type: "toolCall", id: content.id, name: content.name, arguments: structuredClone(content.arguments),
    thoughtSignature: content.thoughtSignature };
}
