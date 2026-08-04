import { env } from "cloudflare:workers";
import type {
  ManagedEntitlementProjection,
  ManagedGatewayLifecycleInterface,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "../store";
import { GatewayEntitlementProjector } from "./projector";
import { EntitlementStore } from "./store";

describe("Gateway entitlement projector", () => {
  it("retries Kernel delivery after the account projection commits", async () => {
    const suffix = crypto.randomUUID();
    const principalId = `principal_projector_${suffix}`;
    const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
    await accounts.createPrincipal({
      principalId,
      email: `projector-${suffix}@example.com`,
      displayName: "Projection owner",
      verified: true,
    });
    const installation = await accounts.reserveInstallation({
      principalId,
      operationId: `operation_projector_${suffix}`,
      handle: `projection-${suffix.slice(0, 8)}`,
      ownerUsername: "owner",
    });
    const projection = entitlement(installation.installationId);
    const applyManagedEntitlement = vi.fn(
      async (input: ManagedEntitlementProjection) => input,
    );
    applyManagedEntitlement.mockRejectedValueOnce(new Error("Gateway unavailable"));
    const gateway = { applyManagedEntitlement } satisfies ManagedGatewayLifecycleInterface;
    const store = new EntitlementStore(env.ACCOUNT_DB);
    const projector = new GatewayEntitlementProjector(store, gateway);

    await expect(projector.project(projection)).rejects.toThrow("Gateway unavailable");
    await expect(store.get(installation.installationId)).resolves.toEqual(projection);

    await expect(projector.project(projection)).resolves.toEqual(projection);
    expect(applyManagedEntitlement).toHaveBeenCalledTimes(2);
    expect(applyManagedEntitlement).toHaveBeenLastCalledWith(projection);
  });
});

function entitlement(installationId: string): ManagedEntitlementProjection {
  const now = Date.now();
  return {
    installationId,
    state: "active",
    planKey: "founding-monthly",
    inferenceBudgetMicrounits: 5_000_000,
    inferencePeriodStartsAt: now,
    inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10 * 1024 ** 3,
    effectiveAt: now,
    version: 1,
  };
}
