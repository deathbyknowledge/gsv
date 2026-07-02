import { describe, expect, it } from "vitest";
import type { ConsoleConfigEntry } from "./consoleModels";
import {
  defaultModelLabelForConfig,
  modelConfigCount,
  modelLabelsForConfig,
  modelOptionsForConfig,
  modelProfilesForConfig,
  overrideConfigEntries,
} from "./consoleAi";

const config: ConsoleConfigEntry[] = [
  { key: "users/1/ai/model", value: "NEMOTRON 3", redacted: false },
  { key: "users/1/ai/tools/approval", value: "manual", redacted: false },
  { key: "gateway/theme", value: "gsv-live", redacted: false },
  { key: "gateway/api_key", value: "", redacted: true },
];

describe("console AI config classification", () => {
  it("counts model config separately from system overrides", () => {
    expect(defaultModelLabelForConfig(config)).toBe("NEMOTRON 3");
    expect(modelConfigCount(config)).toBe(1);
    expect(overrideConfigEntries(config).map((entry) => entry.key)).toEqual([
      "gateway/theme",
      "gateway/api_key",
    ]);
  });

  it("omits sensitive values from parsed model profiles", () => {
    const profiles = modelProfilesForConfig([
      {
        key: "users/1/ai/model_profiles",
        value: JSON.stringify({
          profiles: [{
            id: "fast",
            name: "Fast",
            values: {
              "config/ai/provider": "openai",
              "config/ai/model": "gpt-5",
              "config/ai/api_key": "sk-secret",
            },
          }],
        }),
        redacted: false,
      },
    ], 1);

    expect(profiles[0].values).toEqual({
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-5",
    });
  });

  it("lists only chat model overrides and profile models as LLM options", () => {
    const labels = modelLabelsForConfig([
      { key: "config/ai/model", value: "system-llm", redacted: false },
      { key: "config/ai/image/read/model", value: "vision-model", redacted: false },
      { key: "config/ai/speech/model", value: "voice-model", redacted: false },
      { key: "users/1/ai/model", value: "agent-llm", redacted: false },
      {
        key: "users/1/ai/model_profiles",
        value: JSON.stringify({
          profiles: [{
            id: "profile-fast",
            name: "Profile Fast",
            values: {
              "config/ai/model": "profile-llm",
              "config/ai/image/read/model": "profile-vision",
            },
          }],
        }),
        redacted: false,
      },
    ]);

    expect(labels).toEqual(["system-llm", "agent-llm", "profile-llm"]);
  });

  it("builds readable model dropdown options while preserving raw model ids", () => {
    const options = modelOptionsForConfig([
      { key: "config/ai/model", value: "anthropic/claude-sonnet-4.5", redacted: false },
      {
        key: "users/1/ai/model_profiles",
        value: JSON.stringify({
          profiles: [{
            id: "deep-review",
            name: "Deep Review",
            values: {
              "config/ai/model": "openai/gpt-5.1",
            },
          }],
        }),
        redacted: false,
      },
    ]);

    expect(options).toEqual([
      {
        value: "anthropic/claude-sonnet-4.5",
        label: "Claude Sonnet 4 5",
        description: "anthropic/claude-sonnet-4.5",
      },
      {
        value: "model-profile:deep-review",
        label: "Deep Review",
        description: "openai/gpt-5.1",
      },
    ]);
  });
});
