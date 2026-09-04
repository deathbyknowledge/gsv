import { describe, expect, it } from "vitest";
import type { ConsoleConfigEntry } from "./consoleModels";
import { listingFromConfig } from "./consoleModelListing.testSupport";
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
  editableModelSource,
  modelDisplayName,
  makeModelPrimary,
  modelProfileSaveEntries,
  modelProfileSecretConfigKey,
  modelProfilesConfigKey,
  modelProfilesFromListing,
  preferredModelSaveEntry,
  modelStackDisplayName,
  modelValidationValuesFromProfileDrafts,
  serializeModelProfiles,
  updateModelProfile,
} from "./consoleSettings";

function primaryProfile(config: readonly ConsoleConfigEntry[], uid: number) {
  return modelProfilesFromListing(listingFromConfig(config, uid), config, uid)[0] ?? null;
}

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

  it("projects the effective stack and hydrates only the viewer's own credentials", () => {
    const profiles = createModelProfile([], "Fast", {
      "config/ai/provider": "openai",
      "config/ai/model": "gpt-5.4",
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
    const listing = {
      preferredModelId: null,
      models: [
        { id: profiles[0].id, name: "Fast", provider: "openai", model: "gpt-5.4", source: "personal" as const, hasCredential: true },
        { id: "shared", name: "Shared", provider: "anthropic", model: "claude-sonnet-5", source: "system" as const, hasCredential: true },
        { id: "gsv-included", name: "GSV Included", provider: "gsv", model: "default", source: "base" as const, hasCredential: false },
      ],
    };

    const projected = modelProfilesFromListing(listing, config, 42);
    expect(projected.map((profile) => [profile.id, profile.source])).toEqual([
      [profiles[0].id, "personal"],
      ["shared", "system"],
      ["gsv-included", "base"],
    ]);
    expect(projected[0].values["config/ai/api_key"]).toBe("sk-fast");
    expect(projected[1].values["config/ai/api_key"]).toBe("");
    expect(modelProfilesFromListing(null, config, 42)).toEqual([]);
  });

  it("edits the installation list as root and a personal list otherwise", () => {
    expect(editableModelSource(0)).toBe("system");
    expect(editableModelSource(42)).toBe("personal");
    expect(preferredModelSaveEntry(42, "gsv-included")).toEqual({
      key: "users/42/ai/preferred_model",
      value: "gsv-included",
    });
    expect(preferredModelSaveEntry(42, null)).toEqual({ key: "users/42/ai/preferred_model", value: "" });
    expect(modelProfileSaveEntries(42, [])[0]).toEqual({
      key: "users/42/ai/models",
      value: "",
    });
    expect(modelProfileSaveEntries(0, [])[0]).toEqual({
      key: "config/ai/models",
      value: "",
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

    expect(effectiveAiValuesForViewer(config, 42, primaryProfile(config, 42))).toMatchObject({
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

    expect(effectiveAiValuesForViewer(config, 42, primaryProfile(config, 42))).toMatchObject({
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

    expect(effectiveAiValuesForViewer(config, 42, primaryProfile(config, 42))).toMatchObject({
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

    expect(effectiveAiValuesForViewer(config, 42, primaryProfile(config, 42))).toMatchObject({
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
