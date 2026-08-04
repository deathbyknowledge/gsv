import { describe, expect, it, vi } from "vitest";
import type { AuthAbuseProtection } from "../auth/abuse";
import { ACCOUNT_SESSION_COOKIE } from "../auth/session-cookie";
import type { BillingCommerceService } from "./commerce";
import { BillingHttp } from "./http";
import type { BillingOverviewService } from "./overview";
import {
  BillingWebhookProcessingError,
  BillingWebhookRejectedError,
  type BillingWebhookProcessor,
} from "./webhooks";

const ACCOUNT_ORIGIN = "https://accounts.gsv.space";

describe("billing HTTP boundary", () => {
  it("lists only the authenticated principal's billing-safe installation view", async () => {
    const fixture = httpFixture();
    const response = await fixture.http.handle(new Request(
      `${ACCOUNT_ORIGIN}/api/billing`,
      { headers: { Cookie: `${ACCOUNT_SESSION_COOKIE}=session-token` } },
    ));

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      offer: {
        planKey: "founding-monthly",
        currency: "usd",
        monthlyPriceMinor: 2_000,
      },
      installations: [{
        installationId: "inst_checkout",
        handle: "hank",
        subscription: null,
      }],
    });
    expect(fixture.overview.get).toHaveBeenCalledWith("session-token");
  });

  it("creates a no-store hosted checkout only from the account origin", async () => {
    const fixture = httpFixture();
    const request = browserRequest("checkout", {
      installationId: "inst_checkout",
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    });
    const response = await fixture.http.handle(request);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    await expect(response?.json()).resolves.toEqual({
      session: {
        url: "https://checkout.stripe.test/session",
        expiresAt: 1_900_000_000_000,
      },
    });
    expect(fixture.commerce.checkout).toHaveBeenCalledWith({
      sessionToken: "session-token",
      installationId: "inst_checkout",
      planKey: "founding-monthly",
      idempotencyKey: expect.any(String),
    });

    const sibling = browserRequest("checkout", {
      installationId: "inst_checkout",
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    }, "https://someone.gsv.space");
    expect((await fixture.http.handle(sibling))?.status).toBe(403);
    expect(fixture.commerce.checkout).toHaveBeenCalledTimes(1);
  });

  it("keeps the webhook body byte-exact and does not require browser auth", async () => {
    const fixture = httpFixture();
    const body = "{\"id\":\"evt_exact\",\"spacing\":  true}";
    const request = new Request(
      `${ACCOUNT_ORIGIN}/api/billing/webhooks/stripe`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": "fixture",
        },
        body,
      },
    );
    const response = await fixture.http.handle(request);

    expect(response?.status).toBe(200);
    expect(fixture.webhooks.process).toHaveBeenCalledTimes(1);
    const received = fixture.webhooks.process.mock.calls[0]![0];
    expect(new TextDecoder().decode(received)).toBe(body);
  });

  it("rejects invalid webhooks and asks the provider to retry transient failures", async () => {
    const rejected = httpFixture();
    rejected.webhooks.process.mockRejectedValueOnce(
      new BillingWebhookRejectedError("invalid"),
    );
    const bad = await rejected.http.handle(webhookRequest("{}"));
    expect(bad?.status).toBe(400);

    const failed = httpFixture();
    failed.webhooks.process.mockRejectedValueOnce(
      new BillingWebhookProcessingError("failed"),
    );
    const retry = await failed.http.handle(webhookRequest("{}"));
    expect(retry?.status).toBe(503);
    expect(retry?.headers.get("retry-after")).toBe("30");
  });
});

function httpFixture() {
  const commerce = {
    checkout: vi.fn(async () => ({
      sessionId: "cs_fixture",
      url: "https://checkout.stripe.test/session",
      expiresAt: 1_900_000_000_000,
    })),
    portal: vi.fn(async () => ({
      sessionId: "bps_fixture",
      url: "https://portal.stripe.test/session",
    })),
  };
  const webhooks = {
    process: vi.fn(async (_rawBody: ArrayBuffer, _headers: Headers) => ({
      accepted: true as const,
      outcome: "reconciled" as const,
    })),
  };
  const abuse = { check: vi.fn(async () => undefined) };
  const overview = {
    get: vi.fn(async () => [{
      installationId: "inst_checkout",
      handle: "hank",
      canonicalOrigin: "https://hank.gsv.space",
      installationState: "reserved" as const,
      operationState: "reserved" as const,
      subscription: null,
    }]),
  };
  return {
    commerce,
    overview,
    webhooks,
    http: new BillingHttp(
      overview as unknown as BillingOverviewService,
      () => ({
        commerce: commerce as unknown as BillingCommerceService,
        webhooks: webhooks as unknown as BillingWebhookProcessor,
      }),
      abuse as unknown as AuthAbuseProtection,
      ACCOUNT_ORIGIN,
      {
        planKey: "founding-monthly",
        currency: "usd",
        monthlyPriceMinor: 2_000,
      },
    ),
  };
}

function browserRequest(
  action: "checkout" | "portal",
  body: Record<string, unknown>,
  origin = ACCOUNT_ORIGIN,
): Request {
  return new Request(`${ACCOUNT_ORIGIN}/api/billing/${action}`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: `${ACCOUNT_SESSION_COOKIE}=session-token`,
    },
    body: JSON.stringify(body),
  });
}

function webhookRequest(body: string): Request {
  return new Request(`${ACCOUNT_ORIGIN}/api/billing/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
