import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountStore } from "../store";
import { EntitlementStore } from "../entitlements/store";
import type { BillingSubscriptionSnapshot, BillingWebhookEvent } from "./domain";
import { FakeBillingProvider } from "./fake-provider";
import { BillingPlanCatalog } from "./plans";
import { BillingReconciler } from "./reconciler";
import { BillingStore } from "./store";
import {
  BillingWebhookProcessor,
  BillingWebhookProcessingError,
  BillingWebhookRejectedError,
} from "./webhooks";

const SIGNING_SECRET = "fake-signing-secret-for-tests";
const PLAN = {
  planKey: "founding-monthly",
  inferenceBudgetMicrounits: 5_000_000,
  storageLimitBytes: 10 * 1024 ** 3,
};
const POLICY = {
  pastDueGraceMs: 100,
  cancelledRetentionMs: 1_000,
};

beforeEach(async () => {
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare("DELETE FROM billing_events"),
    env.ACCOUNT_DB.prepare("DELETE FROM subscriptions"),
    env.ACCOUNT_DB.prepare("DELETE FROM billing_accounts"),
  ]);
});

describe("provider-neutral billing webhooks", () => {
  it("reconciles current provider state once and deduplicates exact replays", async () => {
    const base = Date.now() - 2_000;
    const fixture = await billingFixture("active", base);
    const delivery = await fixture.provider.signedEvent(event("event_active", base));

    await expect(fixture.processor.process(
      delivery.body,
      delivery.headers,
      base,
    )).resolves.toEqual({ accepted: true, outcome: "reconciled" });
    await expect(fixture.entitlements.get(fixture.installationId)).resolves
      .toMatchObject({
        state: "active",
        planKey: "founding-monthly",
        inferenceBudgetMicrounits: 5_000_000,
        version: 1,
      });

    await expect(fixture.processor.process(
      delivery.body,
      delivery.headers,
      base + 1,
    )).resolves.toEqual({ accepted: true, outcome: "duplicate" });
    expect(fixture.provider.subscriptionReads.get("subscription-test")).toBe(1);
    await expect(fixture.entitlements.get(fixture.installationId)).resolves
      .toMatchObject({ version: 1 });
  });

  it("uses a fresh subscription fetch so reordered event notifications are harmless", async () => {
    const base = Date.now() - 2_000;
    const fixture = await billingFixture("active", base);
    const active = await fixture.provider.signedEvent(event("event_first", base));
    await fixture.processor.process(active.body, active.headers, base);

    fixture.provider.setSubscription(snapshot(
      fixture.installationId,
      "past_due",
      base + 10,
    ));
    const delayed = await fixture.provider.signedEvent(
      event("event_delayed", base - 1_000),
    );
    await fixture.processor.process(delayed.body, delayed.headers, base + 20);
    await expect(fixture.entitlements.get(fixture.installationId)).resolves
      .toMatchObject({ state: "past_due", version: 2 });

    const olderAgain = await fixture.provider.signedEvent(
      event("event_older_again", base - 1_500),
    );
    await fixture.processor.process(
      olderAgain.body,
      olderAgain.headers,
      base + 30,
    );
    await expect(fixture.entitlements.get(fixture.installationId)).resolves
      .toMatchObject({ state: "past_due", version: 2 });

    await expect(fixture.reconciler.advanceDue(base + 120)).resolves.toBe(1);
    await expect(fixture.entitlements.get(fixture.installationId)).resolves
      .toMatchObject({ state: "restricted", version: 3 });
  });

  it("keeps a cancelled installation funded through paid time before retention", async () => {
    const base = Date.now() - 2_000;
    const fixture = await billingFixture("cancelled", base, base + 500);
    const delivery = await fixture.provider.signedEvent(
      event("event_cancelled", base),
    );
    await fixture.processor.process(delivery.body, delivery.headers, base);

    await expect(fixture.billing.getSubscriptionByInstallation(
      fixture.installationId,
    )).resolves.toMatchObject({
      state: "cancelled",
      paidThrough: base + 500,
      retentionEndsAt: base + 1_500,
      entitlement: { state: "active" },
    });
    await expect(fixture.entitlements.get(fixture.installationId)).resolves
      .toMatchObject({ state: "active" });

    await expect(fixture.reconciler.advanceDue(base + 500)).resolves.toBe(1);
    await expect(fixture.billing.getSubscriptionByInstallation(
      fixture.installationId,
    )).resolves.toMatchObject({
      state: "retained",
      retentionEndsAt: base + 1_500,
      entitlement: { state: "retained" },
    });
  });

  it("records a content-free failure and safely resumes the same signed event", async () => {
    const base = Date.now() - 2_000;
    const fixture = await billingFixture("active", base, undefined, false);
    const delivery = await fixture.provider.signedEvent(event("event_retry", base));
    await expect(fixture.processor.process(delivery.body, delivery.headers, base))
      .rejects.toBeInstanceOf(BillingWebhookProcessingError);

    await fixture.billing.registerBillingAccount({
      principalId: fixture.principalId,
      provider: fixture.provider.name,
      providerCustomerId: "customer-test",
      now: base + 1,
    });
    await expect(fixture.processor.process(
      delivery.body,
      delivery.headers,
      base + 2,
    )).resolves.toEqual({ accepted: true, outcome: "reconciled" });
    const row = await env.ACCOUNT_DB.prepare(
      `SELECT state, attempt, outcome, last_error_code
       FROM billing_events
       WHERE provider = 'fake' AND provider_event_id = 'event_retry'`,
    ).first<Record<string, unknown>>();
    expect(row).toEqual({
      state: "processed",
      attempt: 2,
      outcome: "reconciled",
      last_error_code: null,
    });
  });

  it("rejects an invalid signature before recording provider input", async () => {
    const base = Date.now() - 2_000;
    const fixture = await billingFixture("active", base);
    const delivery = await fixture.provider.signedEvent(event("event_bad", base));
    delivery.headers.set("x-gsv-fake-signature", "invalid");
    await expect(fixture.processor.process(delivery.body, delivery.headers, base))
      .rejects.toBeInstanceOf(BillingWebhookRejectedError);
    await expect(env.ACCOUNT_DB.prepare(
      "SELECT COUNT(*) AS count FROM billing_events",
    ).first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });
});

async function billingFixture(
  state: BillingSubscriptionSnapshot["state"],
  base: number,
  periodEnd?: number,
  registerCustomer = true,
) {
  const suffix = crypto.randomUUID();
  const principalId = `principal_billing_${suffix}`;
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  await accounts.createPrincipal({
    principalId,
    email: `billing-${suffix}@example.com`,
    displayName: "Billing owner",
    verified: true,
  });
  const reservation = await accounts.reserveInstallation({
    principalId,
    operationId: `operation_billing_${suffix}`,
    handle: `bill-${suffix.slice(0, 8)}`,
    ownerUsername: "owner",
  });
  const billing = new BillingStore(env.ACCOUNT_DB);
  if (registerCustomer) {
    await billing.registerBillingAccount({
      principalId,
      provider: "fake",
      providerCustomerId: "customer-test",
      now: base,
    });
  }
  const provider = new FakeBillingProvider(SIGNING_SECRET);
  provider.setSubscription(snapshot(
    reservation.installationId,
    state,
    base,
    periodEnd,
  ));
  const entitlements = new EntitlementStore(env.ACCOUNT_DB);
  const reconciler = new BillingReconciler(
    billing,
    entitlements,
    new BillingPlanCatalog([PLAN]),
    POLICY,
  );
  return {
    principalId,
    installationId: reservation.installationId,
    billing,
    entitlements,
    provider,
    reconciler,
    processor: new BillingWebhookProcessor(billing, reconciler, provider),
  };
}

function snapshot(
  installationId: string,
  state: BillingSubscriptionSnapshot["state"],
  observedAt: number,
  periodEnd = observedAt + 10_000,
): BillingSubscriptionSnapshot {
  return {
    subscriptionId: "subscription-test",
    customerId: "customer-test",
    installationId,
    planKey: "founding-monthly",
    state,
    observedAt,
    currentPeriodStartsAt: observedAt - 10_000,
    currentPeriodEndsAt: periodEnd,
    cancelAtPeriodEnd: state === "cancelled",
  };
}

function event(eventId: string, createdAt: number): BillingWebhookEvent {
  return {
    eventId,
    createdAt,
    subject: { kind: "subscription", id: "subscription-test" },
  };
}
