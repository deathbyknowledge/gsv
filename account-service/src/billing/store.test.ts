import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../store";
import { BillingStore } from "./store";

describe("billing retention cleanup inventory", () => {
  it("returns only retained installations whose retention deadline passed", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const principalId = `principal_retention_${suffix}`;
    const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
    await accounts.createPrincipal({
      principalId,
      email: `retention-${suffix}@example.com`,
      displayName: "Retention Owner",
      verified: true,
    });
    const retained = await accounts.reserveInstallation({
      principalId,
      operationId: `provision_retention_${suffix}`,
      handle: `retention-${suffix}`,
    });
    const stillActive = await accounts.reserveInstallation({
      principalId,
      operationId: `provision_active_${suffix}`,
      handle: `active-${suffix}`,
    });
    await env.ACCOUNT_DB.prepare(
      "UPDATE installations SET state = 'retained' WHERE id = ?",
    ).bind(retained.installationId).run();

    const billing = new BillingStore(env.ACCOUNT_DB);
    const account = await billing.registerBillingAccount({
      principalId,
      provider: "stripe",
      providerCustomerId: `cus_${suffix}`,
    });
    const now = Date.now();
    const retentionEndsAt = now + 10_000;
    for (const [index, installation] of [retained, stillActive].entries()) {
      await billing.reconcileSubscription({
        account,
        snapshot: {
          subscriptionId: `sub_${suffix}_${index}`,
          customerId: account.providerCustomerId,
          installationId: installation.installationId,
          planKey: "founding-monthly",
          state: "cancelled",
          observedAt: now,
          currentPeriodStartsAt: now - 30 * 24 * 60 * 60_000,
          currentPeriodEndsAt: now - 1,
          cancelAtPeriodEnd: false,
        },
        snapshotHash: `${index}`.repeat(64),
        lifecycle: {
          state: "retained",
          paidThrough: now - 1,
          graceEndsAt: null,
          retentionEndsAt,
          entitlement: {
            state: "retained",
            planKey: "founding-monthly",
            inferenceBudgetMicrounits: 0,
            inferencePeriodStartsAt: now - 30 * 24 * 60 * 60_000,
            inferencePeriodEndsAt: now - 1,
            storageLimitBytes: 10_000_000,
          },
        },
        now,
      });
    }

    await expect(billing.listRetentionDeletionDue(retentionEndsAt - 1))
      .resolves.toEqual([]);
    await expect(billing.listRetentionDeletionDue(retentionEndsAt))
      .resolves.toEqual([{
        installationId: retained.installationId,
        retentionEndsAt,
      }]);
    await expect(billing.listRetentionDeletionDue(retentionEndsAt, 0))
      .rejects.toThrow("list limit is invalid");
  });
});
