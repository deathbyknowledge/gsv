import { describe, expect, it } from "vitest";
import { billingDeadline, billingState, monthlyPrice } from "./domain";
import type { BillingInstallation } from "./types";

describe("billing presentation", () => {
  it("makes restriction and grace visible without provider vocabulary", () => {
    expect(billingState("past_due")).toEqual({
      label: "PAYMENT DUE",
      tone: "warning",
    });
    expect(billingDeadline(installation("past_due"))).toEqual({
      label: "GRACE ENDS",
      at: 1_800_000_100_000,
    });
  });

  it("formats the configured founding price", () => {
    expect(monthlyPrice(2_000, "usd", "en-US")).toBe("$20.00");
  });
});

function installation(
  state: NonNullable<BillingInstallation["subscription"]>["state"],
): BillingInstallation {
  return {
    installationId: "inst_fixture",
    handle: "hank",
    canonicalOrigin: "https://hank.gsv.space",
    installationState: "active",
    operationState: "complete",
    subscription: {
      planKey: "founding-monthly",
      state,
      currentPeriodEndsAt: 1_800_000_000_000,
      cancelAtPeriodEnd: false,
      paidThrough: null,
      graceEndsAt: 1_800_000_100_000,
      retentionEndsAt: null,
    },
  };
}
