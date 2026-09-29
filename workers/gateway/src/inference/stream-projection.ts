import type { AssistantMessage, AssistantMessageEvent } from "@humansandmachines/gsv/services/inference-context";
import type { ManagedInferenceResult, ManagedInferenceStreamEvent } from "@humansandmachines/gsv/services/inference";

type AppliedManagedInferenceEvent = {
  event: AssistantMessageEvent;
  partial: AssistantMessage | undefined;
  terminal: boolean;
};

function toAssistantMessage(
  message: ManagedInferenceResult | Extract<ManagedInferenceStreamEvent, { type: "start" }>["partial"],
): AssistantMessage {
  return message;
}

export function applyManagedInferenceEvent(
  event: ManagedInferenceStreamEvent,
  current: AssistantMessage | undefined,
): AppliedManagedInferenceEvent {
  switch (event.type) {
    case "start": {
      if (current) throw new Error("Managed inference stream started twice");
      const partial = toAssistantMessage(event.partial);
      return { event: { type: "start", partial }, partial, terminal: false };
    }
    case "text_start": {
      const partial = appendContent(current, event.contentIndex, event.content);
      return {
        event: { type: "text_start", contentIndex: event.contentIndex, partial },
        partial,
        terminal: false,
      };
    }
    case "text_delta": {
      const partial = requirePartial(current);
      const block = requireContent(partial, event.contentIndex, "text");
      block.text += event.delta;
      return {
        event: { ...event, partial },
        partial,
        terminal: false,
      };
    }
    case "text_end": {
      const partial = replaceContent(current, event.contentIndex, event.content);
      return {
        event: {
          type: "text_end",
          contentIndex: event.contentIndex,
          content: event.content.text,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "thinking_start": {
      const partial = appendContent(current, event.contentIndex, event.content);
      return {
        event: {
          type: "thinking_start",
          contentIndex: event.contentIndex,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "thinking_delta": {
      const partial = requirePartial(current);
      const block = requireContent(partial, event.contentIndex, "thinking");
      block.thinking += event.delta;
      return {
        event: { ...event, partial },
        partial,
        terminal: false,
      };
    }
    case "thinking_end": {
      const partial = replaceContent(current, event.contentIndex, event.content);
      return {
        event: {
          type: "thinking_end",
          contentIndex: event.contentIndex,
          content: event.content.thinking,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "toolcall_start": {
      const partial = appendContent(current, event.contentIndex, event.toolCall);
      return {
        event: {
          type: "toolcall_start",
          contentIndex: event.contentIndex,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "toolcall_delta": {
      const partial = replaceContent(current, event.contentIndex, event.toolCall);
      return {
        event: {
          type: "toolcall_delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "toolcall_end": {
      const partial = replaceContent(current, event.contentIndex, event.toolCall);
      return {
        event: {
          type: "toolcall_end",
          contentIndex: event.contentIndex,
          toolCall: event.toolCall,
          partial,
        },
        partial,
        terminal: false,
      };
    }
    case "done":
      return {
        event: {
          type: "done",
          reason: event.reason,
          message: toAssistantMessage(event.message),
        },
        partial: current,
        terminal: true,
      };
    case "error":
      return {
        event: {
          type: "error",
          reason: event.reason,
          error: toAssistantMessage(event.error),
        },
        partial: current,
        terminal: true,
      };
  }
}

function appendContent(
  current: AssistantMessage | undefined,
  contentIndex: number,
  content: AssistantMessage["content"][number],
): AssistantMessage {
  const partial = requirePartial(current);
  if (contentIndex !== partial.content.length) {
    throw new Error("Managed inference content index is invalid");
  }
  partial.content.push(content);
  return partial;
}

function replaceContent(
  current: AssistantMessage | undefined,
  contentIndex: number,
  content: AssistantMessage["content"][number],
): AssistantMessage {
  const partial = requirePartial(current);
  if (!partial.content[contentIndex]) {
    throw new Error("Managed inference content index is invalid");
  }
  partial.content[contentIndex] = content;
  return partial;
}

function requireContent<T extends "text" | "thinking">(
  partial: AssistantMessage,
  contentIndex: number,
  type: T,
): Extract<AssistantMessage["content"][number], { type: T }> {
  const content = partial.content[contentIndex];
  if (!content || content.type !== type) {
    throw new Error("Managed inference content sequence is invalid");
  }
  // SAFETY: The runtime type discriminator above matches the requested generic type.
  return content as Extract<AssistantMessage["content"][number], { type: T }>;
}

function requirePartial(
  partial: AssistantMessage | undefined,
): AssistantMessage {
  if (!partial) throw new Error("Managed inference stream has not started");
  return partial;
}
