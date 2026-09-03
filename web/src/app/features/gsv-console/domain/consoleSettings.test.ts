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
  inheritsSystemModelStack,
  modelDisplayName,
  makeModelPrimary,
  modelProfileSaveEntries,
  modelProfileSecretConfigKey,
  modelProfilesConfigKey,
  modelProfilesForConfig,
  modelStackDisplayName,
  modelValidationValuesFromProfileDrafts,
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

  it("keeps model credentials out of serialized stack metadata", () => {
    const profiles = createModelProfile([], "Deep Research", {
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-5",
      "config/ai/api_key": "sk-secret",
      "config/ai/max_tokens": "8192",
      "config/ai/context_window_tokens": "65536",
    }, 1000);
    expect(() => createModelProfile(profiles, "Deep   Research", {}, 2000)).toThrow("Model name already exists");

    expect(profiles[0]).toMatchObject({
      id: "deep-research",
      name: "Deep Research",
      values: {
        "config/ai/provider": "openai",
        "config/ai/model": "gpt-5",
        "config/ai/api_key": "sk-secret",
        "config/ai/max_tokens": "8192",
        "config/ai/context_window_tokens": "65536",
      },
    });

    // SAFETY: Test fixture uses the asserted API shape for this focused case.
    const serialized = JSON.parse(serializeModelProfiles(profiles)) as {
      models: Array<Record<string, string | number>>;
    };
    expect(serialized.models[0]).toEqual({
      id: "deep-research",
      name: "Deep Research",
      provider: "openai",
      model: "gpt-5",
      maxTokens: 8192,
      contextWindowTokens: 65536,
    });
  });

  it("stores one ordered stack and promotes a model without copying fields", () => {
    const first = createModelProfile([], "Fast", {
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-old",
      "config/ai/api_key": "sk-profile",
    }, 1000);
    const profiles = createModelProfile(first, "Backup", {
      "config/ai/provider": "workers-ai",
      "config/ai/model": "@cf/backup",
    }, 1500);
    const edited = updateModelProfile(profiles, profiles[0].id, "Fast", {
      ...profiles[0].values,
      "config/ai/model": "gpt-new",
    }, 2000);
    const nextProfiles = makeModelPrimary(edited, profiles[1].id);
    const clearedSecretKeys = new Map([[profiles[0].id, new Set<string>()]]);
    const entries = modelProfileSaveEntries(0, nextProfiles, clearedSecretKeys);
    // SAFETY: Test fixture uses the asserted API shape for this focused case.
    const storedStack = JSON.parse(
      entries.find((entry) => entry.key === modelProfilesConfigKey(0))?.value ?? "{}",
    ) as { models?: Array<{ id: string; model: string }> };

    expect(storedStack.models?.map((model) => model.id)).toEqual(["backup", "fast"]);
    expect(storedStack.models?.[1].model).toBe("gpt-new");
    expect(entries).toContainEqual({
      key: modelProfileSecretConfigKey(0, profiles[0].id, "config/ai/api_key"),
      value: "sk-profile",
    });
    expect(modelProfilesConfigKey(0)).toBe("config/ai/models");
    expect(modelProfileSecretConfigKey(0, profiles[0].id, "config/ai/api_key"))
      .toBe("config/ai/models/fast/api_key");
  });

  it("keeps fallback order in the stack and runtime policy out of model entries", () => {
    expect(MODEL_PROFILE_FIELDS).toBe(AGENT_MODEL_FIELDS);
    expect(AGENT_MODEL_FIELDS.some((field) => field.key === "config/ai/fallback_model_profile")).toBe(false);
    expect(AGENT_MODEL_FIELDS.some((field) => field.key === "config/ai/reasoning")).toBe(false);
    expect(AGENT_MODEL_FIELDS.some((field) => field.key === "config/ai/max_context_bytes")).toBe(false);
    expect(AGENT_MODEL_FIELDS.some((field) => field.key === "config/ai/context_window_tokens")).toBe(true);
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

  it("shows the inherited system order until the owner writes a stack", () => {
    const config: ConsoleConfigEntry[] = [{
      key: "config/ai/models",
      value: JSON.stringify({
        version: 1,
        models: [
          { id: "primary", name: "Primary", provider: "workers-ai", model: "@cf/primary" },
          { id: "backup", name: "Backup", provider: "workers-ai", model: "@cf/backup" },
        ],
      }),
      redacted: false,
    }];

    expect(modelProfilesForConfig(config, 42)).toEqual([]);
    expect(modelProfilesForConfig(config, 42, { inheritSystem: true }).map((profile) => profile.id))
      .toEqual(["primary", "backup"]);
    expect(inheritsSystemModelStack(config, 42)).toBe(true);
    expect(inheritsSystemModelStack(config, 0)).toBe(false);
    expect(modelProfileSaveEntries(42, [])[0]).toEqual({
      key: "users/42/ai/models",
      value: "",
    });
    expect(() => modelProfileSaveEntries(0, [])).toThrow(
      "The system model stack must contain at least one model.",
    );
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

  it("uses the canonical stack for text while merging personal media limits", () => {
    const config: ConsoleConfigEntry[] = [
      {
        key: "config/ai/models",
        value: JSON.stringify({
          version: 1,
          models: [{ id: "system", name: "System", provider: "workers-ai", model: "@cf/default/model" }],
        }),
        redacted: false,
      },
      {
        key: buildUserAiOverrideKey(42, "config/ai/image/read/max_tokens"),
        value: "1234",
        redacted: false,
      },
    ];

    expect(effectiveAiValuesForViewer(config, 42)).toMatchObject({
      "config/ai/provider": "workers-ai",
      "config/ai/model": "@cf/default/model",
      "config/ai/image/read/max_tokens": "1234",
    });
  });

  it("does not fill a partial personal media connection from system fields", () => {
    const config: ConsoleConfigEntry[] = [
      {
        key: "config/ai/transcription/provider",
        value: "workers-ai",
        redacted: false,
      },
      {
        key: "config/ai/transcription/model",
        value: "@cf/openai/whisper-large-v3-turbo",
        redacted: false,
      },
      {
        key: "users/42/ai/transcription/provider",
        value: "openai",
        redacted: false,
      },
    ];

    expect(effectiveAiValuesForViewer(config, 42)).toMatchObject({
      "config/ai/transcription/provider": "openai",
      "config/ai/transcription/model": "",
      "config/ai/transcription/api_key": "",
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
    });
  });

  it("ignores obsolete scalar text-model overrides", () => {
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
    expect(modelStackDisplayName({
      "config/ai/provider": "gsv",
      "config/ai/model": "default",
    })).toBe("GSV included");
  });
});
