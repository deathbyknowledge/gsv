import { describe, expect, it } from "vitest";
import {
  parseInstallationId,
  shipAddress,
} from "./identity";

describe("installation identity", () => {
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


  it("addresses a Ship by handle on the operator's primary domain", () => {
    const identity = { installationId: "inst_1", handle: "Hank", canonicalOrigin: "https://hank.gsv.space" };
    expect(shipAddress(identity, "ship.space")).toEqual({ handle: "hank", origin: "https://hank.ship.space", domain: "ship.space" });
    expect(shipAddress(identity)).toEqual({ handle: "hank", origin: "https://hank.gsv.space", domain: "gsv.space" });
    expect(shipAddress({ ...identity, canonicalOrigin: "https://other.example" })).toBeNull();
    expect(shipAddress({ ...identity, handle: undefined }, "ship.space")).toBeNull();
    expect(shipAddress(null, "ship.space")).toBeNull();
  });
});
