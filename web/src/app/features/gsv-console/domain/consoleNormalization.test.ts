import { describe, expect, it } from "vitest";
import {
  normalizeAccountsPayload,
  normalizeConfigPayload,
  normalizeTargetsPayload,
} from "./consoleNormalization";

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

  it("classifies browser and native device targets", () => {
    expect(normalizeTargetsPayload({
      devices: [
        { deviceId: "browser:brave", label: "Brave", platform: "browser-extension", online: true },
        { deviceId: "macbook", label: "MacBook", platform: "darwin", online: true, implements: ["net.fetch", "fs.*"] },
      ],
    })).toMatchObject([
      { deviceId: "browser:brave", kind: "browser" },
      { deviceId: "macbook", kind: "native-device", implements: ["fs.*", "net.fetch"] },
    ]);
  });

  it("normalizes resolved account capabilities", () => {
    expect(normalizeAccountsPayload({
      accounts: [{
        uid: 2000,
        username: "scout",
        displayName: "Scout",
        relation: "agent",
        runnable: true,
        capabilities: ["repo.read", "fs.*", "", "shell.*"],
      }],
    })[0]).toMatchObject({
      username: "scout",
      capabilities: ["fs.*", "repo.read", "shell.*"],
    });
  });
});
