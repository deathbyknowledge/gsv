import { describe, expect, it } from "vitest";
import { normalizeConfigPayload } from "./consoleNormalization";

describe("console normalization", () => {
  it("redacts secrets nested inside model profile config values", () => {
    const [entry] = normalizeConfigPayload({
      entries: [{
        key: "users/42/ai/model_profiles",
        value: JSON.stringify({
          version: 1,
          profiles: [{
            id: "deep-research",
            name: "Deep Research",
            values: {
              "config/ai/provider": "openai",
              "config/ai/model": "gpt-5",
              "config/ai/api_key": "sk-secret",
            },
          }],
        }),
      }],
    });

    expect(entry.redacted).toBe(false);
    expect(entry.value).not.toContain("sk-secret");
    expect(JSON.parse(entry.value)).toMatchObject({
      profiles: [{
        values: {
          "config/ai/provider": "openai",
          "config/ai/model": "gpt-5",
          "config/ai/api_key": "",
        },
      }],
    });
  });
});
