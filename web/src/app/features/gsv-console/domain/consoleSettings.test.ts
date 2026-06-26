import { describe, expect, it } from "vitest";
import type { ConsoleConfigEntry } from "./consoleModels";
import {
  buildUserAiOverrideKey,
  createModelProfile,
  effectiveAiValuesForViewer,
  modelDisplayName,
  modelProfileSecretConfigKey,
  modelProfilesConfigKey,
  modelProfilesForConfig,
  redactModelProfilesConfigValue,
  serializeModelProfiles,
} from "./consoleSettings";

describe("console settings domain", () => {
  it("keeps model profile credentials out of serialized preset metadata", () => {
    const profiles = createModelProfile([], "Deep Research", {
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-5",
      "config/ai/api_key": "sk-secret",
      "config/ai/reasoning": "high",
      "config/ai/max_tokens": "8192",
      "config/ai/max_context_bytes": "65536",
    }, 1000);

    expect(profiles[0]).toMatchObject({
      id: "deep-research",
      name: "Deep Research",
      values: {
        "config/ai/provider": "openai",
        "config/ai/model": "gpt-5",
        "config/ai/api_key": "sk-secret",
        "config/ai/reasoning": "high",
        "config/ai/max_tokens": "8192",
        "config/ai/max_context_bytes": "65536",
      },
    });

    const serialized = JSON.parse(serializeModelProfiles(profiles)) as {
      profiles: Array<{ values: Record<string, string> }>;
    };
    expect(serialized.profiles[0].values).toEqual({
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-5",
      "config/ai/reasoning": "high",
      "config/ai/max_tokens": "8192",
      "config/ai/max_context_bytes": "65536",
    });
  });

  it("reads viewer model profiles and hydrates separate credential config", () => {
    const profiles = createModelProfile([], "Fast", {
      "config/ai/provider": "workers-ai",
      "config/ai/model": "@cf/fast/model",
      "config/ai/api_key": "sk-fast",
    }, 1000);
    const config: ConsoleConfigEntry[] = [
      { key: modelProfilesConfigKey(42), value: serializeModelProfiles(profiles), redacted: false },
      {
        key: modelProfileSecretConfigKey(42, profiles[0].id, "config/ai/api_key"),
        value: "sk-fast",
        redacted: false,
      },
    ];

    expect(modelProfilesForConfig(config, 42).map((profile) => profile.name)).toEqual(["Fast"]);
    expect(modelProfilesForConfig(config, 42)[0].values["config/ai/api_key"]).toBe("sk-fast");
    expect(modelProfilesForConfig(config, 7)).toEqual([]);
  });

  it("redacts legacy secrets from model profile config JSON", () => {
    const redacted = JSON.parse(redactModelProfilesConfigValue(JSON.stringify({
      version: 1,
      profiles: [{
        id: "fast",
        name: "Fast",
        values: {
          "config/ai/provider": "openai",
          "config/ai/api_key": "sk-secret",
          "config/ai/image/read/api_key": "sk-image",
        },
      }],
    }))) as { profiles: Array<{ values: Record<string, string> }> };

    expect(redacted.profiles[0].values).toEqual({
      "config/ai/provider": "openai",
      "config/ai/api_key": "",
      "config/ai/image/read/api_key": "",
    });
  });

  it("merges personal ai overrides over system values", () => {
    const config: ConsoleConfigEntry[] = [
      { key: "config/ai/provider", value: "workers-ai", redacted: false },
      { key: "config/ai/model", value: "@cf/default/model", redacted: false },
      { key: buildUserAiOverrideKey(42, "config/ai/model"), value: "anthropic/claude", redacted: false },
    ];

    expect(effectiveAiValuesForViewer(config, 42)).toMatchObject({
      "config/ai/provider": "workers-ai",
      "config/ai/model": "anthropic/claude",
    });
  });

  it("formats raw provider model ids for list labels", () => {
    expect(modelDisplayName("@cf/google/gemma-4-26b-a4b-it")).toBe("Gemma 4 26B A4B IT");
    expect(modelDisplayName("anthropic/claude-sonnet-4.5")).toBe("Claude Sonnet 4 5");
  });
});
