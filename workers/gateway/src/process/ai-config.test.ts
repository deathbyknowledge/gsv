import { describe, expect, it } from "vitest";
import {
  createProcessAiConfig,
  parseProcessAiConfig,
  parseProcessAiModelProfiles,
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

  it("migrates a legacy snapshot without retaining copied model limits or credentials", () => {
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

    expect(config).toEqual({
      version: 2,
      modelId: "fast",
      reasoning: "low",
      updatedAt: 123,
    });
  });

  it("drops fallback model profile from stored model presets", () => {
    const profiles = parseProcessAiModelProfiles(JSON.stringify({
      version: 1,
      profiles: [{
        id: "fast",
        name: "Fast",
        values: {
          "config/ai/provider": "custom",
          "config/ai/model": "fast-model",
          "config/ai/fallback_model_profile": "backup-stack",
        },
      }],
    }), 1000);

    expect(profiles).toHaveLength(1);
    expect(profiles[0].values).toEqual({
      "config/ai/provider": "custom",
      "config/ai/model": "fast-model",
    });
  });
});
