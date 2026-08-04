import { env } from "cloudflare:workers";
import type {
  ManagedGatewayProvisioningInterface,
  ProvisionInstallationInput,
  ProvisionInstallationResult,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { EntitlementStore } from "./entitlements/store";
import { provisionReservedInstallation } from "./provisioning";
import { AccountStore } from "./store";

function store(): AccountStore {
  return new AccountStore(env.ACCOUNT_DB, "gsv.space");
}

async function createVerifiedPrincipal(suffix: string): Promise<string> {
  const principalId = `principal_${suffix}`;
  await store().createPrincipal({
    principalId,
    email: `${suffix}@example.com`,
    displayName: suffix,
    verified: true,
  });
  return principalId;
}

function successfulGateway(): ManagedGatewayProvisioningInterface & {
  provisionInstallation: ReturnType<typeof vi.fn>;
} {
  return {
    provisionInstallation: vi.fn(async (
      input: ProvisionInstallationInput,
    ): Promise<ProvisionInstallationResult> => ({
      state: "active",
      installationId: input.installation.installationId,
      principalId: input.owner.principalId,
      localUid: 1000,
      username: input.owner.username,
      provisionVersion: input.provisionVersion,
    })),
  };
}

async function grantProvisioningEntitlement(installationId: string): Promise<void> {
  await new EntitlementStore(env.ACCOUNT_DB).project({
    installationId,
    state: "active",
    planKey: "test",
    inferenceBudgetMicrounits: 5_000_000,
    inferencePeriodStartsAt: Date.now(),
    inferencePeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10_000_000,
    effectiveAt: Date.now(),
    version: 1,
  });
}

describe("managed account store", () => {
  it("atomically reserves a handle for a verified principal", async () => {
    const principalId = await createVerifiedPrincipal("reserve");
    const reservation = await store().reserveInstallation({
      principalId,
      operationId: "op_reserve",
      handle: "reserved-home",
    });

    expect(reservation).toMatchObject({
      ownerPrincipalId: principalId,
      handle: "reserved-home",
      canonicalOrigin: "https://reserved-home.gsv.space",
      state: "reserved",
      operationState: "reserved",
    });
    await expect(store().resolveHostname("reserved-home.gsv.space")).resolves.toMatchObject({
      found: true,
      state: "reserved",
      installationId: reservation.installationId,
    });
  });

  it("returns the same reservation when an operation is replayed", async () => {
    const principalId = await createVerifiedPrincipal("replay");
    const first = await store().reserveInstallation({
      principalId,
      operationId: "op_replay",
      handle: "replay-home",
    });
    const second = await store().reserveInstallation({
      principalId,
      operationId: "op_replay",
      handle: "replay-home",
    });

    expect(second).toEqual(first);
  });

  it("expires an abandoned reservation so its handle can be claimed again", async () => {
    const firstPrincipal = await createVerifiedPrincipal("expiry_first");
    const first = await store().reserveInstallation({
      principalId: firstPrincipal,
      operationId: "op_expiry_first",
      handle: "expiry-home",
    });
    await env.ACCOUNT_DB.prepare(
      "UPDATE installations SET reservation_expires_at = ? WHERE id = ?",
    ).bind(Date.now() - 1, first.installationId).run();

    await expect(store().expireReservations()).resolves.toBe(1);
    await expect(store().resolveHostname("expiry-home.gsv.space")).resolves.toEqual({
      found: false,
    });
    const secondPrincipal = await createVerifiedPrincipal("expiry_second");
    await expect(store().reserveInstallation({
      principalId: secondPrincipal,
      operationId: "op_expiry_second",
      handle: "expiry-home",
    })).resolves.toMatchObject({ ownerPrincipalId: secondPrincipal });

    const audit = await env.ACCOUNT_DB.prepare(
      `SELECT principal_id, installation_id, action
       FROM audit_events
       WHERE id = ?`,
    ).bind(`audit_reservation_expired_${first.installationId}`).first<{
      principal_id: string;
      installation_id: string | null;
      action: string;
    }>();
    expect(audit).toEqual({
      principal_id: firstPrincipal,
      installation_id: null,
      action: "installation.reservation_expired",
    });
  });

  it("lets only one principal claim a handle", async () => {
    const firstPrincipal = await createVerifiedPrincipal("race_a");
    const secondPrincipal = await createVerifiedPrincipal("race_b");
    const attempts = await Promise.allSettled([
      store().reserveInstallation({
        principalId: firstPrincipal,
        operationId: "op_race_a",
        handle: "race-home",
      }),
      store().reserveInstallation({
        principalId: secondPrincipal,
        operationId: "op_race_b",
        handle: "race-home",
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "handle is unavailable" }),
    });
  });

  it("does not reserve for an unverified principal", async () => {
    await store().createPrincipal({
      principalId: "principal_unverified",
      email: "unverified@example.com",
      displayName: "Unverified",
    });

    await expect(store().reserveInstallation({
      principalId: "principal_unverified",
      operationId: "op_unverified",
      handle: "unverified-home",
    })).rejects.toThrow("verified active principal is required");
    await expect(store().resolveHostname("unverified-home.gsv.space")).resolves.toEqual({
      found: false,
    });
  });

  it("keeps control-plane hostnames unavailable as installation handles", async () => {
    const principalId = await createVerifiedPrincipal("reserved_names");
    for (const handle of ["accounts", "billing", "telegram", "webhooks"]) {
      await expect(store().reserveInstallation({
        principalId,
        operationId: `op_reserved_${handle}`,
        handle,
      })).rejects.toThrow("handle is reserved");
    }
  });

  it("activates routing only after private Gateway provisioning succeeds", async () => {
    const principalId = await createVerifiedPrincipal("provision");
    const reservation = await store().reserveInstallation({
      principalId,
      operationId: "op_provision",
      handle: "provision-home",
    });
    await grantProvisioningEntitlement(reservation.installationId);
    const gateway = successfulGateway();

    const result = await provisionReservedInstallation(store(), gateway, {
      principalId,
      operationId: "op_provision",
      username: "owner",
      agentName: "companion",
      timezone: "Europe/Amsterdam",
    });

    expect(result).toMatchObject({ state: "active", operationState: "complete" });
    expect(gateway.provisionInstallation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "op_provision",
      owner: {
        principalId,
        username: "owner",
        agentName: "companion",
        timezone: "Europe/Amsterdam",
      },
    }));
    await expect(store().resolveHostname("provision-home.gsv.space")).resolves.toMatchObject({
      found: true,
      state: "active",
    });
  });

  it("resumes a failed provisioning operation without creating another installation", async () => {
    const principalId = await createVerifiedPrincipal("resume");
    const reserved = await store().reserveInstallation({
      principalId,
      operationId: "op_resume",
      handle: "resume-home",
    });
    await grantProvisioningEntitlement(reserved.installationId);
    const gateway = successfulGateway();
    gateway.provisionInstallation
      .mockRejectedValueOnce(new Error("Gateway unavailable"));

    await expect(provisionReservedInstallation(store(), gateway, {
      principalId,
      operationId: "op_resume",
      username: "owner",
    })).rejects.toThrow("Gateway unavailable");

    const completed = await provisionReservedInstallation(store(), gateway, {
      principalId,
      operationId: "op_resume",
      username: "owner",
    });
    expect(completed.installationId).toBe(reserved.installationId);
    expect(completed.operationState).toBe("complete");
    expect(gateway.provisionInstallation).toHaveBeenCalledTimes(2);
  });

  it("does not activate a mismatched Gateway result", async () => {
    const principalId = await createVerifiedPrincipal("mismatch");
    const reservation = await store().reserveInstallation({
      principalId,
      operationId: "op_mismatch",
      handle: "mismatch-home",
    });
    await grantProvisioningEntitlement(reservation.installationId);
    const gateway: ManagedGatewayProvisioningInterface = {
      provisionInstallation: vi.fn(async () => ({
        state: "active" as const,
        installationId: "inst_wrong",
        principalId,
        localUid: 1000,
        username: "owner",
        provisionVersion: 1,
      })),
    };

    await expect(provisionReservedInstallation(store(), gateway, {
      principalId,
      operationId: "op_mismatch",
      username: "owner",
    })).rejects.toThrow("mismatched provisioning result");
    await expect(store().resolveHostname("mismatch-home.gsv.space")).resolves.toMatchObject({
      found: true,
      state: "provisioning",
    });
  });

  it.each([
    ["username", { username: "different-owner" }],
    ["local uid", { localUid: 1000.5 }],
  ])("does not activate a Gateway result with a mismatched %s", async (suffix, override) => {
    const key = suffix.replace(" ", "_");
    const principalId = await createVerifiedPrincipal(`result_${key}`);
    const reserved = await store().reserveInstallation({
      principalId,
      operationId: `op_result_${key}`,
      handle: `result-${key.replace("_", "-")}`,
    });
    await grantProvisioningEntitlement(reserved.installationId);
    const gateway: ManagedGatewayProvisioningInterface = {
      provisionInstallation: vi.fn(async (input) => ({
        state: "active" as const,
        installationId: reserved.installationId,
        principalId,
        localUid: 1000,
        username: input.owner.username,
        provisionVersion: 1,
        ...override,
      })),
    };

    await expect(provisionReservedInstallation(store(), gateway, {
      principalId,
      operationId: `op_result_${key}`,
      username: "owner",
    })).rejects.toThrow("mismatched provisioning result");
  });

  it("does not allocate a Kernel before an authoritative entitlement exists", async () => {
    const principalId = await createVerifiedPrincipal("no_entitlement");
    await store().reserveInstallation({
      principalId,
      operationId: "op_no_entitlement",
      handle: "no-entitlement-home",
    });
    const gateway = successfulGateway();

    await expect(provisionReservedInstallation(store(), gateway, {
      principalId,
      operationId: "op_no_entitlement",
      username: "owner",
    })).rejects.toThrow("provisioning entitlement is required");
    expect(gateway.provisionInstallation).not.toHaveBeenCalled();
  });
});
