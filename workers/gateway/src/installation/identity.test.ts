import { describe, expect, it } from "vitest";
import {
  parseInstallationId,
  parseManagedInstallationId,
  SINGLETON_INSTALLATION_ID,
} from "./identity";

describe("installation identity", () => {
  it("preserves the legacy standalone Durable Object name", () => {
    expect(SINGLETON_INSTALLATION_ID).toBe("singleton");
  });

  it("accepts opaque installation IDs", () => {
    const installationId = `inst_${crypto.randomUUID()}`;
    expect(installationId).toMatch(/^inst_[0-9a-f-]+$/);
    expect(parseInstallationId(installationId)).toBe(installationId);
  });

  it.each([
    "",
    " leading",
    "trailing ",
    "installations/hank",
    "wildcard*",
    "a".repeat(129),
  ])("rejects unsafe installation ID %j", (installationId) => {
    expect(() => parseInstallationId(installationId)).toThrow("installationId is invalid");
  });

  it("rejects non-string installation IDs", () => {
    expect(() => parseInstallationId(null)).toThrow("installationId must be a string");
  });

  it("reserves the standalone identity from managed routing", () => {
    expect(parseManagedInstallationId("inst_first")).toBe("inst_first");
    expect(() => parseManagedInstallationId(SINGLETON_INSTALLATION_ID))
      .toThrow("cannot use the standalone identity");
  });
});
