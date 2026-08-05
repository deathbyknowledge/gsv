import { describe, expect, it } from "vitest";
import {
  createInstallationId,
  LEGACY_STANDALONE_INSTALLATION_ID,
  parseCanonicalOrigin,
  parseInstallationIdentity,
  parseInstallationId,
} from "./identity";

describe("installation identity", () => {
  it("preserves the legacy standalone Durable Object name", () => {
    expect(LEGACY_STANDALONE_INSTALLATION_ID).toBe("singleton");
  });

  it("creates opaque installation IDs that pass validation", () => {
    const installationId = createInstallationId();
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

  it("normalizes and validates canonical origins", () => {
    expect(parseCanonicalOrigin("https://Hank.GSV.Space:443")).toBe(
      "https://hank.gsv.space",
    );
    expect(parseCanonicalOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(parseCanonicalOrigin("http://hank.localhost:8787")).toBe(
      "http://hank.localhost:8787",
    );
    expect(() => parseCanonicalOrigin("http://hank.gsv.space")).toThrow("must use https");
    expect(() => parseCanonicalOrigin("https://hank.gsv.space/path")).toThrow("URL origin");
  });

  it("validates installation handles independently of IDs", () => {
    expect(parseInstallationIdentity({
      installationId: "inst_a123",
      handle: "hank-2",
      canonicalOrigin: "https://hank-2.gsv.space",
    })).toEqual({
      installationId: "inst_a123",
      handle: "hank-2",
      canonicalOrigin: "https://hank-2.gsv.space",
    });
    expect(() => parseInstallationIdentity({
      installationId: "inst_a123",
      handle: "Hank",
      canonicalOrigin: "https://hank.gsv.space",
    })).toThrow("handle is invalid");
  });
});
