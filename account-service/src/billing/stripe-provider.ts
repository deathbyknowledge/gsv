import Stripe from "stripe";
import {
  parseExternalId,
  parsePlanKey,
  type BillingCommerceProvider,
  type BillingHostedSession,
  type BillingProviderSubscriptionState,
  type BillingSubscriptionSnapshot,
  type BillingWebhookEvent,
} from "./domain";

const WEBHOOK_TOLERANCE_SECONDS = 300;
const CHECKOUT_TTL_SECONDS = 31 * 60;

export type StripeMerchantMode = "direct" | "managed_payments";

export type StripeBillingConfig = {
  secretKey: string;
  webhookSecret: string;
  prices: readonly { planKey: string; providerPriceId: string }[];
  merchantMode: StripeMerchantMode;
};

export class StripeBillingProvider implements BillingCommerceProvider {
  readonly name = "stripe";
  private readonly webhookSecret: string;
  private readonly plansByPrice = new Map<string, string>();

  constructor(
    config: StripeBillingConfig,
    private readonly stripe = stripeClient(config.secretKey),
    private readonly clock: () => number = Date.now,
  ) {
    if (!config.webhookSecret.startsWith("whsec_") || config.webhookSecret.length < 16) {
      throw new Error("Stripe webhook secret is invalid");
    }
    this.webhookSecret = config.webhookSecret;
    this.merchantMode = config.merchantMode;
    for (const entry of config.prices) {
      const priceId = parseExternalId(entry.providerPriceId, "provider price ID");
      const planKey = parsePlanKey(entry.planKey);
      if (this.plansByPrice.has(priceId)) {
        throw new Error("Stripe price is duplicated");
      }
      this.plansByPrice.set(priceId, planKey);
    }
    if (this.plansByPrice.size === 0) {
      throw new Error("Stripe price configuration is required");
    }
  }

  private readonly merchantMode: StripeMerchantMode;

  async verifyWebhook(
    rawBody: ArrayBuffer,
    headers: Headers,
  ): Promise<BillingWebhookEvent> {
    const signature = headers.get("stripe-signature");
    if (!signature) throw new Error("Stripe signature is required");
    const event = await this.stripe.webhooks.constructEventAsync(
      new Uint8Array(rawBody),
      signature,
      this.webhookSecret,
      WEBHOOK_TOLERANCE_SECONDS,
      Stripe.createSubtleCryptoProvider(crypto.subtle),
    );
    const object = event.data.object as unknown as Record<string, unknown>;
    const eventId = parseExternalId(event.id, "provider event ID");
    const createdAt = secondsToMs(event.created, "Stripe event timestamp");
    if (
      object.object === "subscription"
      && typeof object.id === "string"
    ) {
      return {
        eventId,
        createdAt,
        subject: { kind: "subscription", id: object.id },
      };
    }
    const checkoutSubscriptionId = object.object === "checkout.session"
      ? optionalExpandableId(object.subscription)
      : null;
    if (checkoutSubscriptionId) {
      return {
        eventId,
        createdAt,
        subject: { kind: "subscription", id: checkoutSubscriptionId },
      };
    }
    return { eventId, createdAt, subject: { kind: "other" } };
  }

  async getSubscription(
    subscriptionIdValue: string,
  ): Promise<BillingSubscriptionSnapshot> {
    const subscriptionId = parseExternalId(
      subscriptionIdValue,
      "provider subscription ID",
    );
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const customerId = expandableId(subscription.customer, "Stripe customer");
    const installationId = parseExternalId(
      subscription.metadata.gsv_installation_id,
      "Stripe installation metadata",
    );
    if (subscription.items.data.length !== 1) {
      throw new Error("Stripe subscription must contain exactly one item");
    }
    const item = subscription.items.data[0];
    if (!item || item.quantity !== 1) {
      throw new Error("Stripe subscription quantity is invalid");
    }
    const priceId = expandableId(item.price, "Stripe price");
    const planKey = this.plansByPrice.get(priceId);
    if (!planKey || subscription.metadata.gsv_plan_key !== planKey) {
      throw new Error("Stripe subscription price is unavailable");
    }
    return {
      subscriptionId: subscription.id,
      customerId,
      installationId,
      planKey,
      state: stripeSubscriptionState(subscription.status),
      observedAt: this.clock(),
      currentPeriodStartsAt: secondsToMs(
        item.current_period_start,
        "Stripe subscription period start",
      ),
      currentPeriodEndsAt: secondsToMs(
        item.current_period_end,
        "Stripe subscription period end",
      ),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    };
  }

  async ensureCustomer(input: {
    operationId: string;
    principalId: string;
    email: string;
    displayName: string;
  }): Promise<{ customerId: string }> {
    const customer = await this.stripe.customers.create({
      email: input.email,
      name: input.displayName,
      metadata: {
        gsv_principal_id: input.principalId,
      },
    }, {
      idempotencyKey: input.operationId,
    });
    return { customerId: customer.id };
  }

  async createCheckout(input: {
    operationId: string;
    customerId: string;
    installationId: string;
    planKey: string;
    providerPriceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<BillingHostedSession> {
    if (this.plansByPrice.get(input.providerPriceId) !== input.planKey) {
      throw new Error("Stripe checkout price is invalid");
    }
    const metadata = {
      gsv_installation_id: input.installationId,
      gsv_plan_key: input.planKey,
      gsv_operation_id: input.operationId,
    };
    const merchant = this.merchantMode === "managed_payments"
      ? { managed_payments: { enabled: true } }
      : {
          automatic_tax: { enabled: true },
          billing_address_collection: "required" as const,
          customer_update: { address: "auto" as const, name: "auto" as const },
          tax_id_collection: { enabled: true },
        };
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      client_reference_id: input.installationId,
      line_items: [{ price: input.providerPriceId, quantity: 1 }],
      metadata,
      subscription_data: { metadata },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: Math.floor(this.clock() / 1_000) + CHECKOUT_TTL_SECONDS,
      ...merchant,
    }, {
      idempotencyKey: input.operationId,
    });
    if (!session.url) throw new Error("Stripe checkout URL is unavailable");
    return {
      sessionId: session.id,
      url: session.url,
      expiresAt: secondsToMs(session.expires_at, "Stripe checkout expiry"),
    };
  }

  async createPortal(input: {
    operationId: string;
    customerId: string;
    returnUrl: string;
  }): Promise<BillingHostedSession> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    }, {
      idempotencyKey: input.operationId,
    });
    return { sessionId: session.id, url: session.url };
  }
}

export function stripeClient(secretKey: string): Stripe {
  if (!secretKey.startsWith("sk_") || secretKey.length < 16) {
    throw new Error("Stripe secret key is invalid");
  }
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(fetch),
    maxNetworkRetries: 2,
    timeout: 10_000,
    telemetry: false,
    emitEventBodies: false,
    appInfo: {
      name: "GSV",
      version: "0.4.1",
      url: "https://gsv.space",
    },
  });
}

function stripeSubscriptionState(
  state: Stripe.Subscription.Status,
): BillingProviderSubscriptionState {
  if (state === "trialing") return "trialing";
  if (state === "active") return "active";
  if (state === "past_due") return "past_due";
  if (state === "incomplete") return "pending";
  if (state === "paused" || state === "unpaid") return "past_due";
  if (
    state === "canceled"
    || state === "incomplete_expired"
  ) {
    return "cancelled";
  }
  throw new Error("Stripe subscription state is unsupported");
}

function expandableId(
  value: string | { id: string },
  field: string,
): string {
  return parseExternalId(typeof value === "string" ? value : value.id, field);
}

function optionalExpandableId(value: unknown): string | null {
  if (typeof value === "string") {
    return parseExternalId(value, "Stripe subscription");
  }
  if (
    typeof value === "object"
    && value !== null
    && "id" in value
    && typeof value.id === "string"
  ) {
    return parseExternalId(value.id, "Stripe subscription");
  }
  return null;
}

function secondsToMs(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is invalid`);
  }
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`${field} is invalid`);
  }
  return milliseconds;
}
