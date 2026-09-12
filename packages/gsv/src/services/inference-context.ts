import type {
  AiAssistantMessage,
  AiImageContent,
  AiTextContent,
  AiTextTool,
  AiThinkingContent,
  AiToolCall,
  AiToolResultMessage,
  AiUsage,
  AiUserMessage,
} from "../protocol/syscalls/ai";

export type TextContent = AiTextContent;
export type ThinkingContent = AiThinkingContent;
export type ImageContent = AiImageContent;
export type ToolCall = AiToolCall;
export type Usage = AiUsage;
export type Tool = AiTextTool;
export type UserMessage = AiUserMessage & { timestamp: number };
export type ToolResultMessage = AiToolResultMessage & { timestamp: number; addedToolNames?: string[]; usage?: Usage };
export type AssistantMessage = Omit<AiAssistantMessage, "stopReason" | "timestamp"> & {
  timestamp: number;
  stopReason: AiAssistantMessage["stopReason"] | "pending";
};
export type Message = UserMessage | ToolResultMessage | AssistantMessage;
export type Context = { systemPrompt?: string; messages: Message[]; tools?: Tool[] };

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  push(event: AssistantMessageEvent): void;
  end(result?: AssistantMessage): void;
  result(): Promise<AssistantMessage>;
}

/** Local stream projection for clients; provider SDKs are owned by inference. */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  const events: AssistantMessageEvent[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  let complete: (result: AssistantMessage) => void = () => {};
  const result = new Promise<AssistantMessage>((resolve) => { complete = resolve; });
  return {
    push(event) {
      if (closed) return;
      events.push(event);
      if (event.type === "done" || event.type === "error") {
        closed = true;
        complete(event.type === "done" ? event.message : event.error);
      }
      wake?.();
      wake = undefined;
    },
    end(message) {
      closed = true;
      if (message) complete(message);
      wake?.();
      wake = undefined;
    },
    result: () => result,
    async *[Symbol.asyncIterator]() {
      while (events.length > 0 || !closed) {
        const event = events.shift();
        if (event) yield event;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}
