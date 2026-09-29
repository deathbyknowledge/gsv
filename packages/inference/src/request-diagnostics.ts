import * as z from "zod/mini";

const requestDiagnosticsSchema = z.object({
  messages: z.optional(z.array(z.object({
    role: z.string(),
    content: z.optional(z.nullable(z.union([
      z.string(),
      z.array(z.object({ type: z.string() })),
    ]))),
    tool_calls: z.optional(z.array(z.object({ id: z.optional(z.string()) }))),
    tool_call_id: z.optional(z.string()),
    reasoning_content: z.optional(z.string()),
  }))),
  tools: z.optional(z.array(z.object({}))),
  max_tokens: z.optional(z.int()),
  chat_template_kwargs: z.optional(z.object({ enable_thinking: z.optional(z.boolean()) })),
});

/** Only counts and bounded controls may leave this projection; never copy payload values. */
export function inferenceRequestDiagnostics(body: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return JSON.stringify({ version: 1, validJson: false });
  }
  const parsed = requestDiagnosticsSchema.safeParse(payload);
  if (!parsed.success) return JSON.stringify({ version: 1, validJson: true, validRequest: false });
  const request = parsed.data;
  const messages = request.messages ?? [];
  const diagnostics = {
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
    tools: request.tools?.length ?? 0,
    maxTokens: request.max_tokens ?? null,
    thinking: request.chat_template_kwargs?.enable_thinking ?? null,
  };
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") diagnostics.users++;
    if (message.role === "assistant") {
      diagnostics.assistants++;
      pending = new Set<string>();
      if (message.tool_calls) {
        diagnostics.toolCalls += message.tool_calls.length;
        for (const call of message.tool_calls) {
          if (call.id !== undefined) pending.add(call.id);
        }
      }
      if (message.reasoning_content !== undefined) {
        diagnostics.reasoningMessages++;
        if (!message.reasoning_content.length) diagnostics.emptyReasoningMessages++;
      }
    } else if (message.role === "tool") {
      diagnostics.toolResults++;
      if (message.tool_call_id === undefined || !pending.delete(message.tool_call_id)) {
        diagnostics.unmatchedToolResults++;
      }
    } else {
      pending.clear();
    }
    if (!message.content?.length && !message.tool_calls?.length) {
      diagnostics.emptyMessages++;
    }
    if (Array.isArray(message.content)) {
      diagnostics.images += message.content.filter((content) => content.type === "image_url").length;
    }
  }
  return JSON.stringify(diagnostics);
}
