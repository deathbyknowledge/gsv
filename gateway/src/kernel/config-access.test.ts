import { describe, expect, it } from "vitest";
import { isSensitiveConfigKey } from "./config-access";

describe("config access policy", () => {
  it("detects sensitive config keys", () => {
    expect(isSensitiveConfigKey("config/ai/api_key")).toBe(true);
    expect(isSensitiveConfigKey("config/auth/client_secret")).toBe(true);
    expect(isSensitiveConfigKey("config/server/name")).toBe(false);
  });

});
