import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ManagedInferencePartial, ManagedInferenceResult, ManagedInferenceStreamEvent } from "@humansandmachines/gsv/services/inference";
import { hasWorkersAiModelPricing, isWorkersAiProvider } from "../text/workers-ai";

function partial(message: AssistantMessage): ManagedInferencePartial {
  if (message.stopReason === "deferred") throw new Error("Deferred inference is unsupported");
  const result: ManagedInferencePartial = {
    role: "assistant",
    content: structuredClone(message.content),
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
    case "start": return { type: "start", partial: partial(event.partial) };
    case "text_delta":
    case "thinking_delta": return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "text_start":
    case "text_end": {
      const content = event.partial.content[event.contentIndex];
      if (content?.type !== "text") throw new Error("Invalid text event");
      return { type: event.type, contentIndex: event.contentIndex, content: structuredClone(content) };
    }
    case "thinking_start":
    case "thinking_end": {
      const content = event.partial.content[event.contentIndex];
      if (content?.type !== "thinking") throw new Error("Invalid thinking event");
      return { type: event.type, contentIndex: event.contentIndex, content: structuredClone(content) };
    }
    case "toolcall_start":
    case "toolcall_delta": {
      const toolCall = event.partial.content[event.contentIndex];
      if (toolCall?.type !== "toolCall") throw new Error("Invalid tool call event");
      return event.type === "toolcall_delta"
        ? { type: event.type, contentIndex: event.contentIndex, delta: event.delta, toolCall: structuredClone(toolCall) }
        : { type: event.type, contentIndex: event.contentIndex, toolCall: structuredClone(toolCall) };
    }
    case "toolcall_end": return { type: event.type, contentIndex: event.contentIndex, toolCall: structuredClone(event.toolCall) };
    case "done": {
      if (event.reason === "deferred") throw new Error("Deferred inference is unsupported");
      return { type: "done", reason: event.reason, message: executionResult(event.message) };
    }
    case "error": return { type: "error", reason: event.reason, error: executionResult(event.error) };
  }
}
