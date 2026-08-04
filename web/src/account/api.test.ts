import { describe, expect, it, vi } from "vitest";
import { AccountApi } from "./api";

describe("account billing API", () => {
  it("parses the billing-safe overview and requests same-origin credentials", async () => {
    const request = vi.fn(async () => Response.json({
      offer: {
        planKey: "founding-monthly",
        currency: "usd",
        monthlyPriceMinor: 2_000,
      },
      installations: [{
        installationId: "inst_fixture",
        handle: "hank",
        canonicalOrigin: "https://hank.gsv.space",
        installationState: "past_due",
        operationState: "complete",
        subscription: {
          planKey: "founding-monthly",
          state: "past_due",
          currentPeriodEndsAt: 1_800_000_000_000,
          cancelAtPeriodEnd: false,
          paidThrough: null,
          graceEndsAt: 1_800_100_000_000,
          retentionEndsAt: null,
        },
      }],
    }));

    await expect(new AccountApi(request).billingOverview()).resolves
      .toMatchObject({
        offer: { monthlyPriceMinor: 2_000 },
        installations: [{
          handle: "hank",
          subscription: { state: "past_due" },
        }],
      });
    expect(request).toHaveBeenCalledWith("/api/billing", expect.objectContaining({
      credentials: "same-origin",
    }));
  });

  it("rejects a non-HTTPS hosted billing destination", async () => {
    const api = new AccountApi(vi.fn(async () => Response.json({
      session: { url: "http://checkout.example.test/session" },
    })));
    await expect(api.createBillingCheckout({
      installationId: "inst_fixture",
      planKey: "founding-monthly",
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow("invalid billing destination");
  });
});
