import { describe, expect, it } from "vitest";
import {
  canReadConfigKey,
  isSensitiveConfigKey,
  isSharedSystemConfigKey,
} from "./config-access";

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
    expect(canReadConfigKey(1000, "config/auth/authorization")).toBe(false);
    expect(canReadConfigKey(1000, "config/auth/private_key")).toBe(false);
    expect(canReadConfigKey(1000, "config/auth/cookie")).toBe(false);
    expect(canReadConfigKey(1000, "config/auth/credential")).toBe(false);
    expect(canReadConfigKey(1000, "config/ui/theme")).toBe(false);
    expect(canReadConfigKey(1000, "users/1000/ai/api_key")).toBe(true);
    expect(canReadConfigKey(1000, "users/1001/ai/model")).toBe(false);
  });

  it("shares only explicitly public system configuration semantics", () => {
    expect(isSharedSystemConfigKey("config/server/name")).toBe(true);
    expect(isSharedSystemConfigKey("config/ai/context.d/99-owner-policy.md")).toBe(true);
    expect(isSharedSystemConfigKey("config/ai/api_key")).toBe(false);
    expect(isSharedSystemConfigKey("config/private/innocent_name")).toBe(false);
  });
});
