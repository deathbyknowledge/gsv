import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  assistantContextEpochId,
  assistantGenerationContextId,
  deriveGenerationContextId,
  tagAssistantContextIdentity,
} from "./context-message-metadata";

describe("generation context identity", () => {
  it("changes with the epoch, rendered prompt, or offered tools", async () => {
    // SAFETY: fixture supplies the exact pi-ai tool fields used by context hashing.
    const tools = [{
      name: "Shell",
      description: "Run a command",
      parameters: { type: "object", properties: {} },
    }] as Context["tools"];
    const base = await deriveGenerationContextId("epoch-a", "base prompt", tools);

    await expect(deriveGenerationContextId("epoch-a", "base prompt", tools))
      .resolves.toBe(base);
    await expect(deriveGenerationContextId("epoch-b", "base prompt", tools))
      .resolves.not.toBe(base);
    await expect(deriveGenerationContextId("epoch-a", "delegated prompt", tools))
      .resolves.not.toBe(base);
    await expect(deriveGenerationContextId("epoch-a", "base prompt", undefined))
      .resolves.not.toBe(base);
  });

  it("keeps accounting identities out of provider serialization", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    tagAssistantContextIdentity(
      message,
      "epoch-a",
      "generation-context:interactive",
    );

    expect(assistantContextEpochId(message)).toBe("epoch-a");
    expect(assistantGenerationContextId(message))
      .toBe("generation-context:interactive");
    expect(JSON.stringify(message)).not.toContain("generation-context:interactive");
    expect(JSON.stringify(message)).not.toContain("epoch-a");
  });
});
