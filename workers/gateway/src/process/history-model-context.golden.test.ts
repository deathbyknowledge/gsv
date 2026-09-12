import type { AssistantMessage, ToolCall } from "@humansandmachines/gsv/services/inference-context";
import type { JsonValue, ProcHistoryRecordData, ProcToolResultOutcome } from "@humansandmachines/gsv/protocol";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Process } from "./do";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { assistantContextEpochId, assistantGenerationContextId } from "./context-message-metadata";
import {
  GOLDEN_ASSISTANT_METADATA, GOLDEN_EPOCH, GOLDEN_GENERATION, GOLDEN_ORIGINS, GOLDEN_TIME, goldenEvents,
} from "./history-model-context.fixtures";
import { MAX_PROCESS_MEDIA_READ_BYTES } from "./internal/lifecycle";
import type { StoredProcessMedia } from "./media";

// Captured against b1ec803751841b597c905b283f6b6882ef103872 before renderer extraction.
// These snapshots are a compatibility contract; do not regenerate them to accept a refactor.
// Approved wording change on 2026-09-08: context.changed omits target implements.
// Approved wording change on 2026-09-08: context.runway uses concise preservation guidance.
// Approved wording change on 2026-09-08: responsibility.revision introduces unseen fields and then renders changed values.
// Approved wording change on 2026-09-08: event markers precede annotations and schedule notices use concise labels.
// Approved wording change on 2026-09-08: ipc.reply combines the worker process and task ID on one line.
// Approved wording change on 2026-09-08: correction.text-only omits internal Process terminology.
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(GOLDEN_TIME); });
afterEach(() => { vi.restoreAllMocks(); });

function appendResult(
  process: Process,
  callId: string,
  tool: string,
  text: string,
  output: JsonValue,
  outcome: ProcToolResultOutcome = "completed",
  legacy = false,
  isError = outcome === "failed" || outcome === "denied",
): number {
  const payload: Extract<ProcHistoryRecordData, { kind: "result" }>["payload"] = {
    callId, tool, outcome, output, media: [], resources: [],
  };
  if (isError) payload.error = { message: "Synthetic execution failure" };
  return process.store.messages.appendMessage("toolResult", text, {
    createdAt: GOLDEN_TIME, runId: "run:parallel", legacy,
    toolCallId: callId, toolCalls: JSON.stringify({ toolName: tool, outcome, isError }),
    record: { kind: "result", payload },
  });
}

function appendMixedTranscript(process: Process): void {
  const messages = process.store.messages;
  const origin = (value: typeof GOLDEN_ORIGINS[keyof typeof GOLDEN_ORIGINS]) => JSON.stringify(value);
  messages.appendMessage("user", "  Inspect the synthetic workspace.  ", { legacy: true, runId: "run:one", origin: origin(GOLDEN_ORIGINS.client) });
  messages.appendMessage("user", "Same source and run.", { runId: "run:one", origin: origin(GOLDEN_ORIGINS.client) });
  messages.appendMessage("user", "Changed destination inside the same run.", { runId: "run:one", origin: origin(GOLDEN_ORIGINS.otherClient) });
  messages.appendMessage("user", "Same source, new run and destination.", { runId: "run:two", origin: origin(GOLDEN_ORIGINS.otherClient) });
  messages.appendMessage("system", "A legacy event with an independent origin.", { legacy: true, runId: "run:adapter", origin: origin(GOLDEN_ORIGINS.adapter) });
  messages.appendMessage("user", "The event already introduced this source.", { runId: "run:adapter", origin: origin(GOLDEN_ORIGINS.adapter) });

  const calls: ToolCall[] = [
    { type: "toolCall", id: "call:read", name: "Read", arguments: { target: "fixture-laptop", path: "/work/fixture.json" }, thoughtSignature: "signature:read" },
    { type: "toolCall", id: "call:shell", name: "Shell", arguments: { target: "gsv", command: "printf 'fixture'" } },
    { type: "toolCall", id: "call:denied", name: "CodeMode", arguments: { code: "return 'fixture';" } },
    { type: "toolCall", id: "call:cancelled", name: "Write", arguments: { path: "/root/fixture", content: "synthetic" } },
    { type: "toolCall", id: "call:execution-live", name: "Send", arguments: { text: "Synthetic update", yield: true } },
    { type: "toolCall", id: "call:execution-restored", name: "Send", arguments: { text: "Synthetic update", yield: true } },
  ];
  const thinking = [
    { type: "thinking" as const, thinking: "Check both synthetic targets.", thinkingSignature: "signature:thinking", redacted: false },
    { type: "thinking" as const, thinking: "", thinkingSignature: "signature:redacted", redacted: true },
  ];
  const records: ProcHistoryRecordData[] = [
    { kind: "note", payload: { text: "I will inspect the fixture.", thinking } },
    ...calls.map((call): ProcHistoryRecordData => {
      const payload: Extract<ProcHistoryRecordData, { kind: "call" }>["payload"] = {
        callId: call.id, tool: call.name, syscall: null, args: call.arguments,
        target: call.id === "call:read" ? "fixture-laptop" : call.id === "call:shell" ? "gsv" : null,
        runId: "run:parallel",
      };
      if (call.thoughtSignature) payload.thoughtSignature = call.thoughtSignature;
      return { kind: "call", payload };
    }),
  ];
  const assistantId = messages.appendMessage("assistant", "I will inspect the fixture.", {
    runId: "run:parallel", toolCalls: JSON.stringify({ thinking, toolCalls: calls }), metadata: GOLDEN_ASSISTANT_METADATA, records,
  });
  messages.appendRelatedRecord(assistantId, {
    kind: "event", payload: { kind: "correction.exhausted", payload: { attempts: 3, limit: 3, conversationId: "conversation:fixture", messageId: "message:hidden" }, severity: "error", audience: "person" },
  });
  messages.appendMessage("system", "Event interleaved before results.", { legacy: true, runId: "run:parallel" });
  appendResult(process, "call:shell", "Shell", "{\n  \"count\": 1.00,\n  \"nested\": { \"ok\": true }\n}\n", { count: 1, nested: { ok: true } }, "completed", true);
  messages.appendMessage("user", "A user message interleaved between parallel results.", { runId: "run:interrupt", origin: origin(GOLDEN_ORIGINS.device) });
  appendResult(process, "call:read", "Read", "{\"ok\":true,\"text\":\"synthetic file\"}", { ok: true, text: "synthetic file" });
  appendResult(process, "call:denied", "CodeMode", "Synthetic permission denial", { reason: "denied" }, "denied");
  appendResult(process, "call:cancelled", "Write", "Cancelled with isError explicitly false", { reason: "cancelled" }, "cancelled", true, false);
  const executionOutput = { ok: false, error: "Synthetic execution failure", failureKind: "execution", finish: false };
  appendResult(process, "call:execution-live", "Send", "Run-control execution failed: Synthetic execution failure", executionOutput, "failed");
  appendResult(process, "call:execution-restored", "Send", "Error: Synthetic execution failure", executionOutput, "failed");

  messages.appendMessage("assistant", "Legacy array sidecar.", {
    legacy: true, toolCalls: JSON.stringify([{ type: "toolCall", id: "call:quoted", name: "Read", arguments: { path: "/root/quoted" } }]),
  });
  const promotedId = appendResult(process, "call:quoted", "Read", '"literal-looking JSON string"', "literal-looking JSON string", "completed", true);
  messages.appendRelatedRecord(promotedId, {
    kind: "message", payload: {
      direction: "out", text: "HIDDEN user-facing message", media: [], origin: { kind: "run-control" },
      conversationId: "conversation:fixture", conversationMessageId: "message:hidden", deliveryId: "delivery:hidden",
    },
  });
  messages.appendMessage("assistant", "Length-limited synthetic response.", {
    metadata: { provider: { api: "test", provider: "synthetic", model: "synthetic-model", stopReason: "length" } },
  });
  messages.appendMessage("user", "No interaction origin.", { runId: "run:no-origin" });
  messages.appendMessage("user", "Device source.", { runId: "run:device", origin: origin(GOLDEN_ORIGINS.device) });
  messages.appendMessage("user", "Calling process source.", { runId: "run:process", origin: origin(GOLDEN_ORIGINS.process) });
  messages.appendMessage("user", "Schedule without adapter destination.", { runId: "run:scheduler", origin: origin(GOLDEN_ORIGINS.scheduler) });
  messages.appendMessage("user", "Malformed legacy origin is ignored.", { legacy: true, runId: "run:malformed", origin: "{not valid JSON" });

  for (const { event, text, origin: eventOrigin } of goldenEvents()) {
    messages.appendMessage("system", text, {
      runId: `run:event:${event.kind}`, record: { kind: "event", payload: event },
      origin: eventOrigin ? JSON.stringify(eventOrigin) : undefined,
    });
  }
  messages.appendMessage("assistant", "Incomplete exchange remains inspectable.", {
    legacy: true, toolCalls: JSON.stringify({ toolCalls: [{ type: "toolCall", id: "call:incomplete", name: "Read", arguments: { path: "/root/pending" } }] }),
  });
  messages.appendMessage("system", "Deferred event after an incomplete exchange.", { legacy: true });
}

async function putImage(pid: string, filename: string, bytes: Uint8Array, mimeType = "image/png"): Promise<StoredProcessMedia> {
  const key = `var/media/0/${pid}/${filename}`;
  await env.STORAGE.put(key, bytes, {
    httpMetadata: { contentType: mimeType }, customMetadata: { uid: "0", gid: "0", mode: "400", processId: pid },
  });
  return { type: "image", mimeType, key, filename, size: bytes.byteLength };
}

describe("immutable model history baseline", () => {
  it("preserves exact mixed groups, origin annotations, event prose, and provider order", async () => {
    const stub = await initProcess("history-golden-mixed", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      appendMixedTranscript(process);
      const messages = await process.history.buildContextMessages(GOLDEN_EPOCH, GOLDEN_GENERATION);
      expect(JSON.stringify(messages, null, 2)).toMatchSnapshot();
      expect(JSON.stringify(messages)).not.toContain("HIDDEN user-facing message");
      expect(JSON.stringify(messages)).not.toContain("message:hidden");
      const assistantIndex = messages.findIndex((message) => message.role === "assistant" && message.responseId === "response:golden");
      expect(messages.slice(assistantIndex + 1, assistantIndex + 7).map((message) => message.role)).toEqual(Array(6).fill("toolResult"));
    });
  });

  it("retains nonenumerable accounting identities and reuses usage only for matching context", async () => {
    const stub = await initProcess("history-golden-identities", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.store.messages.appendMessage("assistant", "Accounted synthetic answer.", { metadata: GOLDEN_ASSISTANT_METADATA });
      const firstAssistant = async (epoch?: string, generation?: string): Promise<AssistantMessage> => {
        const message = (await process.history.buildContextMessages(epoch, generation))[0];
        if (message?.role !== "assistant") throw new Error("Expected fixture assistant");
        return message;
      };
      const matching = await firstAssistant(GOLDEN_EPOCH, GOLDEN_GENERATION);
      expect(assistantContextEpochId(matching)).toBe(GOLDEN_EPOCH);
      expect(assistantGenerationContextId(matching)).toBe(GOLDEN_GENERATION);
      expect(Object.getOwnPropertySymbols(matching)).toHaveLength(2);
      for (const symbol of Object.getOwnPropertySymbols(matching)) {
        expect(Object.getOwnPropertyDescriptor(matching, symbol)).toMatchObject({ enumerable: false, writable: false, configurable: false });
      }
      expect(JSON.stringify(matching)).not.toContain(GOLDEN_EPOCH);
      expect(JSON.stringify(matching)).not.toContain(GOLDEN_GENERATION);
      expect(matching.usage.totalTokens).toBe(137);
      expect((await firstAssistant()).usage).toEqual(matching.usage);
      expect((await firstAssistant("epoch:other", GOLDEN_GENERATION)).usage.totalTokens).toBe(0);
      expect((await firstAssistant(GOLDEN_EPOCH, "generation:other")).usage.totalTokens).toBe(0);
    });
  });

  it("preserves hydrated and fallback media, legacy inline images, and empty-media distinctions", async () => {
    const pid = "history-golden-media";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const image = await putImage(pid, "small.png", new Uint8Array([1, 2, 3, 4]));
    const vector = await putImage(pid, "drawing.svg", new TextEncoder().encode("<svg/>"), "image/svg+xml");
    const missing: StoredProcessMedia = { type: "image", mimeType: "image/png", key: `var/media/0/${pid}/missing.png`, filename: "missing.png", description: "  A described missing image.  " };
    await runInProcess(stub, async (process: Process) => {
      process.store.messages.appendMessage("user", "  Images and documents.  ", {
        legacy: true, runId: "run:media", origin: JSON.stringify(GOLDEN_ORIGINS.adapter),
        media: JSON.stringify([
          image, missing, vector,
          { type: "audio", mimeType: "audio/ogg", filename: "voice.ogg", size: -1, duration: -0.25, transcription: "  Synthetic transcript.  " },
          { type: "video", mimeType: "video/mp4", filename: "clip.mp4", duration: 2.5, size: 2048, url: "https://example.test/clip.mp4" },
          { type: "document", mimeType: "application/pdf", filename: "report.pdf", url: "https://example.test/report.pdf" },
          { type: "image", mimeType: "image/png", filename: "unowned.png", key: "var/media/99/other/image.png", path: "/forged/path" },
        ]),
      });
      process.store.messages.appendMessage("user", "   ", { legacy: true });
      process.store.messages.appendMessage("user", "   ", { legacy: true, media: "[]" });
      process.store.messages.appendMessage("toolResult", "   ", { legacy: true, toolCallId: "call:no-media", toolCalls: '{"toolName":"Read","isError":false}' });
      process.store.messages.appendMessage("toolResult", "   ", { legacy: true, toolCallId: "call:empty-media", toolCalls: '{"toolName":"Read","isError":false}', media: "[]" });
      process.store.messages.appendMessage("toolResult", "A hydrated tool result.", {
        toolCallId: "call:image", toolCalls: '{"toolName":"Read","isError":false}', media: JSON.stringify([image]),
      });
      process.store.messages.appendMessage("toolResult", JSON.stringify({
        content: [{ type: "text", text: "Legacy inline screenshot." }, { type: "image", data: "BQYH", mimeType: "image/png" }],
      }), { legacy: true, toolCallId: "call:legacy-image", toolCalls: '{"toolName":"Read","isError":false}' });
      const wrapped = process.store.messages.appendMessage("toolResult", JSON.stringify({
        __gsvStoredToolResult: 1, output: { text: "Legacy stored envelope." }, media: [image],
      }), { legacy: true, toolCallId: "call:legacy-envelope", toolCalls: '{"toolName":"Read","isError":false}' });
      process.store.messages.appendRelatedRecord(wrapped, {
        kind: "message", payload: { direction: "out", text: "Hidden legacy-envelope supplement.", media: [], origin: {} },
      });
      expect(JSON.stringify(await process.history.buildContextMessages(), null, 2)).toMatchSnapshot();
    });
  });

  it("preserves oversized fallback and assistant consumption of the shared hydration budget", async () => {
    const pid = "history-golden-media-budget";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const oversized = await putImage(pid, "oversized.png", new Uint8Array(MAX_PROCESS_MEDIA_READ_BYTES + 1));
    const budgetConsumer = await putImage(pid, "assistant-budget.png", new Uint8Array(MAX_PROCESS_MEDIA_READ_BYTES));
    const later = await putImage(pid, "later.png", new Uint8Array([8, 9, 10]));
    await runInProcess(stub, async (process: Process) => {
      process.store.messages.appendMessage("user", "Oversized image stays descriptive.", { media: JSON.stringify([oversized]) });
      const parent = process.store.messages.appendMessage("assistant", "Assistant attachment is not provider content.", { media: JSON.stringify([budgetConsumer]) });
      process.store.messages.appendRelatedRecord(parent, {
        kind: "message", payload: { direction: "out", text: "Hidden outgoing attachment.", origin: { kind: "run-control" }, media: [later] },
      });
      process.store.messages.appendMessage("user", "Budget is exhausted before this image.", { media: JSON.stringify([later]) });
      const messages = await process.history.buildContextMessages();
      expect(JSON.stringify(messages, null, 2)).toMatchSnapshot();
      expect(messages.every((message) => !Array.isArray(message.content) || message.content.every((block) => block.type !== "image"))).toBe(true);
    });
  });
});
