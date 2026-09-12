import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { encodeInferenceExecutionStreamEvent } from "@humansandmachines/gsv/protocol";
import { executionEvent, executionResult } from "./projection";

function message(): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: "custom", model: "test", content: [], stopReason: "toolUse", timestamp: 1,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

describe("provider event projection", () => {
  it("projects queued starts independently of the SDK's later mutations", () => {
    const partial = message();
    const start = { type: "start" as const, partial };
    partial.content.push({ type: "text", text: "complete text", textSignature: "text-proof" },
      { type: "thinking", thinking: "complete thought", thinkingSignature: "thought-proof", redacted: false });
    expect(executionEvent(start)).toMatchObject({ type: "start", partial: { content: [], stopReason: "pending" } });
    expect(executionEvent({ type: "text_start", contentIndex: 0, partial })).toMatchObject({ content: { text: "", textSignature: "text-proof" } });
    expect(executionEvent({ type: "thinking_start", contentIndex: 1, partial })).toMatchObject({ content: { thinking: "", thinkingSignature: "thought-proof" } });
    expect(executionEvent({ type: "text_end", contentIndex: 0, content: "complete text", partial })).toMatchObject({ content: { text: "complete text" } });
    expect(partial.content[0]).toMatchObject({ text: "complete text" });
  });

  it("keeps signatures and arguments while excluding SDK parser internals from every tool event", () => {
    const partial = message();
    const call: ToolCall & { partialJson: string; index: number } = { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "/test" }, thoughtSignature: "proof", partialJson: '{"path":"/test"}', index: 0 };
    partial.content.push(call);
    const events = [executionEvent({ type: "start", partial }), executionEvent({ type: "toolcall_start", contentIndex: 0, partial }),
      executionEvent({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"/test"}', partial }),
      executionEvent({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial }),
      executionEvent({ type: "done", reason: "toolUse", message: partial })];
    for (const event of events) expect(() => encodeInferenceExecutionStreamEvent(event)).not.toThrow();
    expect(events[1]).toMatchObject({ toolCall: { id: "call-1", arguments: {}, thoughtSignature: "proof" } });
    expect(events[2]).toMatchObject({ toolCall: { arguments: { path: "/test" } } });
    const result = executionResult(partial);
    expect(result.content[0]).toEqual({ type: "toolCall", id: "call-1", name: "Read", arguments: { path: "/test" }, thoughtSignature: "proof" });
    call.arguments.path = "/later";
    expect(result.content[0]).toMatchObject({ arguments: { path: "/test" } });
  });
});
