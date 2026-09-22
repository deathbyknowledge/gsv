/** Only counts and bounded controls may leave this projection; never copy payload values. */
export function inferenceRequestShape(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return JSON.stringify({ version: 1, validJson: false });
  }
  const request = object(payload);
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const thinking = object(request?.chat_template_kwargs)?.enable_thinking;
  const shape = {
    version: 1,
    messages: messages.length,
    users: 0,
    assistants: 0,
    toolResults: 0,
    toolCalls: 0,
    unmatchedToolResults: 0,
    images: 0,
    emptyMessages: 0,
    reasoningMessages: 0,
    emptyReasoningMessages: 0,
    tools: Array.isArray(request?.tools) ? request.tools.length : 0,
    maxTokens: typeof request?.max_tokens === "number" && Number.isSafeInteger(request.max_tokens)
      ? request.max_tokens : null,
    thinking: typeof thinking === "boolean" ? thinking : null,
  };
  let pending = new Set<string>();
  for (const value of messages) {
    const message = object(value);
    if (!message) continue;
    if (message.role === "user") shape.users++;
    if (message.role === "assistant") {
      shape.assistants++;
      pending = new Set<string>();
      if (Array.isArray(message.tool_calls)) {
        shape.toolCalls += message.tool_calls.length;
        for (const call of message.tool_calls) {
          const id = object(call)?.id;
          if (typeof id === "string") pending.add(id);
        }
      }
      if (typeof message.reasoning_content === "string") {
        shape.reasoningMessages++;
        if (!message.reasoning_content.length) shape.emptyReasoningMessages++;
      }
    } else if (message.role === "tool") {
      shape.toolResults++;
      if (typeof message.tool_call_id !== "string" || !pending.delete(message.tool_call_id)) {
        shape.unmatchedToolResults++;
      }
    } else {
      pending.clear();
    }
    if (!message.content || (Array.isArray(message.content) && message.content.length === 0)) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) shape.emptyMessages++;
    }
    if (Array.isArray(message.content)) {
      shape.images += message.content.filter((content) => object(content)?.type === "image_url").length;
    }
  }
  return JSON.stringify(shape);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
