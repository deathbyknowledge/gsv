import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { InstallationLifecycleStore } from "../lifecycle/store";
import { AccountStore } from "../store";
import { FakeBillingProvider } from "./fake-provider";
import { BillingPlanCatalog } from "./plans";
import { BillingReconciler } from "./reconciler";
import { BillingStore } from "./store";
import {
  BillingTerminationService,
  BillingTerminationStore,
} from "./termination";

const DAY_MS = 24 * 60 * 60_000;

describe("billing termination", () => {
  it("cancels provider billing independently of the recoverable data teardown", async () => {
    const fixture = await terminationFixture();
    const operation = await fixture.terminations.getForDeletion(
      fixture.deletionOperationId,
    );
    expect(operation).toMatchObject({ state: "requested" });

    await expect(fixture.service.advanceDue(fixture.now + 1)).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    await expect(fixture.terminations.getForDeletion(fixture.deletionOperationId))
      .resolves.toMatchObject({ state: "complete", attempt: 1 });
    await expect(fixture.billing.getSubscriptionByInstallation(fixture.installationId))
      .resolves.toMatchObject({
        providerState: "cancelled",
        state: "cancelled",
        entitlement: null,
      });
    await expect(fixture.billing.getInstallationState(fixture.installationId))
      .resolves.toBe("deleting");
    expect(fixture.project).not.toHaveBeenCalled();
    await expect(fixture.service.advanceDue(fixture.now + 2)).resolves.toEqual({
      claimed: 0,
      completed: 0,
      failed: 0,
    });
  });

  it("retries the same provider operation after a transient cancellation failure", async () => {
    const fixture = await terminationFixture();
    const cancel = vi.spyOn(fixture.provider, "cancelSubscription");
    cancel.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(fixture.service.advanceDue(fixture.now + 1)).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 1,
    });
    const pending = await fixture.terminations.getForDeletion(
      fixture.deletionOperationId,
    );
    expect(pending).toMatchObject({
      state: "requested",
      attempt: 1,
      lastErrorCode: "provider_unavailable",
    });
    if (!pending) throw new Error("billing termination retry was not persisted");

    await expect(fixture.service.advanceDue(pending.nextAttemptAt)).resolves
      .toMatchObject({ claimed: 1, completed: 1 });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel.mock.calls[0]?.[0]).toEqual(cancel.mock.calls[1]?.[0]);
  });

  it("cancels an unclaimed obligation on recovery and ignores late active snapshots", async () => {
    const fixture = await terminationFixture();
    await fixture.lifecycle.recover(
      fixture.deletionOperationId,
      fixture.principalId,
      fixture.now + 1,
    );
    await expect(fixture.terminations.getForDeletion(fixture.deletionOperationId))
      .resolves.toMatchObject({ state: "cancelled" });
    await expect(fixture.service.advanceDue(fixture.now + 2)).resolves
      .toMatchObject({ claimed: 0 });

    const second = await terminationFixture();
    second.project.mockClear();
    await second.reconciler.reconcile("fake", {
      ...second.snapshot,
      state: "active",
      observedAt: second.now + 5,
    }, second.now + 5);
    await expect(second.billing.getInstallationState(second.installationId))
      .resolves.toBe("deleting");
    expect(second.project).not.toHaveBeenCalled();
  });
});

async function terminationFixture() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const principalId = `principal_termination_${suffix}`;
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  await accounts.createPrincipal({
    principalId,
    email: `termination-${suffix}@example.com`,
    displayName: "Termination Owner",
    verified: true,
  });
  const installation = await accounts.reserveInstallation({
    principalId,
    operationId: `provision_termination_${suffix}`,
    handle: `termination-${suffix}`,
  });
  await env.ACCOUNT_DB.prepare(
    "UPDATE installations SET state = 'active' WHERE id = ?",
  ).bind(installation.installationId).run();
  const now = Date.now();
  const billing = new BillingStore(env.ACCOUNT_DB);
  const billingAccount = await billing.registerBillingAccount({
    principalId,
    provider: "fake",
    providerCustomerId: `customer_${suffix}`,
    now,
  });
  const snapshot = {
    subscriptionId: `subscription_${suffix}`,
    customerId: billingAccount.providerCustomerId,
    installationId: installation.installationId,
    planKey: "founding-monthly",
    state: "active" as const,
    observedAt: now,
    currentPeriodStartsAt: now - DAY_MS,
    currentPeriodEndsAt: now + 30 * DAY_MS,
    cancelAtPeriodEnd: false,
  };
  await billing.reconcileSubscription({
    account: billingAccount,
    snapshot,
    snapshotHash: "a".repeat(64),
    lifecycle: {
      state: "active",
      paidThrough: snapshot.currentPeriodEndsAt,
      graceEndsAt: null,
      retentionEndsAt: null,
      entitlement: {
        state: "active",
        planKey: snapshot.planKey,
        inferenceBudgetMicrounits: 5_000_000,
        inferencePeriodStartsAt: snapshot.currentPeriodStartsAt,
        inferencePeriodEndsAt: snapshot.currentPeriodEndsAt,
        storageLimitBytes: 10_000_000,
      },
    },
    now,
  });
  const lifecycle = new InstallationLifecycleStore(env.ACCOUNT_DB);
  const deletion = await lifecycle.beginUserDeletion({
    operationId: `deletion_termination_${suffix}`,
    principalId,
    installationId: installation.installationId,
    confirmedHandle: installation.handle,
    recoverableUntil: now + 7 * DAY_MS,
    now,
  });
  const provider = new FakeBillingProvider(
    "termination-test-signing-secret",
  );
  provider.setSubscription(snapshot);
  const project = vi.fn(async (input) => input);
  const reconciler = new BillingReconciler(
    billing,
    { project },
    new BillingPlanCatalog([{
      planKey: "founding-monthly",
      inferenceBudgetMicrounits: 5_000_000,
      storageLimitBytes: 10_000_000,
    }]),
    {
      pastDueGraceMs: 7 * DAY_MS,
      cancelledRetentionMs: 30 * DAY_MS,
    },
  );
  const terminations = new BillingTerminationStore(env.ACCOUNT_DB);
  return {
    service: new BillingTerminationService(terminations, provider, reconciler),
    terminations,
    provider,
    reconciler,
    project,
    lifecycle,
    billing,
    snapshot,
    principalId,
    installationId: installation.installationId,
    deletionOperationId: deletion.operationId,
    now,
  };
}
