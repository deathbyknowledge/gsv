import { describe, expect, it } from "vitest";
import {
  createProcessAiConfig,
  parseProcessAiConfig,
} from "./ai-config";

describe("process ai config", () => {
  it("stores only a stable model reference and reasoning preference", () => {
    const config = createProcessAiConfig({ modelId: "fast", reasoning: "high" }, 123);

    expect(config).toEqual({
      version: 2,
      modelId: "fast",
      reasoning: "high",
      updatedAt: 123,
    });
  });

  it("rejects obsolete copied model snapshots", () => {
    const config = parseProcessAiConfig(JSON.stringify({
      version: 1,
      values: {
        "config/ai/provider": "openai",
        "config/ai/model": "gpt-old",
        "config/ai/api_key": "secret",
        "config/ai/max_tokens": "8192",
        "config/ai/reasoning": "low",
      },
      profile: { id: "fast", name: "Fast", appliedAt: 100 },
      updatedAt: 123,
    }));

    expect(config).toBeNull();
    expect(parseProcessAiConfig(JSON.stringify({
      version: 2,
      modelId: "fast",
      overrides: { "config/ai/model": "gpt-old" },
      updatedAt: 123,
    }))).toBeNull();
    expect(parseProcessAiConfig(JSON.stringify({
      version: 2,
      modelId: 42,
      updatedAt: 123,
    }))).toBeNull();
  });
});
