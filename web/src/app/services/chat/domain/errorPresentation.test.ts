import type { ProcHistoryEvent } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { describeChatError, describeHistoryEventError, type ChatErrorKind } from "./errorPresentation";

function generationFailed(error: string, reason = "generation.error"): ProcHistoryEvent {
  return { kind: "generation.failed", payload: { reason, error }, severity: "error", audience: "both" };
}

describe("chat error presentation", () => {
  it.each<[string, ChatErrorKind]>([
    ["Generation failed: Model generation timed out after 180000ms", "timeout"],
    ["Managed inference was cancelled", "cancelled"],
    ["Context limit reached for openai/gpt-5.\nThe provider reported that this request exceeds the model context window.", "context-limit"],
    ["Generation failed: Provider account issue from openai/gpt-5: insufficient credits\nCheck credits, quota, or billing.", "provider-account"],
    ["Generation failed: Provider rate limit from anthropic/claude: Too Many Requests\nWait and retry.", "rate-limit"],
    ["Generation failed: 401 Unauthorized: invalid API key", "authentication"],
    ["Generation failed: Provider returned an HTML error page from openai/gpt-5 instead of a model response.", "provider-unavailable"],
    ["Generation failed: upstream overloaded, please retry", "provider-unavailable"],
    ["Generation failed: Default inference model is not configured", "setup"],
    ["Generation failed: LLM returned empty response", "empty-response"],
    ["fetch failed: ECONNRESET", "network"],
    ["Generation failed: unexpected token at T=18488", "unknown"],
  ])("recognises %j as %s", (detail, kind) => {
    const presented = describeChatError(detail);
    expect(presented.kind).toBe(kind);
    expect(presented.detail).toBe(detail);
    expect(presented.summary).not.toContain("Generation failed");
    expect(presented.action.length).toBeGreaterThan(0);
  });

  it("keeps internals out of the summary and leaves them in the detail", () => {
    const presented = describeChatError("Generation failed: Model generation timed out after 180000ms");
    expect(presented).toEqual({
      kind: "timeout",
      summary: "The model took too long to respond.",
      action: "Try again. If it keeps happening, wait a few minutes or switch to another model.",
      detail: "Generation failed: Model generation timed out after 180000ms",
    });
  });

  it("describes an unrecognised cause by what was being attempted", () => {
    const context = { summary: "The decision did not go through.", action: "Try again in a moment." };
    expect(describeChatError("approval request hil:7 is not pending", context)).toMatchObject({ kind: "unknown", ...context });
    expect(describeChatError("socket closed", context)).toMatchObject({ kind: "network", summary: "The connection was interrupted." });
  });

  it("maps Process failure events by kind before reading their text", () => {
    expect(describeHistoryEventError(generationFailed("", "generation.empty"), "Generation failed.")?.kind).toBe("empty-response");
    expect(describeHistoryEventError(generationFailed("Model generation timed out after 180000ms"), "Generation failed: Model generation timed out after 180000ms")?.kind).toBe("timeout");
    expect(describeHistoryEventError({ kind: "context.failed", payload: { reason: "overflow" }, severity: "error", audience: "both" }, "Context limit: overflow")?.kind).toBe("context-limit");
    expect(describeHistoryEventError({ kind: "runtime.failed", payload: { reason: "tick.error", error: "boom", prefix: "Process run failed" }, severity: "error", audience: "both" }, "Process run failed: boom")?.kind).toBe("runtime");
    expect(describeHistoryEventError({ kind: "media.failed", payload: { reason: "media.timeout", messageId: 4, error: "decode" }, severity: "error", audience: "both" }, "decode")?.kind).toBe("media");
    expect(describeHistoryEventError({ kind: "delivery.failed", payload: { phase: "message", error: "telegram 400" }, severity: "error", audience: "both" }, "telegram 400")?.kind).toBe("delivery");
    expect(describeHistoryEventError({ kind: "legacy", payload: { text: "Generation failed: Provider rate limit" }, severity: "error", audience: "both" }, "Generation failed: Provider rate limit")?.kind).toBe("rate-limit");
  });

  it("leaves events that are not failures alone", () => {
    expect(describeHistoryEventError({ kind: "history.compacted", payload: { summary: "s", segmentId: "x", archivedMessages: 1, archivePath: "/a" }, severity: "info", audience: "both" }, "s")).toBeNull();
  });
});
