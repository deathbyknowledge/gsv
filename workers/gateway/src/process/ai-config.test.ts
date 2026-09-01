import { describe, expect, it } from "vitest";
import {
  createProcessAiConfigSnapshot,
  parseProcessAiModelProfiles,
} from "./ai-config";

describe("process ai config", () => {
  it("keeps fallback model profile in process snapshots", () => {
    const snapshot = createProcessAiConfigSnapshot({
      "config/ai/model": "primary-model",
      "config/ai/fallback_model_profile": "backup-stack",
    });

    expect(snapshot.values["config/ai/fallback_model_profile"]).toBe("backup-stack");
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
