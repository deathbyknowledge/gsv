import { describe, expect, it } from "vitest";
import type { ConsoleConfigEntry } from "./consoleModels";
import {
  defaultModelLabelForConfig,
  modelConfigCount,
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
});
