import { describe, expect, it, vi } from "vitest";
import type { InferenceDecisionRequest } from "@humansandmachines/gsv/services/inference-execution";
import { evaluateTypeSafe } from "../src/decisions/typesafe";

function request(): InferenceDecisionRequest {
  return {
    version: 1, installationId: "space-a", logicalRequestId: "decision-a",
    actor: { localUid: 1000 }, timeoutMs: 10000, deadlineAt: Date.now() + 10000,
    connection: { provider: "typesafe", model: "jev-latest", apiKey: "test-only-credential" },
    input: { state: { message: "A new concept" }, questions: {
      keep: { type: "boolean", instructions: "Worth retaining?" },
      view: { type: "choice", instructions: "Which view?", criteria: { conversation: null, memory: "Related note" } },
      importance: { type: "score", instructions: "How important?", criteria: ["Background", "Relevant", "Essential"] },
    } },
  };
}

function response() {
  return {
    model: "jev-latest", usage: { input_tokens: 10, output_tokens: 3 },
    answers: {
      keep: { type: "noul", noul: 0.9 },
      view: { type: "choice", choice: "memory", confidence: 0.8, probabilities: { conversation: 0.1, memory: 0.9 } },
      importance: { type: "score", score: 1.6, confidence: 0.7, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } },
    },
  };
}

describe("TypeSafe decisions", () => {
  it("projects independent typed questions and results without exposing credentials", async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response()));
    const signal = new AbortController().signal;
    const result = await evaluateTypeSafe(request(), signal, provider);
    const [url, init] = provider.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init).toMatchObject({ signal, redirect: "error", method: "POST" });
    expect(JSON.parse(String(init?.body)).questions.keep.type).toBe("noul");
    expect(result.answers.keep).toEqual({ type: "boolean", probability: 0.9 });
    expect(result.answers.importance).toMatchObject({ type: "score", score: 1.6 });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(JSON.stringify(result)).not.toContain("test-only-credential");
  });

  it.each(["unknown choice", "missing option", "invalid total", "wrong question type"])("rejects %s", async (failure) => {
    const wire = response();
    if (failure === "unknown choice") wire.answers.view.choice = "secret-file";
    if (failure === "missing option") wire.answers.view.probabilities = { memory: 1 } as typeof wire.answers.view.probabilities;
    if (failure === "invalid total") wire.answers.view.probabilities.memory = 0.2;
    if (failure === "wrong question type") wire.answers.keep.type = "choice";
    const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire));
    await expect(evaluateTypeSafe(request(), new AbortController().signal, provider)).rejects.toThrow("TypeSafe");
  });

  it("cancels a provider error body and omits its private contents", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("private evidence")); }, cancel });
    const provider = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 429 }));
    await expect(evaluateTypeSafe(request(), new AbortController().signal, provider)).rejects.toThrow("TypeSafe decision request failed (HTTP 429)");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not start cancelled or oversized work", async () => {
    const provider = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(evaluateTypeSafe(request(), controller.signal, provider)).rejects.toThrow("stopped");
    const large = request();
    large.input.state = "x".repeat(128 * 1024);
    await expect(evaluateTypeSafe(large, new AbortController().signal, provider)).rejects.toThrow("128 KiB");
    expect(provider).not.toHaveBeenCalled();
  });
});
