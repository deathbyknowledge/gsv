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

function stackEntry(
  key: string,
  models: Array<Record<string, string>>,
): ConsoleConfigEntry {
  return {
    key,
    value: JSON.stringify({ version: 1, models }),
    redacted: false,
  };
}

describe("console AI config classification", () => {
  it("preserves the effective owner stack order and stable option ids", () => {
    const config = [
      stackEntry("config/ai/models", [
        { id: "system", name: "System", provider: "workers-ai", model: "@cf/system" },
      ]),
      stackEntry("users/1/ai/models", [
        { id: "primary", name: "Primary", provider: "openai", model: "gpt-5.4" },
        { id: "backup", name: "Backup", provider: "workers-ai", model: "@cf/backup" },
      ]),
    ];

    expect(modelProfilesForConfig(config, 1).map((profile) => profile.id))
      .toEqual(["primary", "backup"]);
    expect(modelLabelsForConfig(config, 1)).toEqual(["Primary", "Backup"]);
    expect(modelOptionsForConfig(config, 1)).toEqual([
      {
        value: "model-entry:primary",
        label: "Primary",
        description: "GPT 5 4",
      },
      {
        value: "model-entry:backup",
        label: "Backup",
        description: "Backup",
      },
    ]);
    expect(defaultModelLabelForConfig(config, 1)).toBe("Primary");
    expect(modelConfigCount(config)).toBe(3);
  });

  it("inherits the system stack only when an owner stack is absent", () => {
    const system = stackEntry("config/ai/models", [
      { id: "system", name: "System Primary", provider: "workers-ai", model: "@cf/system" },
    ]);
    const owner = stackEntry("users/2/ai/models", [
      { id: "owner", name: "Owner Primary", provider: "openai", model: "gpt-5.4" },
    ]);

    expect(defaultModelLabelForConfig([system], 2)).toBe("System Primary");
    expect(defaultModelLabelForConfig([system, owner], 2)).toBe("Owner Primary");
    expect(defaultModelLabelForConfig([], 2)).toBe("NOT CONFIGURED");
  });

  it("hydrates only the credential attached to the selected stack entry", () => {
    const config: ConsoleConfigEntry[] = [
      stackEntry("users/1/ai/models", [
        { id: "fast", name: "Fast", provider: "openai", model: "gpt-5-mini" },
      ]),
      {
        key: "users/1/ai/models/fast/api_key",
        value: "sk-fast",
        redacted: false,
      },
      {
        key: "users/1/ai/api_key",
        value: "sk-obsolete",
        redacted: false,
      },
    ];

    expect(modelProfilesForConfig(config, 1)[0]?.values["config/ai/api_key"])
      .toBe("sk-fast");
  });

  it("ignores obsolete scalar and model_profiles entries", () => {
    const config: ConsoleConfigEntry[] = [
      { key: "config/ai/model", value: "legacy-system", redacted: false },
      { key: "users/1/ai/model", value: "legacy-user", redacted: false },
      {
        key: "users/1/ai/model_profiles",
        value: JSON.stringify({ profiles: [{ id: "legacy", name: "Legacy" }] }),
        redacted: false,
      },
      { key: "config/ai/models/system/api_key", value: "", redacted: true },
      { key: "gateway/theme", value: "gsv-live", redacted: false },
    ];

    expect(modelProfilesForConfig(config, 1)).toEqual([]);
    expect(modelConfigCount(config)).toBe(0);
    expect(overrideConfigEntries(config).map((entry) => entry.key)).toEqual([
      "config/ai/model",
      "gateway/theme",
    ]);
  });
});
