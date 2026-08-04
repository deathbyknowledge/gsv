import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../store";
import { EntitlementStore, type EntitlementProjection } from "./store";

async function reservedInstallation(label: string): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const principalId = `principal_${label}_${suffix}`;
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  await accounts.createPrincipal({
    principalId,
    email: `${label}-${suffix}@example.com`,
    displayName: label,
    verified: true,
  });
  const reservation = await accounts.reserveInstallation({
    principalId,
    operationId: `operation_${label}_${suffix}`,
    handle: `${label}-${suffix}`,
  });
  return reservation.installationId;
}

function projection(
  installationId: string,
  override: Partial<EntitlementProjection> = {},
): EntitlementProjection {
  return {
    installationId,
    state: "trialing",
    planKey: "founding-trial",
    inferenceBudgetMicrounits: 5_000_000,
    inferencePeriodStartsAt: Date.now(),
    inferencePeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10_000_000_000,
    effectiveAt: Date.now(),
    version: 1,
    ...override,
  };
}

describe("entitlement projection", () => {
  it("accepts an idempotent projection and rejects stale or conflicting versions", async () => {
    const installationId = await reservedInstallation("projection");
    const store = new EntitlementStore(env.ACCOUNT_DB);
    const first = projection(installationId);

    await expect(store.project(first)).resolves.toEqual(first);
    await expect(store.project(first)).resolves.toEqual(first);
    const audits = await env.ACCOUNT_DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE id = ? AND action = 'entitlement.projected'`,
    ).bind(`audit_entitlement_${installationId}_1`).first<{ count: number }>();
    expect(audits?.count).toBe(1);
    await expect(store.project({
      ...first,
      state: "active",
    })).rejects.toThrow("stale or conflicts");
    await expect(store.project({
      ...first,
      version: 2,
      state: "active",
    })).resolves.toMatchObject({ version: 2, state: "active" });
    await expect(store.project(first)).rejects.toThrow("stale or conflicts");
  });

  it("allows provisioning only for an effective trial or active grant", async () => {
    const installationId = await reservedInstallation("decision");
    const store = new EntitlementStore(env.ACCOUNT_DB);
    await expect(store.requireProvisioningAllowed(installationId))
      .rejects.toThrow("required");

    await expect(store.project(projection(installationId, {
      effectiveAt: Date.now() + 5 * 60_000,
    }))).rejects.toThrow("effectiveAt is invalid");

    await store.project(projection(installationId, {
      state: "restricted",
      version: 2,
    }));
    await expect(store.requireProvisioningAllowed(installationId))
      .rejects.toThrow("required");

    await store.project(projection(installationId, {
      state: "active",
      version: 3,
    }));
    await expect(store.requireProvisioningAllowed(installationId))
      .resolves.toMatchObject({ state: "active", version: 3 });
  });

  it("cannot project an entitlement onto an unknown installation", async () => {
    const store = new EntitlementStore(env.ACCOUNT_DB);
    await expect(store.project(projection(`inst_${crypto.randomUUID()}`)))
      .rejects.toThrow("installation is unavailable");
  });
});
