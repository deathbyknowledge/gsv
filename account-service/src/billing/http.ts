import {
  type AuthAbuseProtection,
  RateLimitExceededError,
} from "../auth/abuse";
import {
  hasExpectedOrigin,
  json,
  readJsonObject,
  requestClient,
  requireSessionToken,
  requireString,
} from "../http";
import {
  BillingProviderUnavailableError,
  BillingSubscriptionExistsError,
  type BillingCommerceService,
} from "./commerce";
import {
  BillingWebhookProcessingError,
  BillingWebhookRejectedError,
  type BillingWebhookProcessor,
} from "./webhooks";
import type { BillingOverviewService } from "./overview";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const OVERVIEW_PATH = "/api/billing";
const CHECKOUT_PATH = "/api/billing/checkout";
const PORTAL_PATH = "/api/billing/portal";
const STRIPE_WEBHOOK_PATH = "/api/billing/webhooks/stripe";

type BillingCommerce = Pick<BillingCommerceService, "checkout" | "portal">;
type BillingWebhooks = Pick<BillingWebhookProcessor, "process">;
type BillingOverview = Pick<BillingOverviewService, "get">;
type BillingProviderServices = {
  commerce: BillingCommerce;
  webhooks: BillingWebhooks;
};

export function isBillingPath(pathname: string): boolean {
  return pathname === OVERVIEW_PATH
    || pathname === CHECKOUT_PATH
    || pathname === PORTAL_PATH
    || pathname === STRIPE_WEBHOOK_PATH;
}

export class BillingHttp {
  constructor(
    private readonly overview: BillingOverview,
    private readonly providerServices: () => BillingProviderServices,
    private readonly abuse: AuthAbuseProtection,
    private readonly accountOrigin: string,
    private readonly offer: {
      planKey: string;
      currency: string;
      monthlyPriceMinor: number;
    },
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === OVERVIEW_PATH) {
      try {
        return json({
          offer: this.offer,
          installations: await this.overview.get(requireSessionToken(request)),
        });
      } catch (error) {
        return commerceError(error);
      }
    }
    if (request.method === "POST" && url.pathname === CHECKOUT_PATH) {
      return await this.withBrowserBoundary(request, "checkout");
    }
    if (request.method === "POST" && url.pathname === PORTAL_PATH) {
      return await this.withBrowserBoundary(request, "portal");
    }
    if (request.method === "POST" && url.pathname === STRIPE_WEBHOOK_PATH) {
      return await this.webhook(request);
    }
    return null;
  }

  private async withBrowserBoundary(
    request: Request,
    action: "checkout" | "portal",
  ): Promise<Response> {
    if (!hasExpectedOrigin(request, this.accountOrigin)) {
      return json({ error: "Forbidden" }, 403);
    }
    try {
      const sessionToken = requireSessionToken(request);
      const body = await readJsonObject(request);
      const client = await requestClient(request);
      await this.abuse.check({
        operation: action === "checkout" ? "billing_checkout" : "billing_portal",
        ipHash: client.ipHash,
        subject: sessionToken,
      });
      const installationId = requireString(
        body.installationId,
        "installationId",
      );
      const idempotencyKey = requireString(
        body.idempotencyKey,
        "idempotencyKey",
      );
      const hosted = action === "checkout"
        ? await this.services().commerce.checkout({
            sessionToken,
            installationId,
            idempotencyKey,
            planKey: requireString(body.planKey, "planKey"),
          })
        : await this.services().commerce.portal({
            sessionToken,
            installationId,
            idempotencyKey,
          });
      return json({
        session: {
          url: hosted.url,
          ...(hosted.expiresAt === undefined
            ? {}
            : { expiresAt: hosted.expiresAt }),
        },
      });
    } catch (error) {
      return commerceError(error);
    }
  }

  private async webhook(request: Request): Promise<Response> {
    try {
      const rawBody = await readWebhookBody(request);
      await this.services().webhooks.process(rawBody, request.headers);
      return json({ received: true });
    } catch (error) {
      if (error instanceof BillingWebhookRejectedError) {
        return json({ error: "Invalid webhook" }, 400);
      }
      if (error instanceof BillingWebhookProcessingError) {
        return json({ error: "Webhook processing unavailable" }, 503, {
          "retry-after": "30",
        });
      }
      return json({ error: "Webhook processing unavailable" }, 503, {
        "retry-after": "30",
      });
    }
  }

  private services(): BillingProviderServices {
    try {
      return this.providerServices();
    } catch {
      throw new BillingProviderUnavailableError(
        "billing provider configuration is unavailable",
      );
    }
  }
}

async function readWebhookBody(request: Request): Promise<ArrayBuffer> {
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new BillingWebhookRejectedError("Billing webhook body is invalid");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new BillingWebhookRejectedError("Billing webhook body is invalid");
    }
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > MAX_WEBHOOK_BYTES) {
      throw new BillingWebhookRejectedError("Billing webhook body is invalid");
    }
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_WEBHOOK_BYTES) {
    throw new BillingWebhookRejectedError("Billing webhook body is invalid");
  }
  return body;
}

function commerceError(error: unknown): Response {
  if (error instanceof RateLimitExceededError) {
    return json({ error: "Too many requests" }, 429, {
      "retry-after": String(error.retryAfterSeconds),
    });
  }
  if (error instanceof BillingProviderUnavailableError) {
    return json({ error: "Billing temporarily unavailable" }, 503);
  }
  if (error instanceof BillingSubscriptionExistsError) {
    return json({ error: "Installation already has a subscription" }, 409);
  }
  const message = error instanceof Error ? error.message : "Billing request failed";
  if (message.includes("authentication required")) {
    return json({ error: "Authentication required" }, 401);
  }
  if (message.includes("passkey authentication is required")) {
    return json({
      error: message.includes("recent")
        ? "Recent passkey authentication is required"
        : "Passkey authentication is required",
    }, 403);
  }
  if (
    message.includes("installation is unavailable")
    || message.includes("subscription is unavailable")
  ) {
    return json({ error: "Not Found" }, 404);
  }
  if (message.includes("idempotency key conflicts")) {
    return json({
      error: "Idempotency key conflicts with an earlier request",
    }, 409);
  }
  if (message.includes("checkout is already in progress")) {
    return json({ error: "Checkout is already in progress" }, 409);
  }
  if (message.includes("checkout session expired")) {
    return json({ error: "Checkout expired; try again" }, 409);
  }
  if (
    message.includes("invalid")
    || message.includes("required")
    || message.includes("cannot select")
  ) {
    return json({ error: message }, 400);
  }
  return json({ error: "Billing request failed" }, 400);
}
