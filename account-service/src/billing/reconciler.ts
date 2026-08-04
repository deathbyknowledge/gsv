import type { EntitlementProjector } from "../entitlements/projector";
import { sha256Hex } from "../security/tokens";
import {
  deriveBillingLifecycle,
  parseSubscriptionSnapshot,
  stableSnapshot,
  type BillingLifecyclePolicy,
  type BillingSubscriptionSnapshot,
} from "./domain";
import { BillingPlanCatalog } from "./plans";
import {
  BillingStore,
  type StoredBillingSubscription,
} from "./store";

export class BillingReconciler {
  constructor(
    private readonly billing: BillingStore,
    private readonly entitlements: EntitlementProjector,
    private readonly plans: BillingPlanCatalog,
    private readonly policy: BillingLifecyclePolicy,
  ) {}

  async reconcile(
    provider: string,
    snapshotValue: BillingSubscriptionSnapshot,
    now = Date.now(),
  ): Promise<StoredBillingSubscription> {
    const snapshot = parseSubscriptionSnapshot(snapshotValue, now);
    const account = await this.billing.requireBillingAccountByCustomer(
      provider,
      snapshot.customerId,
    );
    const snapshotHash = await sha256Hex(stableSnapshot(snapshot));
    const installationState = await this.billing.getInstallationState(
      snapshot.installationId,
    );
    if (installationState === "deleting" || installationState === "deleted") {
      return await this.billing.reconcileTerminalSubscription({
        account,
        snapshot,
        snapshotHash,
        now,
      });
    }
    const existing = await this.billing.getSubscriptionByInstallation(
      snapshot.installationId,
    );
    const lifecycle = deriveBillingLifecycle({
      snapshot,
      plan: this.plans.require(snapshot.planKey),
      existing,
      policy: this.policy,
      now,
    });
    const stored = await this.billing.reconcileSubscription({
      account,
      snapshot,
      snapshotHash,
      lifecycle,
      now,
    });
    if (stored.entitlement && stored.entitlementEffectiveAt !== null) {
      await this.entitlements.project({
        installationId: stored.installationId,
        ...stored.entitlement,
        effectiveAt: stored.entitlementEffectiveAt,
        version: stored.entitlementVersion,
      });
    }
    return stored;
  }

  async advanceDue(now = Date.now()): Promise<number> {
    const due = await this.billing.listLifecycleDue(now);
    for (const subscription of due) {
      await this.reconcile(subscription.provider, {
        subscriptionId: subscription.providerSubscriptionId,
        customerId: subscription.providerCustomerId,
        installationId: subscription.installationId,
        planKey: subscription.planKey,
        state: subscription.providerState,
        observedAt: subscription.providerObservedAt,
        currentPeriodStartsAt: subscription.currentPeriodStartsAt,
        currentPeriodEndsAt: subscription.currentPeriodEndsAt,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      }, now);
    }
    return due.length;
  }
}
