import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./config";

describe("normalizeConfig", () => {
  it("canonicalizes the routing username without changing the token", () => {
    const config = normalizeConfig({
      gatewayUrl: "https://gsv.example.test",
      username: " Alice ",
      token: "  exact token  ",
      deviceId: "chrome",
      autoConnect: true,
    });

    expect(config.gatewayUrl).toBe("wss://gsv.example.test/ws");
    expect(config.username).toBe("alice");
    expect(config.token).toBe("  exact token  ");
  });

  it("does not Unicode-fold an invalid username into another identity", () => {
    const config = normalizeConfig({
      gatewayUrl: "https://gsv.example.test",
      username: "Kate",
      token: "token",
      deviceId: "chrome",
      autoConnect: true,
    });

    expect(config.username).toBe("");
  });
});
