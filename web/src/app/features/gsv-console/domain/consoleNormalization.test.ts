import { describe, expect, it } from "vitest";
import { normalizeConfigPayload, normalizeTargetsPayload } from "./consoleNormalization";

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

  it("infers target presentation kind from device id and platform", () => {
    expect(normalizeTargetsPayload({
      devices: [
        { deviceId: "browser:brave", label: "Brave", platform: "browser-extension", online: true },
        { deviceId: "adapter:discord:ops", label: "Discord", platform: "adapter", online: true },
        { deviceId: "macbook", label: "MacBook", platform: "darwin", online: true },
      ],
    })).toMatchObject([
      { deviceId: "browser:brave", kind: "browser" },
      { deviceId: "adapter:discord:ops", kind: "adapter" },
      { deviceId: "macbook", kind: "native-device" },
    ]);
  });
});
