import { describe, expect, it } from "vitest";
import type { ConsoleConfigEntry } from "./consoleModels";
import {
  AI_OPENAI_WORKERS_PROVIDER_OPTIONS,
  AI_PROVIDER_OPTIONS,
} from "../../../domain/aiProviders";
import {
  buildUserAiOverrideKey,
  AGENT_MODEL_FIELDS,
  MODEL_PROFILE_FIELDS,
  TOOL_MODEL_GROUPS,
  createModelProfile,
  effectiveAiValuesForViewer,
  modelDisplayName,
  modelProfileDefaultEntries,
  modelProfileSaveEntries,
  modelProfileSecretConfigKey,
  modelProfilesConfigKey,
  modelProfilesForConfig,
  modelValidationValuesFromProfileDrafts,
  redactModelProfilesConfigValue,
  serializeModelProfiles,
  updateModelProfile,
} from "./consoleSettings";

describe("console settings domain", () => {
  it("uses readable provider choices for all model provider fields", () => {
    const agentProviderField = AGENT_MODEL_FIELDS.find((field) => field.key === "config/ai/provider");
    const toolProviderField = (groupId: string) =>
      TOOL_MODEL_GROUPS.find((group) => group.id === groupId)?.fields.find((field) => field.key.endsWith("/provider"));

    const providerValues = AI_PROVIDER_OPTIONS.map((option) => option.value);
    expect(providerValues).toContain("workers-ai");
    expect(providerValues).toContain("openai");
    expect(providerValues).toContain("cloudflare-ai-gateway");
    expect(providerValues).not.toContain("amazon-bedrock");
    expect(providerValues).not.toContain("azure-openai-responses");
    expect(providerValues).not.toContain("cloudflare-workers-ai");
    expect(providerValues).toContain("openai-codex");
    expect(AI_PROVIDER_OPTIONS.find((option) => option.value === "workers-ai")?.label).toBe("Workers AI (gateway binding)");
    expect(AI_PROVIDER_OPTIONS.find((option) => option.value === "cloudflare-ai-gateway")?.label).toBe("Cloudflare AI Gateway");
    expect(AI_PROVIDER_OPTIONS.find((option) => option.value === "openai-codex")?.label).toBe("OpenAI Codex (ChatGPT)");
    expect(agentProviderField?.kind).toBe("select");
    expect(agentProviderField?.options).toBe(AI_PROVIDER_OPTIONS);
    expect(toolProviderField("image-read")).toBeUndefined();
    expect(toolProviderField("image-generation")?.options).toBe(AI_OPENAI_WORKERS_PROVIDER_OPTIONS);
    expect(toolProviderField("transcription")?.options).toBe(AI_OPENAI_WORKERS_PROVIDER_OPTIONS);
    expect(toolProviderField("speech")?.options).toBe(AI_OPENAI_WORKERS_PROVIDER_OPTIONS);
    expect(AI_OPENAI_WORKERS_PROVIDER_OPTIONS.map((option) => option.value)).toEqual(["workers-ai", "openai"]);
  });

  it("keeps model profile credentials out of serialized preset metadata", () => {
    const profiles = createModelProfile([], "Deep Research", {
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-5",
      "config/ai/fallback_model_profile": "backup-stack",
      "config/ai/api_key": "sk-secret",
      "config/ai/reasoning": "high",
      "config/ai/max_tokens": "8192",
      "config/ai/max_context_bytes": "65536",
    }, 1000);
    expect(() => createModelProfile(profiles, "Deep   Research", {}, 2000)).toThrow("Profile name already exists");

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
    expect(profiles[0].values["config/ai/fallback_model_profile"]).toBeUndefined();

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

  it("builds saved profile and default writes from the same edited model", () => {
    const profiles = createModelProfile([], "Fast", {
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-old",
      "config/ai/api_key": "sk-profile",
    }, 1000);
    const nextProfiles = updateModelProfile(profiles, profiles[0].id, "Fast", {
      ...profiles[0].values,
      "config/ai/model": "gpt-new",
    }, 2000);
    const clearedSecretKeys = new Map([[profiles[0].id, new Set<string>()]]);
    const entries = [
      ...modelProfileSaveEntries(0, profiles, nextProfiles, clearedSecretKeys),
      ...modelProfileDefaultEntries([], 0, true, nextProfiles[0], clearedSecretKeys),
    ];
    const storedProfiles = JSON.parse(
      entries.find((entry) => entry.key === modelProfilesConfigKey(0))?.value ?? "{}",
    ) as { profiles?: Array<{ values: Record<string, string> }> };

    expect(storedProfiles.profiles?.[0].values["config/ai/model"]).toBe("gpt-new");
    expect(entries).toContainEqual({
      key: modelProfileSecretConfigKey(0, profiles[0].id, "config/ai/api_key"),
      value: "sk-profile",
    });
    expect(entries).toContainEqual({ key: "config/ai/model", value: "gpt-new" });
    expect(entries).toContainEqual({ key: "config/ai/api_key", value: "sk-profile" });
  });

  it("copies an unchanged redacted profile secret when making it default", () => {
    const profiles = createModelProfile([], "Fast", {
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-5",
      "config/ai/api_key": "",
    }, 1000);
    const profileSecretKey = modelProfileSecretConfigKey(42, profiles[0].id, "config/ai/api_key");
    const config: ConsoleConfigEntry[] = [{
      key: profileSecretKey,
      value: "",
      redacted: true,
    }];

    expect(modelProfileDefaultEntries(config, 42, false, profiles[0])).toContainEqual({
      key: "users/42/ai/api_key",
      copyFromKey: profileSecretKey,
    });
  });

  it("keeps fallback selection out of model preset fields", () => {
    expect(AGENT_MODEL_FIELDS.some((field) => field.key === "config/ai/fallback_model_profile")).toBe(true);
    expect(MODEL_PROFILE_FIELDS.some((field) => field.key === "config/ai/fallback_model_profile")).toBe(false);
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
          "config/ai/speech/api_key": "sk-speech",
        },
      }],
    }))) as { profiles: Array<{ values: Record<string, string> }> };

    expect(redacted.profiles[0].values).toEqual({
      "config/ai/provider": "openai",
      "config/ai/api_key": "",
      "config/ai/speech/api_key": "",
    });
  });

  it("omits blank profile secrets from validation unless explicitly cleared", () => {
    const drafts = {
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-5",
      "config/ai/api_key": "",
      "config/ai/reasoning": "low",
    };

    expect(modelValidationValuesFromProfileDrafts(drafts)).toEqual({
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-5",
      "config/ai/reasoning": "low",
    });
    expect(modelValidationValuesFromProfileDrafts(
      drafts,
      new Set(["config/ai/api_key"]),
    )).toEqual(drafts);
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

  it("reflects selected model profiles in viewer ai defaults", () => {
    const profiles = createModelProfile([], "Fast Stack", {
      "config/ai/provider": "custom",
      "config/ai/model": "zai-glm-4.7",
      "config/ai/base_url": "https://provider.example/v1",
      "config/ai/provider_style": "openai-chat-completions",
      "config/ai/api_key": "sk-profile",
      "config/ai/reasoning": "low",
    }, 1000);
    const config: ConsoleConfigEntry[] = [
      { key: "config/ai/provider", value: "workers-ai", redacted: false },
      { key: "config/ai/model", value: "@cf/default/model", redacted: false },
      { key: "users/42/ai/model_profile", value: profiles[0].id, redacted: false },
      { key: "users/42/ai/provider", value: "workers-ai", redacted: false },
      { key: "users/42/ai/model", value: "stale-model", redacted: false },
      { key: modelProfilesConfigKey(42), value: serializeModelProfiles(profiles), redacted: false },
      {
        key: modelProfileSecretConfigKey(42, profiles[0].id, "config/ai/api_key"),
        value: "sk-profile",
        redacted: false,
      },
    ];

    expect(effectiveAiValuesForViewer(config, 42)).toMatchObject({
      "config/ai/provider": "custom",
      "config/ai/model": "zai-glm-4.7",
      "config/ai/base_url": "https://provider.example/v1",
      "config/ai/provider_style": "openai-chat-completions",
      "config/ai/api_key": "sk-profile",
      "config/ai/reasoning": "low",
    });
  });

  it("infers profile-backed defaults from raw model overrides when the provider stack is not overridden", () => {
    const profiles = createModelProfile([], "Fast Stack", {
      "config/ai/provider": "custom",
      "config/ai/model": "zai-glm-4.7",
      "config/ai/base_url": "https://provider.example/v1",
    }, 1000);
    const config: ConsoleConfigEntry[] = [
      { key: "config/ai/provider", value: "workers-ai", redacted: false },
      { key: "config/ai/model", value: "@cf/default/model", redacted: false },
      { key: "users/42/ai/model", value: "zai-glm-4.7", redacted: false },
      { key: modelProfilesConfigKey(42), value: serializeModelProfiles(profiles), redacted: false },
    ];

    expect(effectiveAiValuesForViewer(config, 42)).toMatchObject({
      "config/ai/provider": "custom",
      "config/ai/model": "zai-glm-4.7",
      "config/ai/base_url": "https://provider.example/v1",
    });
  });

  it("formats raw provider model ids for list labels", () => {
    expect(modelDisplayName("@cf/moondream/moondream3.1-9B-A2B")).toBe("Moondream3 1 9B A2B");
    expect(modelDisplayName("anthropic/claude-sonnet-4.5")).toBe("Claude Sonnet 4 5");
  });
});
