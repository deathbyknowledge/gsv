import { describe, expect, it } from "vitest";
import {
  checkoutProvisioningTarget,
  handleError,
  installationStatus,
  normalizeHandle,
  ownerUsernameForHandle,
  verificationTokenFromHash,
} from "./domain";
import type { ManagedInstallation } from "./types";

describe("managed account presentation", () => {
  it("validates public handles while keeping local usernames independent", () => {
    expect(normalizeHandle("  Hank-Lab ")).toBe("hank-lab");
    expect(handleError("hank-lab")).toBeNull();
    expect(handleError("accounts")).toContain("reserved");
    expect(handleError("bad handle")).toContain("lowercase");
    expect(ownerUsernameForHandle("hank-lab")).toBe("hank-lab");
    expect(ownerUsernameForHandle("42")).toBe("owner");
    expect(ownerUsernameForHandle("a".repeat(33))).toBe("owner");
  });

  it("reads a bounded verification bearer only from the fragment", () => {
    expect(verificationTokenFromHash("#token=gsvverify_abc123"))
      .toBe("gsvverify_abc123");
    expect(verificationTokenFromHash("#token=has%20space")).toBeNull();
    expect(verificationTokenFromHash("?token=query")).toBeNull();
  });

  it("resumes only the remembered or sole incomplete installation", () => {
    const first = installation({ installationId: "inst_first", handle: "first" });
    const second = installation({ installationId: "inst_second", handle: "second" });
    expect(checkoutProvisioningTarget([first, second], "inst_second"))
      .toEqual(second);
    expect(checkoutProvisioningTarget([first], null)).toEqual(first);
    expect(checkoutProvisioningTarget([first, second], null)).toBeNull();
  });

  it("makes restriction and deletion state understandable without provider jargon", () => {
    expect(installationStatus(installation({
      state: "restricted",
      operationState: "complete",
    }))).toMatchObject({ label: "RESTRICTED", tone: "error" });
    expect(installationStatus(installation({
      state: "deleting",
      operationState: "complete",
    }))).toMatchObject({ label: "DELETION PENDING", tone: "warning" });
  });
});

function installation(
  overrides: Partial<ManagedInstallation> = {},
): ManagedInstallation {
  return {
    installationId: "inst_fixture",
    handle: "fixture",
    canonicalOrigin: "https://fixture.gsv.space",
    state: "reserved",
    operationState: "reserved",
    ownerUsername: "fixture",
    agentName: "GSV",
    timezone: "Europe/Amsterdam",
    reservationExpiresAt: 1_900_000_000_000,
    entitlement: null,
    ...overrides,
  };
}
