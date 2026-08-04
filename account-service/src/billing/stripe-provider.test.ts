import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { StripeBillingProvider, stripeClient } from "./stripe-provider";

const SECRET_KEY = "sk_test_fixture_key_for_workers";
const WEBHOOK_SECRET = "whsec_fixture_secret_for_workers";
const NOW = Math.floor(Date.now() / 1_000) * 1_000;

describe("Stripe billing adapter", () => {
  it("verifies the untouched payload and extracts only a subscription wake-up", async () => {
    const stripe = stripeClient(SECRET_KEY);
    const provider = adapter(stripe);
    const payload = JSON.stringify({
      id: "evt_subscription",
      object: "event",
      api_version: null,
      created: NOW / 1_000,
      data: {
        object: {
          id: "sub_fixture",
          object: "subscription",
        },
      },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "customer.subscription.updated",
    });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: NOW / 1_000,
      cryptoProvider: Stripe.createSubtleCryptoProvider(crypto.subtle),
    });
    const body = new TextEncoder().encode(payload).buffer as ArrayBuffer;

    await expect(provider.verifyWebhook(
      body,
      new Headers({ "Stripe-Signature": signature }),
    )).resolves.toEqual({
      eventId: "evt_subscription",
      createdAt: NOW,
      subject: { kind: "subscription", id: "sub_fixture" },
    });
    const changed = new TextEncoder().encode(`${payload} `).buffer as ArrayBuffer;
    await expect(provider.verifyWebhook(
      changed,
      new Headers({ "Stripe-Signature": signature }),
    )).rejects.toThrow();
  });

  it("extracts the subscription from an expanded Checkout session", async () => {
    const stripe = stripeClient(SECRET_KEY);
    const provider = adapter(stripe);
    const payload = JSON.stringify({
      id: "evt_checkout",
      object: "event",
      api_version: null,
      created: NOW / 1_000,
      data: {
        object: {
          id: "cs_fixture",
          object: "checkout.session",
          subscription: { id: "sub_checkout", object: "subscription" },
        },
      },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
    });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: NOW / 1_000,
      cryptoProvider: Stripe.createSubtleCryptoProvider(crypto.subtle),
    });

    await expect(provider.verifyWebhook(
      new TextEncoder().encode(payload).buffer as ArrayBuffer,
      new Headers({ "Stripe-Signature": signature }),
    )).resolves.toEqual({
      eventId: "evt_checkout",
      createdAt: NOW,
      subject: { kind: "subscription", id: "sub_checkout" },
    });
  });

  it("normalizes one known Stripe price and item period", async () => {
    const stripe = stripeClient(SECRET_KEY);
    vi.spyOn(stripe.subscriptions, "retrieve").mockResolvedValue({
      id: "sub_fixture",
      object: "subscription",
      customer: "cus_fixture",
      metadata: {
        gsv_installation_id: "inst_fixture",
        gsv_plan_key: "founding-monthly",
      },
      status: "past_due",
      cancel_at_period_end: false,
      items: {
        data: [{
          quantity: 1,
          price: { id: "price_founding" },
          current_period_start: 1_799_000_000,
          current_period_end: 1_801_000_000,
        }],
      },
    } as unknown as Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>);

    await expect(adapter(stripe).getSubscription("sub_fixture")).resolves
      .toEqual({
        subscriptionId: "sub_fixture",
        customerId: "cus_fixture",
        installationId: "inst_fixture",
        planKey: "founding-monthly",
        state: "past_due",
        observedAt: NOW,
        currentPeriodStartsAt: 1_799_000_000_000,
        currentPeriodEndsAt: 1_801_000_000_000,
        cancelAtPeriodEnd: false,
      });
  });

  it.each(["paused", "unpaid"] as const)(
    "keeps a recoverable %s subscription out of cancellation retention",
    async (status) => {
      const stripe = stripeClient(SECRET_KEY);
      vi.spyOn(stripe.subscriptions, "retrieve").mockResolvedValue({
        id: "sub_recoverable",
        object: "subscription",
        customer: "cus_fixture",
        metadata: {
          gsv_installation_id: "inst_fixture",
          gsv_plan_key: "founding-monthly",
        },
        status,
        cancel_at_period_end: false,
        items: {
          data: [{
            quantity: 1,
            price: { id: "price_founding" },
            current_period_start: 1_799_000_000,
            current_period_end: 1_801_000_000,
          }],
        },
      } as unknown as Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>);

      await expect(adapter(stripe).getSubscription("sub_recoverable"))
        .resolves.toMatchObject({ state: "past_due" });
    },
  );

  it("creates hosted subscription checkout with tax and immutable routing metadata", async () => {
    const stripe = stripeClient(SECRET_KEY);
    const create = vi.spyOn(stripe.checkout.sessions, "create").mockResolvedValue({
      id: "cs_fixture",
      object: "checkout.session",
      url: "https://checkout.stripe.com/c/pay/fixture",
      expires_at: 1_800_001_800,
    } as unknown as Awaited<ReturnType<typeof stripe.checkout.sessions.create>>);
    const provider = adapter(stripe);
    await expect(provider.createCheckout({
      operationId: "billing_checkout_fixture",
      customerId: "cus_fixture",
      installationId: "inst_fixture",
      planKey: "founding-monthly",
      providerPriceId: "price_founding",
      successUrl: "https://accounts.gsv.space/billing?checkout=complete",
      cancelUrl: "https://accounts.gsv.space/billing?checkout=cancelled",
    })).resolves.toEqual({
      sessionId: "cs_fixture",
      url: "https://checkout.stripe.com/c/pay/fixture",
      expiresAt: 1_800_001_800_000,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription",
      customer: "cus_fixture",
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      client_reference_id: "inst_fixture",
      line_items: [{ price: "price_founding", quantity: 1 }],
      expires_at: Math.floor(NOW / 1_000) + 31 * 60,
      subscription_data: {
        metadata: expect.objectContaining({
          gsv_installation_id: "inst_fixture",
          gsv_plan_key: "founding-monthly",
        }),
      },
    }), { idempotencyKey: "billing_checkout_fixture" });
  });

  it("can opt into Stripe's merchant-of-record checkout without changing GSV contracts", async () => {
    const stripe = stripeClient(SECRET_KEY);
    const create = vi.spyOn(stripe.checkout.sessions, "create").mockResolvedValue({
      id: "cs_managed",
      object: "checkout.session",
      url: "https://checkout.stripe.com/c/pay/managed",
      expires_at: 1_800_001_800,
    } as unknown as Awaited<ReturnType<typeof stripe.checkout.sessions.create>>);
    const provider = new StripeBillingProvider({
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      merchantMode: "managed_payments",
      prices: [{
        planKey: "founding-monthly",
        providerPriceId: "price_founding",
      }],
    }, stripe, () => NOW);
    await provider.createCheckout({
      operationId: "billing_checkout_managed",
      customerId: "cus_fixture",
      installationId: "inst_fixture",
      planKey: "founding-monthly",
      providerPriceId: "price_founding",
      successUrl: "https://accounts.gsv.space/billing?checkout=complete",
      cancelUrl: "https://accounts.gsv.space/billing?checkout=cancelled",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      managed_payments: { enabled: true },
    }), expect.anything());
    expect(create.mock.calls[0][0]).not.toHaveProperty("automatic_tax");
  });
});

function adapter(stripe: Stripe): StripeBillingProvider {
  return new StripeBillingProvider({
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    merchantMode: "direct",
    prices: [{
      planKey: "founding-monthly",
      providerPriceId: "price_founding",
    }],
  }, stripe, () => NOW);
}
