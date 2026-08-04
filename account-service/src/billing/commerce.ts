import type { PlatformAuthService } from "../auth/service";
import { sha256Hex } from "../security/tokens";
import {
  parseExternalId,
  parsePlanKey,
  type BillingCommerceProvider,
  type BillingHostedSession,
} from "./domain";
import { BillingProviderPriceCatalog } from "./plans";
import { BillingStore } from "./store";

const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BillingAuth = Pick<PlatformAuthService, "requireRecentPasskeySession">;

export class BillingProviderUnavailableError extends Error {}
export class BillingSubscriptionExistsError extends Error {}

export class BillingCommerceService {
  constructor(
    private readonly store: BillingStore,
    private readonly auth: BillingAuth,
    private readonly provider: BillingCommerceProvider,
    private readonly prices: BillingProviderPriceCatalog,
    private readonly accountOrigin: string,
  ) {}

  async checkout(input: {
    sessionToken: string;
    installationId: string;
    planKey: string;
    idempotencyKey: string;
  }): Promise<BillingHostedSession> {
    const session = await this.auth.requireRecentPasskeySession(input.sessionToken);
    const planKey = parsePlanKey(input.planKey);
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const operationId = `billing_checkout_${await sha256Hex(
      `${session.principal.id}:${idempotencyKey}`,
    )}`;
    const operation = await this.store.beginSessionOperation({
      operationId,
      principalId: session.principal.id,
      installationId: input.installationId,
      provider: this.provider.name,
      kind: "checkout",
      planKey,
    });
    const existing = await this.store.getSubscriptionByInstallation(
      operation.installationId,
    );
    if (existing && operation.state !== "complete") {
      await this.store.failSessionOperation({
        operationId,
        errorCode: "subscription_exists",
      });
      throw new BillingSubscriptionExistsError(
        "installation already has a subscription",
      );
    }

    try {
      const account = await this.ensureBillingAccount({
        principalId: session.principal.id,
        email: session.principal.email,
        displayName: session.principal.displayName,
      });
      const hosted = validateHostedSession(await this.provider.createCheckout({
        operationId,
        customerId: account.providerCustomerId,
        installationId: operation.installationId,
        planKey,
        providerPriceId: this.prices.require(planKey),
        successUrl: new URL("/billing?checkout=complete", this.accountOrigin).toString(),
        cancelUrl: new URL("/billing?checkout=cancelled", this.accountOrigin).toString(),
      }), true);
      await this.store.completeSessionOperation({
        operationId,
        providerSessionId: hosted.sessionId,
        providerSessionExpiresAt: hosted.expiresAt,
      });
      return hosted;
    } catch (error) {
      await this.store.failSessionOperation({
        operationId,
        errorCode: commerceFailureCode(error),
      }).catch(() => undefined);
      if (error instanceof BillingSubscriptionExistsError) throw error;
      throw new BillingProviderUnavailableError(
        "billing checkout is temporarily unavailable",
      );
    }
  }

  async portal(input: {
    sessionToken: string;
    installationId: string;
    idempotencyKey: string;
  }): Promise<BillingHostedSession> {
    const session = await this.auth.requireRecentPasskeySession(input.sessionToken);
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const operationId = `billing_portal_${await sha256Hex(
      `${session.principal.id}:${idempotencyKey}`,
    )}`;
    const operation = await this.store.beginSessionOperation({
      operationId,
      principalId: session.principal.id,
      installationId: input.installationId,
      provider: this.provider.name,
      kind: "portal",
    });
    const subscription = await this.store.getSubscriptionByInstallation(
      operation.installationId,
    );
    if (!subscription || subscription.principalId !== session.principal.id) {
      await this.store.failSessionOperation({
        operationId,
        errorCode: "subscription_unavailable",
      });
      throw new Error("billing subscription is unavailable");
    }

    try {
      const hosted = validateHostedSession(await this.provider.createPortal({
        operationId,
        customerId: subscription.providerCustomerId,
        returnUrl: new URL("/billing", this.accountOrigin).toString(),
      }), false);
      await this.store.completeSessionOperation({
        operationId,
        providerSessionId: hosted.sessionId,
      });
      return hosted;
    } catch (error) {
      await this.store.failSessionOperation({
        operationId,
        errorCode: commerceFailureCode(error),
      }).catch(() => undefined);
      throw new BillingProviderUnavailableError(
        "billing portal is temporarily unavailable",
      );
    }
  }

  private async ensureBillingAccount(input: {
    principalId: string;
    email: string;
    displayName: string;
  }) {
    const existing = await this.store.findBillingAccountForPrincipal(
      input.principalId,
      this.provider.name,
    );
    if (existing) return existing;
    const operationId = `billing_customer_${await sha256Hex(
      `${this.provider.name}:${input.principalId}`,
    )}`;
    const customer = await this.provider.ensureCustomer({
      operationId,
      principalId: input.principalId,
      email: input.email,
      displayName: input.displayName,
    });
    return await this.store.registerBillingAccount({
      principalId: input.principalId,
      provider: this.provider.name,
      providerCustomerId: parseExternalId(
        customer.customerId,
        "provider customer ID",
      ),
    });
  }
}

function parseIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error("idempotencyKey is invalid");
  }
  return value.toLowerCase();
}

function validateHostedSession(
  value: BillingHostedSession,
  requireExpiry: boolean,
): BillingHostedSession {
  const sessionId = parseExternalId(value.sessionId, "provider session ID");
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("provider session URL is invalid");
  }
  if (
    (requireExpiry && value.expiresAt === undefined)
    || (
      value.expiresAt !== undefined
      && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < Date.now())
    )
  ) {
    throw new Error("provider session expiry is invalid");
  }
  return {
    sessionId,
    url: url.toString(),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  };
}

function commerceFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("price")) return "price_unavailable";
  if (message.includes("customer")) return "customer_unavailable";
  if (message.includes("URL") || message.includes("session")) {
    return "provider_response_invalid";
  }
  return "provider_unavailable";
}
