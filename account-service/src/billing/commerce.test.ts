import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformSession } from "../auth/store";
import { EntitlementStore } from "../entitlements/store";
import { AccountStore } from "../store";
import { BillingCommerceService } from "./commerce";
import { FakeBillingProvider } from "./fake-provider";
import { BillingPlanCatalog, BillingProviderPriceCatalog } from "./plans";
import { BillingReconciler } from "./reconciler";
import { BillingStore } from "./store";

const POLICY = {
  pastDueGraceMs: 7 * 24 * 60 * 60_000,
  cancelledRetentionMs: 30 * 24 * 60 * 60_000,
};

beforeEach(async () => {
  await env.ACCOUNT_DB.batch([
    env.ACCOUNT_DB.prepare("DELETE FROM billing_session_operations"),
    env.ACCOUNT_DB.prepare("DELETE FROM billing_events"),
    env.ACCOUNT_DB.prepare("DELETE FROM subscriptions"),
    env.ACCOUNT_DB.prepare("DELETE FROM billing_accounts"),
  ]);
});

describe("billing hosted commerce", () => {
  it("creates one customer and one checkout session across an exact retry", async () => {
    const fixture = await commerceFixture();
    const createCheckout = vi.spyOn(fixture.provider, "createCheckout");
    const request = {
      sessionToken: "session-token",
      installationId: fixture.installationId,
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    };
    const first = await fixture.service.checkout(request);
    const replay = await fixture.service.checkout(request);

    expect(replay).toEqual(first);
    expect(first.url).toMatch(/^https:\/\/checkout\.billing\.test\//);
    expect(fixture.auth.requireRecentPasskeySession).toHaveBeenCalledTimes(2);
    expect(createCheckout).toHaveBeenCalledWith(expect.objectContaining({
      successUrl: "https://accounts.gsv.space/?checkout=complete",
      cancelUrl: "https://accounts.gsv.space/?checkout=cancelled",
    }));
    await expect(env.ACCOUNT_DB.prepare(
      "SELECT COUNT(*) AS count FROM billing_accounts",
    ).first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT state, attempt, provider_session_id
       FROM billing_session_operations
       WHERE kind = 'checkout'`,
    ).first<Record<string, unknown>>()).resolves.toMatchObject({
      state: "complete",
      attempt: 2,
      provider_session_id: first.sessionId,
    });
  });

  it("rejects reuse of an idempotency key for a different plan", async () => {
    const fixture = await commerceFixture();
    const idempotencyKey = crypto.randomUUID();
    await fixture.service.checkout({
      sessionToken: "session-token",
      installationId: fixture.installationId,
      planKey: "founding-monthly",
      idempotencyKey,
    });
    await expect(fixture.service.checkout({
      sessionToken: "session-token",
      installationId: fixture.installationId,
      planKey: "other-plan",
      idempotencyKey,
    })).rejects.toThrow("idempotency key conflicts");
  });

  it("allows only one active checkout session per installation", async () => {
    const fixture = await commerceFixture();
    await fixture.service.checkout({
      sessionToken: "session-token",
      installationId: fixture.installationId,
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    });

    await expect(fixture.service.checkout({
      sessionToken: "session-token",
      installationId: fixture.installationId,
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow("checkout is already in progress");
    await expect(env.ACCOUNT_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM billing_session_operations
       WHERE installation_id = ? AND kind = 'checkout'`,
    ).bind(fixture.installationId).first<{ count: number }>())
      .resolves.toEqual({ count: 1 });
  });

  it("releases an expired checkout before creating its replacement", async () => {
    const fixture = await commerceFixture();
    await fixture.service.checkout({
      sessionToken: "session-token",
      installationId: fixture.installationId,
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    });
    await env.ACCOUNT_DB.prepare(
      `UPDATE billing_session_operations
       SET provider_session_expires_at = ?
       WHERE installation_id = ? AND kind = 'checkout'`,
    ).bind(Date.now() - 11 * 60_000, fixture.installationId).run();

    await expect(fixture.service.checkout({
      sessionToken: "session-token",
      installationId: fixture.installationId,
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    })).resolves.toMatchObject({
      url: expect.stringMatching(/^https:\/\/checkout\.billing\.test\//),
    });
    const rows = await env.ACCOUNT_DB.prepare(
      `SELECT state
       FROM billing_session_operations
       WHERE installation_id = ? AND kind = 'checkout'
       ORDER BY created_at ASC`,
    ).bind(fixture.installationId).all<{ state: string }>();
    expect(rows.results.map((row) => row.state).sort())
      .toEqual(["complete", "expired"]);
  });

  it("opens a portal only for an installation with a reconciled subscription", async () => {
    const fixture = await commerceFixture();
    await fixture.service.checkout({
      sessionToken: "session-token",
      installationId: fixture.installationId,
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    });
    const billingAccount = await fixture.billing.findBillingAccountForPrincipal(
      fixture.session.principal.id,
      "fake",
    );
    fixture.provider.setSubscription({
      subscriptionId: "subscription-commerce",
      customerId: billingAccount!.providerCustomerId,
      installationId: fixture.installationId,
      planKey: "founding-monthly",
      state: "active",
      observedAt: Date.now(),
      currentPeriodStartsAt: Date.now() - 1_000,
      currentPeriodEndsAt: Date.now() + 30 * 24 * 60 * 60_000,
      cancelAtPeriodEnd: false,
    });
    await fixture.reconciler.reconcile(
      "fake",
      await fixture.provider.getSubscription("subscription-commerce"),
    );

    const portal = await fixture.service.portal({
      sessionToken: "session-token",
      installationId: fixture.installationId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(portal.url).toMatch(/^https:\/\/portal\.billing\.test\//);
  });
});

async function commerceFixture() {
  const suffix = crypto.randomUUID();
  const principalId = `principal_commerce_${suffix}`;
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
  await accounts.createPrincipal({
    principalId,
    email: `commerce-${suffix}@example.com`,
    displayName: "Commerce owner",
    verified: true,
  });
  const reservation = await accounts.reserveInstallation({
    principalId,
    operationId: `operation_commerce_${suffix}`,
    handle: `commerce-${suffix.slice(0, 8)}`,
    ownerUsername: "owner",
  });
  const session = {
    principal: {
      id: principalId,
      email: `commerce-${suffix}@example.com`,
      displayName: "Commerce owner",
      state: "active" as const,
    },
    authMethod: "passkey" as const,
    recentAuthAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  } as PlatformSession;
  const auth = {
    requireRecentPasskeySession: vi.fn(async () => session),
  };
  const billing = new BillingStore(env.ACCOUNT_DB);
  const provider = new FakeBillingProvider("commerce-fake-signing-secret");
  const plans = new BillingPlanCatalog([{
    planKey: "founding-monthly",
    inferenceBudgetMicrounits: 5_000_000,
    storageLimitBytes: 10 * 1024 ** 3,
  }, {
    planKey: "other-plan",
    inferenceBudgetMicrounits: 1,
    storageLimitBytes: 1,
  }]);
  const reconciler = new BillingReconciler(
    billing,
    new EntitlementStore(env.ACCOUNT_DB),
    plans,
    POLICY,
  );
  return {
    auth,
    billing,
    installationId: reservation.installationId,
    provider,
    reconciler,
    session,
    service: new BillingCommerceService(
      billing,
      auth,
      provider,
      new BillingProviderPriceCatalog([{
        planKey: "founding-monthly",
        providerPriceId: "price_founding",
      }]),
      "https://accounts.gsv.space",
    ),
  };
}
