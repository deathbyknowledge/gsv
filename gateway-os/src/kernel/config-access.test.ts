import { describe, expect, it } from "vitest";
import { canReadConfigKey, isSensitiveConfigKey } from "./config-access";

describe("config access policy", () => {
  it("detects sensitive config keys", () => {
    expect(isSensitiveConfigKey("config/ai/api_key")).toBe(true);
    expect(isSensitiveConfigKey("config/auth/client_secret")).toBe(true);
    expect(isSensitiveConfigKey("config/server/name")).toBe(false);
  });

  it("allows root to read any key", () => {
    expect(canReadConfigKey(0, "config/ai/api_key")).toBe(true);
    expect(canReadConfigKey(0, "users/1000/ai/api_key")).toBe(true);
  });

  it("filters non-root reads by scope and sensitivity", () => {
    expect(canReadConfigKey(1000, "config/ai/provider")).toBe(true);
    expect(canReadConfigKey(1000, "config/ai/api_key")).toBe(false);
    expect(canReadConfigKey(1000, "users/1000/ai/api_key")).toBe(true);
    expect(canReadConfigKey(1000, "users/1001/ai/model")).toBe(false);
  });
});
