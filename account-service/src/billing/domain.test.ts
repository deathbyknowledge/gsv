import { describe, expect, it } from "vitest";
import { deriveBillingLifecycle, type BillingSubscriptionSnapshot } from "./domain";

const DAY = 24 * 60 * 60_000;
const plan = {
  planKey: "founding-monthly",
  inferenceBudgetMicrounits: 5_000_000,
  storageLimitBytes: 10 * 1024 ** 3,
};
const policy = {
  pastDueGraceMs: 7 * DAY,
  cancelledRetentionMs: 30 * DAY,
};

describe("billing lifecycle policy", () => {
  it("grants active service from an authoritative active snapshot", () => {
    const now = Date.now();
    expect(deriveBillingLifecycle({
      snapshot: snapshot("active", now),
      plan,
      existing: null,
      policy,
      now,
    })).toMatchObject({
      state: "active",
      graceEndsAt: null,
      retentionEndsAt: null,
      entitlement: {
        state: "active",
        planKey: "founding-monthly",
        inferenceBudgetMicrounits: 5_000_000,
      },
    });
  });

  it("holds the original grace deadline across repeated past-due events", () => {
    const now = Date.now();
    const first = deriveBillingLifecycle({
      snapshot: snapshot("past_due", now),
      plan,
      existing: null,
      policy,
      now,
    });
    expect(first.state).toBe("past_due");
    expect(first.graceEndsAt).toBe(now + 7 * DAY);

    const replay = deriveBillingLifecycle({
      snapshot: snapshot("past_due", now + DAY),
      plan,
      existing: {
        providerState: "past_due",
        graceEndsAt: first.graceEndsAt,
        retentionEndsAt: null,
        entitlement: first.entitlement,
      },
      policy,
      now: now + DAY,
    });
    expect(replay.graceEndsAt).toBe(first.graceEndsAt);
    expect(replay.state).toBe("past_due");

    const expired = deriveBillingLifecycle({
      snapshot: snapshot("past_due", now + 7 * DAY),
      plan,
      existing: {
        providerState: "past_due",
        graceEndsAt: first.graceEndsAt,
        retentionEndsAt: null,
        entitlement: replay.entitlement,
      },
      policy,
      now: now + 7 * DAY,
    });
    expect(expired.state).toBe("restricted");
    expect(expired.entitlement?.state).toBe("restricted");
  });

  it("keeps cancelled service active through paid time, then retains data", () => {
    const now = Date.now();
    const cancelled = deriveBillingLifecycle({
      snapshot: snapshot("cancelled", now),
      plan,
      existing: null,
      policy,
      now,
    });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.entitlement?.state).toBe("active");
    expect(cancelled.retentionEndsAt).toBe(now + 31 * DAY);

    const retained = deriveBillingLifecycle({
      snapshot: snapshot("cancelled", now),
      plan,
      existing: {
        providerState: "cancelled",
        graceEndsAt: null,
        retentionEndsAt: cancelled.retentionEndsAt,
        entitlement: cancelled.entitlement,
      },
      policy,
      now: now + DAY,
    });
    expect(retained.state).toBe("retained");
    expect(retained.entitlement?.state).toBe("retained");
    expect(retained.retentionEndsAt).toBe(cancelled.retentionEndsAt);
  });
});

function snapshot(
  state: BillingSubscriptionSnapshot["state"],
  now: number,
): BillingSubscriptionSnapshot {
  return {
    subscriptionId: "provider-subscription",
    customerId: "provider-customer",
    installationId: "inst_billing_test",
    planKey: "founding-monthly",
    state,
    observedAt: now,
    currentPeriodStartsAt: now - DAY,
    currentPeriodEndsAt: now + DAY,
    cancelAtPeriodEnd: state === "cancelled",
  };
}
